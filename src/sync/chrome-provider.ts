/**
 * `ChromeSyncProvider` — the zero-configuration transport, on `chrome.storage.sync`
 * (ARCHITECTURE §5.2, §6.1).
 *
 * It is the default because it needs nothing from the user: no account to connect, no scope to
 * grant, no OAuth screen. It costs a small, hard ceiling — roughly 600 bookmarks comfortably
 * (§5.3) — and it cannot hold thumbnails at all, which is what `DriveSyncProvider` is for.
 *
 * Four things here are not obvious from the API:
 *
 * - **A value is capped at 8,192 bytes including its key**, so a sealed bucket is split into parts
 *   of at most {@link SYNC_PART_CHARS} base64url characters at `vm.s.b<i>.<p>`. The header lives
 *   alone at `vm.s.meta` and says how many parts each bucket has.
 * - **Only buckets whose contents changed are written.** Every seal uses a fresh IV, so ciphertext
 *   is no guide at all; the header's keyed HMAC tag over the *plaintext* is, and comparing it
 *   against the remote header's tag is what keeps one edited bookmark to one bucket write.
 * - **Buckets go first, the header last.** A push interrupted between the two leaves a remote whose
 *   header still points at the previous revision. The new bucket bytes are unreferenced and are
 *   overwritten by the next push; the alternative ordering leaves a header pointing at bytes that
 *   are not there.
 * - **There is no compare-and-swap.** `storage.sync` cannot offer one. We read the header, verify it
 *   still matches what the caller was working from, write, and read it back — best-effort, and
 *   documented as such. Correctness does not rest on it: the merge engine is idempotent, so a lost
 *   race costs a re-merge rather than a bookmark.
 */

import { fromBase64Url, toBase64Url, utf8, type Bytes } from '../crypto/codec.js';
import { sha256 } from '../crypto/hash.js';
import { canonicalJson } from '../vault/model.js';
import { parseHeader } from '../storage/local.js';
import {
  SYNC_PART_CHARS,
  SYNC_QUOTA_BYTES,
  quotaLevel,
  type QuotaLevel,
} from '../storage/quota.js';
import type { EncryptedVault, VaultHeader } from '../vault/types.js';
import {
  CorruptRemote,
  HeavyTierUnsupported,
  PreconditionFailed,
  QuotaExceeded,
  type ProviderCapabilities,
  type ProviderUsage,
  type RemoteStamp,
  type SyncProvider,
} from './provider.js';
import { WriteBudget } from './rate.js';

/** The header's key in the sync area. The only key `peek()` reads. */
export const SYNC_META_KEY = 'vm.s.meta';

/** Prefix for every bucket part: `vm.s.b<bucketIndex>.<partIndex>`. */
export const SYNC_BUCKET_PREFIX = 'vm.s.b';

export function partKey(bucketIndex: number, part: number): string {
  return `${SYNC_BUCKET_PREFIX}${bucketIndex}.${part}`;
}

export interface ChromeSyncProviderOptions {
  readonly budget?: WriteBudget;
  readonly now?: () => number;
}

export class ChromeSyncProvider implements SyncProvider {
  readonly id = 'chrome' as const;

  readonly capabilities: ProviderCapabilities = {
    heavyTier: false,
    maxLightBytes: SYNC_QUOTA_BYTES,
  };

  readonly #budget: WriteBudget;
  readonly #now: () => number;

  constructor(options: ChromeSyncProviderOptions = {}) {
    this.#budget = options.budget ?? new WriteBudget();
    this.#now = options.now ?? (() => Date.now());
  }

  /** Nothing to set up: `chrome.storage.sync` is there or the profile has sync switched off. */
  init(): Promise<void> {
    return Promise.resolve();
  }

  /** Reads `vm.s.meta` and nothing else — one item, no ciphertext, no decryption. */
  async peek(): Promise<RemoteStamp | null> {
    const header = await this.#readHeader();
    return header === null ? null : await stampOf(header, this.#now());
  }

  async pullLight(): Promise<EncryptedVault | null> {
    const header = await this.#readHeader();
    if (header === null) return null;

    const wanted: string[] = [];
    for (const meta of header.buckets) {
      for (let part = 0; part < meta.parts; part++) wanted.push(partKey(meta.i, part));
    }
    const stored = await area().get(wanted);

    const buckets = new Map<number, Bytes>();
    for (const meta of header.buckets) {
      if (meta.parts === 0) continue;
      let joined = '';
      for (let part = 0; part < meta.parts; part++) {
        const chunk = stored[partKey(meta.i, part)];
        if (typeof chunk !== 'string') {
          // A part the header promises and the area does not have is a torn push, or a device that
          // ran out of quota half way. Either way these are not a vault, and pretending otherwise
          // would decrypt a bucket short of its items and then push the result back as the truth.
          throw new CorruptRemote(`Remote vault is missing part ${part} of bucket ${meta.i}.`);
        }
        joined += chunk;
      }
      buckets.set(meta.i, decodePart(joined, meta.i));
    }
    return { header, buckets };
  }

  /**
   * Write the vault, buckets first.
   *
   * `expect` is the stamp the caller last saw. If the remote has moved past it the push is refused
   * with {@link PreconditionFailed} carrying what is actually there, so the engine can go straight
   * to a merge rather than peek again for something it now knows.
   */
  async pushLight(vault: EncryptedVault, expect: RemoteStamp | null): Promise<RemoteStamp> {
    const current = await this.#readHeader();
    const currentStamp = current === null ? null : await stampOf(current, this.#now());
    if (!sameStamp(currentStamp, expect)) throw new PreconditionFailed(currentStamp);

    const parts = splitIntoParts(vault);
    const changed = changedParts(parts, vault.header, current);
    const obsolete = obsoleteKeys(vault.header, current);

    const headerValue = { ...vault.header };
    const projected =
      itemBytes(SYNC_META_KEY, headerValue) +
      [...parts].reduce((sum, [key, value]) => sum + itemBytes(key, value), 0);
    if (projected > SYNC_QUOTA_BYTES) {
      throw new QuotaExceeded(projected, SYNC_QUOTA_BYTES);
    }

    // One `set` for every changed part, one `remove` for what the vault outgrew, one `set` for the
    // header: Chrome charges the *call*, not the key, so a whole push costs at most three writes
    // out of the hundred a minute buys. Reserved as a unit so a push cannot be half-funded.
    const writes = (changed.size > 0 ? 1 : 0) + (obsolete.length > 0 ? 1 : 0) + 1;
    await this.#budget.spend(writes);

    if (changed.size > 0) await area().set(Object.fromEntries(changed));
    if (obsolete.length > 0) await area().remove(obsolete);
    await area().set({ [SYNC_META_KEY]: headerValue });

    // The verification read `storage.sync` will not do for us. It cannot make the write atomic; it
    // catches the case that matters, which is another device having written between our check and
    // our set — there, the header we read back is not the one we just wrote.
    const written = await this.#readHeader();
    if (written === null || canonicalJson(written) !== canonicalJson(headerValue)) {
      throw new PreconditionFailed(written === null ? null : await stampOf(written, this.#now()));
    }
    return await stampOf(headerValue, this.#now());
  }

  /* -------------------------------------------------------------- the heavy tier, absent */

  /**
   * Thumbnails on the Chrome tier: there are none.
   *
   * `null` rather than a thrown `HeavyTierUnsupported`, because "is there a preview for this item?"
   * has a perfectly good answer here and it is "no". The writes below do throw — a caller that
   * believes it stored a thumbnail and did not is a bug worth surfacing.
   */
  getThumb(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }

  putThumb(): Promise<void> {
    return Promise.reject(new HeavyTierUnsupported('chrome'));
  }

  deleteThumb(): Promise<void> {
    return Promise.reject(new HeavyTierUnsupported('chrome'));
  }

  /** Favicons are heavy tier too (§10.1), and answer on exactly the same terms. */
  getIcon(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }

  putIcon(): Promise<void> {
    return Promise.reject(new HeavyTierUnsupported('chrome'));
  }

  deleteIcon(): Promise<void> {
    return Promise.reject(new HeavyTierUnsupported('chrome'));
  }

  /* -------------------------------------------------------------- housekeeping */

  async usage(): Promise<ProviderUsage> {
    return { usedBytes: await area().getBytesInUse(null), quotaBytes: SYNC_QUOTA_BYTES };
  }

  /** Usage plus the warn/block band the UI shows (§5.3). */
  async quota(): Promise<ProviderUsage & { ratio: number; level: QuotaLevel }> {
    const { usedBytes, quotaBytes } = await this.usage();
    const ratio = usedBytes / quotaBytes;
    return { usedBytes, quotaBytes, ratio, level: quotaLevel(ratio) };
  }

  /**
   * Stop using this transport, and take the vault out of it.
   *
   * Deliberately destructive, unlike a Drive disconnect. `storage.sync` is not somewhere a copy can
   * be left behind: every other device on the profile would keep pulling it, and a vault that two
   * systems of record both claim to own is how a merge loses an edit. Only ever reached from an
   * explicit, explained user action (§6.6).
   */
  async disconnect(): Promise<void> {
    const keys = Object.keys(await area().get(null)).filter((key) => key.startsWith('vm.s.'));
    if (keys.length === 0) return;
    await this.#budget.spend(1);
    await area().remove(keys);
  }

  async #readHeader(): Promise<VaultHeader | null> {
    const raw = (await area().get(SYNC_META_KEY))[SYNC_META_KEY];
    if (raw === undefined) return null;
    try {
      return parseHeader(raw);
    } catch (cause) {
      throw new CorruptRemote('The synced vault header is not readable.', { cause });
    }
  }
}

/* ------------------------------------------------------------------ parts */

/** Every part key the vault needs, with its base64url payload. */
export function splitIntoParts(vault: EncryptedVault): Map<string, string> {
  const parts = new Map<string, string>();
  for (const [index, sealed] of vault.buckets) {
    const encoded = toBase64Url(sealed);
    for (let part = 0, at = 0; at < encoded.length; part++, at += SYNC_PART_CHARS) {
      parts.set(partKey(index, part), encoded.slice(at, at + SYNC_PART_CHARS));
    }
  }
  return parts;
}

/**
 * The parts a push actually has to write.
 *
 * A bucket is skipped when the remote header already reports the same plaintext tag *and* the same
 * part count. The tag is what makes this safe: it is an HMAC over the bucket's canonical plaintext,
 * so equal tags mean the bytes already there decrypt to exactly the items we were about to send —
 * even though our ciphertext for them would be completely different, because every seal draws a
 * fresh IV.
 */
function changedParts(
  parts: ReadonlyMap<string, string>,
  next: VaultHeader,
  current: VaultHeader | null,
): Map<string, string> {
  if (current === null) return new Map(parts);
  const unchanged = new Set<number>();
  const before = new Map(current.buckets.map((meta) => [meta.i, meta]));
  for (const meta of next.buckets) {
    const was = before.get(meta.i);
    if (was?.tag === meta.tag && was.parts === meta.parts) unchanged.add(meta.i);
  }

  const out = new Map<string, string>();
  for (const [key, value] of parts) {
    const index = bucketOfKey(key);
    if (index !== null && unchanged.has(index)) continue;
    out.set(key, value);
  }
  return out;
}

/** Part keys the previous revision used and this one does not: a bucket that shrank or emptied. */
function obsoleteKeys(next: VaultHeader, current: VaultHeader | null): string[] {
  if (current === null) return [];
  const wanted = new Map(next.buckets.map((meta) => [meta.i, meta.parts]));
  const stale: string[] = [];
  for (const meta of current.buckets) {
    const keep = wanted.get(meta.i) ?? 0;
    for (let part = keep; part < meta.parts; part++) stale.push(partKey(meta.i, part));
  }
  return stale;
}

function bucketOfKey(key: string): number | null {
  const match = /^vm\.s\.b(\d+)\.\d+$/u.exec(key);
  const index = match?.[1];
  return index === undefined ? null : Number(index);
}

function decodePart(joined: string, index: number): Bytes {
  try {
    return fromBase64Url(joined);
  } catch (cause) {
    throw new CorruptRemote(`Remote bucket ${index} is not base64url.`, { cause });
  }
}

/* ------------------------------------------------------------------ stamps and bytes */

/**
 * A stamp for a header.
 *
 * `contentHash` is a SHA-256 over the header's canonical JSON, which already carries every bucket's
 * tag — so two headers hashing the same means the whole vault is the same, without reading a byte
 * of ciphertext.
 */
export async function stampOf(header: VaultHeader, modifiedAt: number): Promise<RemoteStamp> {
  const digest = await sha256(utf8(canonicalJson(header)));
  return { vaultRev: header.vaultRev, contentHash: toBase64Url(digest), modifiedAt };
}

function sameStamp(a: RemoteStamp | null, b: RemoteStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.vaultRev === b.vaultRev && a.contentHash === b.contentHash;
}

/** What Chrome charges for one item: the key name plus the JSON encoding of the value. */
function itemBytes(key: string, value: unknown): number {
  return key.length + JSON.stringify(value).length;
}

/**
 * Resolved per call rather than captured at module load: the service worker is torn down
 * constantly, and tests install a fresh mock between cases.
 */
function area(): chrome.storage.SyncStorageArea {
  return chrome.storage.sync;
}
