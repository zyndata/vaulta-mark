/**
 * `VaultRepository` — the domain API for an encrypted vault on `storage.local`.
 *
 * Everything above this line (the service worker, the popup, the manager) talks to the vault
 * through this object and never sees a key, a bucket, or a byte of ciphertext. Everything below it
 * is pure or byte-level. The interesting parts:
 *
 * - **Unlock decrypts once.** Items live in memory as an `ItemMap` while unlocked, so `getAll()`
 *   and search are synchronous and the UI never waits on crypto to paint a list.
 * - **Writes are dirty-tracked and coalesced.** A mutation marks the buckets its changed items
 *   belong to and returns; 300 ms later — or on the next `flush()` — only those buckets are
 *   re-sealed and written. Typing a note is one write, not one per keystroke.
 * - **Buckets are written before the header, always.** A crash between the two leaves a header
 *   pointing at the previous revision of a bucket that has already been superseded, which the
 *   integrity tag detects; the other order leaves a header pointing at buckets that do not exist.
 * - **Lock forgets everything.** The DEK, the subkeys, the items and the search index all go. What
 *   `lock()` cannot do is prove the bytes are unrecoverable — see `crypto/wipe.ts`.
 *
 * Key custody above this line belongs to `background/session.ts`, which keeps the DEK in
 * `chrome.storage.session` so it survives the service worker being killed every ~30 seconds (D14).
 * This file has no `storage.session` knowledge: it hands the raw key out through `exportDek()` and
 * takes one back through `unlockWithDek()`, and knows nothing about where it was kept in between.
 */

import { fromBase64Url, toBase64Url, type Bytes } from '../crypto/codec.js';
import type { AadPurpose } from '../crypto/envelope.js';
import { CorruptVaultError, UnsupportedSchemaError } from '../crypto/errors.js';
import { RECOMMENDED_KDF_PARAMS, deriveKek, generateKdfSalt } from '../crypto/kdf.js';
import { generateDek, subkey, unwrapDek, wrapDek } from '../crypto/keys.js';
import { MIN_PASSWORD_LENGTH, passwordLength } from '../crypto/password.js';
import { Secret, zero } from '../crypto/wipe.js';
import { VaultLockedError, VaultStateError, WeakPasswordError } from '../vault/errors.js';
import { migrate, needsMigration, type RawPayload } from '../vault/migrate.js';
import { applyMutations, purgeTombstones, toItemMap, type Mutation } from '../vault/model.js';
import {
  buildSearchIndex,
  search,
  type ParsedQuery,
  type SearchHit,
  type SearchIndex,
  type SearchOptions,
} from '../vault/search.js';
import {
  EMPTY_SYNCED_SETTINGS,
  parseSyncedSettings,
  type SyncedSettings,
} from '../vault/settings-sync.js';
import {
  DEFAULT_BUCKET_COUNT,
  SCHEMA_VERSION,
  SETTINGS_BUCKET,
  TOMBSTONE_TTL_MS,
  VAULT_MAGIC,
  isDeleted,
  type BucketMeta,
  type BucketPayload,
  type EncryptedVault,
  type ItemMap,
  type VaultHeader,
  type VaultItem,
} from '../vault/types.js';
import { bucketOf } from './buckets.js';
import {
  bucketTag,
  canonicalJson,
  openBucket,
  openBytes,
  openJson,
  sealBucket,
  sealBytes,
  sealJson,
} from './codec.js';
import { clearVault, readBuckets, readHeader, writeBuckets, writeHeader } from './local.js';
import { partsFor } from './quota.js';

/** How long writes are held back so a burst of edits becomes one write. */
export const WRITE_COALESCE_MS = 300;

export interface VaultRepositoryOptions {
  /** Injected so tests get a deterministic clock. */
  readonly now?: () => number;
  /** Injected so tests get deterministic item ids. */
  readonly newId?: () => string;
  readonly coalesceMs?: number;
}

export interface GetAllOptions {
  /** Include tombstones. Off by default — a deleted bookmark must not appear anywhere in the UI. */
  readonly includeDeleted?: boolean;
}

/**
 * Sealing and opening, bound to an unlocked vault's keys — without handing the keys out.
 *
 * `src/sync/` has to keep two encrypted things of its own beside the buckets: the merge base and
 * the pending conflicts (ARCHITECTURE §5.1). Both are vault content and both must be sealed
 * (INV-6), and neither is a bucket. Rather than growing the repository a method per sync artefact,
 * or exporting the DEK to a second module, the repository lends out this: the two operations, with
 * the key already applied and no way to read it back.
 */
export interface VaultCipher {
  seal(purpose: Exclude<AadPurpose, 'bucket'>, id: string, value: unknown): Promise<Bytes>;
  open(purpose: Exclude<AadPurpose, 'bucket'>, id: string, sealed: Bytes): Promise<unknown>;
}

/**
 * The same lending arrangement as {@link VaultCipher}, for the heavy tier (Phase 11).
 *
 * Separate because it is a **different key**: thumbnails are sealed under `k_thumbs`, so that no
 * weakness in the picture path can be turned into an oracle against the item path (§4.1). And
 * separate because thumbnails are opaque bytes rather than JSON — `sealJson` would gzip a WebP,
 * which spends CPU to make it bigger.
 *
 * The AAD binds the item id, so a thumbnail cannot be served back as another item's picture.
 */
export interface ThumbCipher {
  seal(itemId: string, bytes: Bytes): Promise<Bytes>;
  open(itemId: string, sealed: Bytes): Promise<Bytes>;
}

export class VaultRepository {
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #coalesceMs: number;

  #header: VaultHeader | null = null;
  #dek: Secret<Bytes> | null = null;
  #itemsKey: CryptoKey | null = null;
  #hmacKey: CryptoKey | null = null;
  #thumbsKey: CryptoKey | null = null;

  #items: ItemMap = new Map();
  /** The synced half of the settings (Phase 10). Lives in bucket 0's payload, beside its items. */
  #settings: SyncedSettings = EMPTY_SYNCED_SETTINGS;
  /** Item id → bucket index. Cached because it costs a SHA-256 and never changes for an id. */
  #bucketByItem = new Map<string, number>();
  #dirtyBuckets = new Set<number>();
  #headerDirty = false;
  #index: SearchIndex | null = null;

  #timer: ReturnType<typeof setTimeout> | null = null;
  #flushing: Promise<void> | null = null;
  /** A write that failed on the coalescing timer, re-thrown at the next call the caller awaits. */
  #deferredError: unknown = null;

  /** The tail of the serialised write chain. See {@link VaultRepository.apply}. */
  #writes: Promise<void> = Promise.resolve();

  constructor(options: VaultRepositoryOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#coalesceMs = options.coalesceMs ?? WRITE_COALESCE_MS;
  }

  get locked(): boolean {
    return this.#dek === null;
  }

  /** Whether this profile already holds a vault. Cheap: reads the plaintext header only. */
  async exists(): Promise<boolean> {
    return (await readHeader()) !== null;
  }

  /** The plaintext header. Available only while unlocked, because nothing else needs it. */
  header(): VaultHeader {
    if (this.#header === null) throw new VaultLockedError('reading the vault header');
    return this.#header;
  }

  /* ---------------------------------------------------------------- lifecycle */

  /**
   * Create a vault and leave it unlocked.
   *
   * There is no password verifier and no recovery (D12): the wrapped DEK *is* the check, and
   * nothing stored here could be used to recover the password later even if we wanted it to be.
   */
  async create(password: string): Promise<void> {
    this.#throwDeferred();
    if (await this.exists()) {
      throw new VaultStateError('This profile already holds a vault; destroy it before creating.');
    }
    assertPasswordLength(password);

    const salt = generateKdfSalt();
    const kek = await deriveKek(password, salt, RECOMMENDED_KDF_PARAMS);
    const dek = generateDek();
    const wrappedDek = await wrapDek(kek, dek);

    await this.#adoptKeys(dek);
    const now = this.#now();
    const emptyTag = await bucketTag(this.#requireHmacKey(), { items: [] });

    this.#header = {
      magic: VAULT_MAGIC,
      schemaVersion: SCHEMA_VERSION,
      kdf: { ...RECOMMENDED_KDF_PARAMS, salt: toBase64Url(salt) },
      wrappedDek,
      vaultRev: 1,
      bucketCount: DEFAULT_BUCKET_COUNT,
      buckets: emptyBucketTable(DEFAULT_BUCKET_COUNT, 1, emptyTag),
      createdAt: now,
      updatedAt: now,
      // Not `#newId`: that is the *item* id source, and drawing from it here would shift every
      // subsequent item id by one — invisible in production, and a trap in any test that injects
      // a deterministic generator. A device label never needs to be reproducible.
      deviceId: crypto.randomUUID(),
    };
    this.#items = new Map();
    this.#bucketByItem = new Map();
    this.#settings = EMPTY_SYNCED_SETTINGS;
    this.#index = null;

    // No buckets are stored for an empty vault: `parts: 0` in the header says so, and writing
    // sixteen sealed empty payloads would cost ~7 KB of a 100 KB sync quota to say nothing.
    await writeHeader(this.#header);
  }

  /**
   * Unlock with the master password and decrypt every bucket into memory.
   *
   * A wrong password surfaces as `WrongPasswordError` from `unwrapDek`; damaged bytes surface as
   * `CorruptVaultError`; a vault from a newer build surfaces as `UnsupportedSchemaError` *before*
   * any key is derived, so the user is told to update rather than told their password is wrong.
   */
  async unlock(password: string): Promise<void> {
    this.#throwDeferred();
    const header = await this.#readUnlockableHeader();
    const kek = await deriveKek(password, fromBase64Url(header.kdf.salt), {
      alg: header.kdf.alg,
      iterations: header.kdf.iterations,
    });
    const dek = await unwrapDek(kek, header.wrappedDek);
    await this.#open(header, dek);
  }

  /**
   * Take on a vault that arrived from a provider, on a device that has none of its own.
   *
   * This is how a second computer joins an existing vault. Everything needed is already in the
   * header the other device pushed — the KDF salt and the wrapped DEK — so the master password is
   * enough, and nothing has to be exported, copied or typed in by hand.
   *
   * **Nothing is written until the password is proven.** The KEK is derived and the DEK unwrapped
   * from the *pulled* header, in memory; a wrong password throws `WrongPasswordError` here and
   * leaves the profile exactly as empty as it was. Writing the header first and validating second
   * would leave a half-adopted vault behind every mistyped password.
   *
   * The `deviceId` is deliberately **fresh** rather than inherited. It is the one header field that
   * describes the install rather than the vault, and two devices claiming to be the same one would
   * mislabel every side of every future conflict.
   */
  async adopt(vault: EncryptedVault, password: string): Promise<void> {
    this.#throwDeferred();
    if (await this.exists()) {
      throw new VaultStateError('This profile already holds a vault; it cannot adopt another.');
    }
    await this.#adoptFrom(vault, password, { over: false });
  }

  /**
   * The same, **over** a vault this profile already holds. The other one is erased.
   *
   * The situation this exists for is "two vaults, one sync area", from the side the guard on
   * {@link adopt} cannot help with: a profile that holds its own vault and finds a *different* one
   * where it syncs. That is a question with two right answers — keep this one and take the sync area
   * over (`replaceRemoteVault`), or keep the synced one and join it — and until this landed only the
   * first had an implementation. The second is also the only thing a profile whose vault was lost
   * with its `storage.local` can do: same password typed again produces a new random DEK, so the
   * bytes on the other side stay unreadable no matter how many times the merge is retried.
   *
   * **Ordering is the whole of the safety here**, and it is the same rule as {@link adopt}'s, one
   * step further: the KEK is derived, the DEK unwrapped and *every bucket decrypted* before a single
   * byte of the existing vault is removed. A wrong password, a truncated pull or a tag that does not
   * verify all throw with the profile untouched, which is what makes this recoverable — the caller's
   * session record still holds the old DEK and the old vault reopens from it.
   *
   * The erase itself is `clearVault()`, not a bucket-by-bucket overwrite: the two vaults have
   * different bucket tables, and writing the new one over the old would leave the old vault's
   * surplus buckets on disk as unreadable sealed content nothing would ever collect. It also takes
   * `vm.base`, `vm.conflicts` and the rollback with it, all of which describe the vault that is
   * going. Everything the *connection* needs — the Drive file ids — is the caller's to put back,
   * because this layer does not know a provider exists.
   */
  async adoptOver(vault: EncryptedVault, password: string): Promise<void> {
    this.#throwDeferred();
    await this.#adoptFrom(vault, password, { over: true });
  }

  async #adoptFrom(
    vault: EncryptedVault,
    password: string,
    options: { readonly over: boolean },
  ): Promise<void> {
    if (vault.header.schemaVersion > SCHEMA_VERSION) {
      throw new UnsupportedSchemaError(vault.header.schemaVersion, SCHEMA_VERSION);
    }

    const kek = await deriveKek(password, fromBase64Url(vault.header.kdf.salt), {
      alg: vault.header.kdf.alg,
      iterations: vault.header.kdf.iterations,
    });
    const dek = await unwrapDek(kek, vault.header.wrappedDek);
    await this.#adoptKeys(dek);

    // Decrypted before anything is committed, so a vault we cannot read does not become a vault we
    // half-own. `deviceId` is replaced by `replaceAll`, which preserves whatever this header holds.
    //
    // `openVault` rather than `openEncrypted`: the synced settings ride in the same ciphertext, and
    // a second computer that joined a vault and then started from the default theme, the default
    // idle timeout and the default sort order is the thing this record exists to prevent.
    const { items, settings } = await this.openVault(vault);

    if (options.over) {
      // Past this line the old vault is gone, so it must not still have a write in flight: the
      // coalescer holds edits for 300 ms, and one landing after the erase would put a bucket of the
      // erased vault back beside the adopted header, under a key that cannot open it.
      this.#cancelTimer();
      this.#dirtyBuckets.clear();
      this.#headerDirty = false;
      await clearVault();
    }

    this.#header = { ...vault.header, deviceId: crypto.randomUUID() };
    await this.replaceAll(items, vault.header, settings);
  }

  /**
   * Unlock from a DEK that is already in hand, skipping the KDF entirely.
   *
   * This is how an MV3 service worker survives being killed (ARCHITECTURE §7): the unlocked DEK
   * lives in `chrome.storage.session`, and a restarted worker rebuilds the repository from it
   * rather than asking for the master password every thirty seconds. There is deliberately no
   * password check — there is nothing to check against, and possession of the DEK *is* the
   * authorization. It reaches here only from a `storage.session` entry this extension wrote after
   * a real unlock, in a storage area that is memory-backed and restricted to trusted contexts.
   *
   * The bytes are copied: the caller keeps ownership of its buffer and is expected to zero it.
   */
  async unlockWithDek(dek: Bytes): Promise<void> {
    this.#throwDeferred();
    const header = await this.#readUnlockableHeader();
    await this.#open(header, new Uint8Array(dek));
  }

  /**
   * A copy of the raw DEK, for `chrome.storage.session` custody (D14).
   *
   * A copy rather than the live buffer, so a caller zeroing what it was given cannot pull the key
   * out from under a repository that is still using it. The DEK is raw bytes rather than a
   * `CryptoKey` precisely because it has to survive in `storage.session`, which a `CryptoKey` does
   * not serialise into (ARCHITECTURE §4.1).
   */
  exportDek(): Bytes {
    const dek = this.#dek;
    if (dek === null) throw new VaultLockedError('exporting the data key');
    return new Uint8Array(dek.value);
  }

  async #readUnlockableHeader(): Promise<VaultHeader> {
    const header = await readHeader();
    if (header === null) {
      throw new VaultStateError('There is no vault on this profile to unlock.');
    }
    if (header.schemaVersion > SCHEMA_VERSION) {
      throw new UnsupportedSchemaError(header.schemaVersion, SCHEMA_VERSION);
    }
    return header;
  }

  /** Adopt a DEK and decrypt every stored bucket into memory. Takes ownership of `dek`. */
  async #open(header: VaultHeader, dek: Bytes): Promise<void> {
    await this.#adoptKeys(dek);

    const stored = header.buckets.filter((meta) => meta.parts > 0).map((meta) => meta.i);
    const sealed = await readBuckets(stored);
    const raw: Record<string, unknown>[] = [];
    this.#settings = EMPTY_SYNCED_SETTINGS;
    for (const meta of header.buckets) {
      if (meta.parts === 0) continue;
      const bytes = sealed.get(meta.i);
      if (bytes === undefined) {
        throw new CorruptVaultError(`Vault header lists bucket ${meta.i}, which is not stored.`);
      }
      const payload = await openBucket(
        this.#requireItemsKey(),
        this.#requireHmacKey(),
        meta.i,
        bytes,
        meta.tag,
      );
      raw.push(...payload.items);
      if (meta.i === SETTINGS_BUCKET) this.#settings = settingsIn(payload);
    }

    const migrated = migrate({ items: raw }, header.schemaVersion);
    this.#items = toItemMap(migrated.items);
    this.#bucketByItem = new Map();
    for (const item of this.#items.values()) {
      this.#bucketByItem.set(item.id, await bucketOf(item.id, header.bucketCount));
    }
    this.#index = null;

    if (needsMigration(header.schemaVersion)) {
      // Migrated in memory; written back on the next commit rather than now, so opening a vault
      // read-only never rewrites it (§3.3).
      this.#header = { ...header, schemaVersion: SCHEMA_VERSION };
      for (let i = 0; i < header.bucketCount; i++) this.#dirtyBuckets.add(i);
      this.#headerDirty = true;
    } else {
      this.#header = header;
    }
  }

  /**
   * Forget every secret.
   *
   * Pending writes are flushed first by default, because losing the last thing a user typed to a
   * lock timer is a bug, not a security feature. Panic-lock (Phase 4) passes `flush: false`: there,
   * being immediate is the whole point.
   */
  async lock(options: { readonly flush?: boolean } = {}): Promise<void> {
    if (options.flush !== false && !this.locked) {
      try {
        await this.flush();
      } catch (error) {
        this.#deferredError = error;
      }
    }
    this.#cancelTimer();
    this.#dek?.dispose();
    this.#dek = null;
    this.#itemsKey = null;
    this.#hmacKey = null;
    this.#thumbsKey = null;
    this.#header = null;
    this.#items = new Map();
    this.#bucketByItem = new Map();
    this.#settings = EMPTY_SYNCED_SETTINGS;
    this.#dirtyBuckets.clear();
    this.#headerDirty = false;
    this.#index = null;
  }

  /** Lock, then remove every trace of the vault from this profile. Irreversible, by design. */
  async destroy(): Promise<void> {
    await this.lock({ flush: false });
    this.#deferredError = null;
    await clearVault();
  }

  /* ---------------------------------------------------------------- reads */

  /** Every item, tombstones excluded. Synchronous: the vault is already decrypted in memory. */
  getAll(options: GetAllOptions = {}): VaultItem[] {
    this.#assertUnlocked('reading items');
    const all = [...this.#items.values()];
    return options.includeDeleted === true ? all : all.filter((item) => !isDeleted(item));
  }

  getItem(id: string): VaultItem | undefined {
    this.#assertUnlocked('reading an item');
    return this.#items.get(id);
  }

  /** The item map, for the pure functions in `vault/model.ts`. */
  items(): ItemMap {
    this.#assertUnlocked('reading items');
    return this.#items;
  }

  /**
   * Search the unlocked vault. The index is built on first use and dropped on any change.
   *
   * Takes an already-parsed query as well as a string, so a caller that needs the parse for
   * something else — the manager highlights the terms it searched for — does not have to parse
   * twice and risk the two parses disagreeing.
   */
  search(query: string | ParsedQuery, options?: SearchOptions): SearchHit[] {
    this.#assertUnlocked('searching');
    this.#index ??= buildSearchIndex(this.#items.values());
    return search(this.#index, query, options);
  }

  /* ---------------------------------------------------------------- writes */

  /**
   * Apply a batch of mutations as one revision.
   *
   * The whole batch commits at a single `vaultRev`, so a multi-item operation (a bulk move, an
   * import) is one revision to merge rather than a hundred. Returns the items that actually
   * changed — an edit that changes nothing returns an empty array and costs nothing.
   *
   * **Calls are serialised** (Phase 12). The body below reads `#header.vaultRev`, computes the new
   * item set from `#items`, and only then `await`s — `bucketOf` is HMAC and therefore async. Two
   * overlapping calls would both read the *old* `vaultRev` and commit two different item sets at
   * the same revision, which is a lost update with a revision number that says nothing happened.
   *
   * That is reachable in the field, not only under a test that provokes it: `chrome.runtime
   * .onMessage` delivers the next message without waiting for the previous handler's promise, so a
   * keyboard-command add while the popup is adding, or two manager windows, is all it takes.
   */
  async apply(mutations: readonly Mutation[]): Promise<readonly VaultItem[]> {
    // The chain never rejects — a failed mutation must not wedge every later one — while the
    // promise handed to *this* caller still does.
    const run = this.#writes.then(async () => await this.#applyNow(mutations));
    this.#writes = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  async #applyNow(mutations: readonly Mutation[]): Promise<readonly VaultItem[]> {
    this.#throwDeferred();
    this.#assertUnlocked('applying mutations');
    const header = this.#header;
    if (header === null) throw new VaultLockedError('applying mutations');

    const now = this.#now();
    const rev = header.vaultRev + 1;
    const result = applyMutations(this.#items, mutations, { now, rev, newId: this.#newId });
    if (result.changed.length === 0) return [];

    this.#items = result.items;
    for (const item of result.changed) {
      const index =
        this.#bucketByItem.get(item.id) ?? (await bucketOf(item.id, header.bucketCount));
      this.#bucketByItem.set(item.id, index);
      this.#dirtyBuckets.add(index);
    }

    this.#header = { ...header, vaultRev: rev, updatedAt: now };
    this.#headerDirty = true;
    this.#index = null;
    this.#scheduleFlush();
    return result.changed;
  }

  /**
   * Drop tombstones past the 90-day TTL (D20).
   *
   * Not automatic on unlock: purging is a write, and a read-only unlock should not rewrite the
   * vault. The service worker calls this from a housekeeping alarm (Phase 4).
   */
  async purge(ttlMs: number = TOMBSTONE_TTL_MS): Promise<readonly string[]> {
    this.#throwDeferred();
    this.#assertUnlocked('purging tombstones');
    const header = this.#header;
    if (header === null) throw new VaultLockedError('purging tombstones');

    const { items, purged } = purgeTombstones(this.#items, this.#now(), ttlMs);
    if (purged.length === 0) return [];

    this.#items = items;
    for (const id of purged) {
      const index = this.#bucketByItem.get(id);
      if (index !== undefined) this.#dirtyBuckets.add(index);
      this.#bucketByItem.delete(id);
    }
    this.#header = { ...header, vaultRev: header.vaultRev + 1, updatedAt: this.#now() };
    this.#headerDirty = true;
    this.#index = null;
    // Written immediately rather than coalesced: a purge runs from a housekeeping alarm, and an
    // MV3 service worker that is torn down 300 ms later would lose it silently.
    await this.flush();
    return purged;
  }

  /**
   * Prove that a password is this vault's, changing nothing.
   *
   * Verified against the **stored** wrap rather than against anything in memory: an unlocked session
   * must not be a way to act on the master password without knowing it. Throws `WrongPasswordError`
   * exactly where `unlock` would.
   *
   * Phase 8's export asks for this. Exporting under "my vault password" and being wrong about which
   * password that was produces a backup file nobody can open — and the day that is discovered is the
   * day the vault is already gone.
   */
  async verifyPassword(password: string): Promise<void> {
    this.#assertUnlocked('verifying the master password');
    const header = this.header();
    const kek = await deriveKek(password, fromBase64Url(header.kdf.salt), {
      alg: header.kdf.alg,
      iterations: header.kdf.iterations,
    });
    zero(await unwrapDek(kek, header.wrappedDek));
  }

  /**
   * Re-wrap the DEK under a key derived from a new password.
   *
   * Thirty-two bytes are re-encrypted and nothing else moves: no bucket is touched, no ciphertext
   * changes, no sync storm, and no window in which the vault is half-converted. That is the entire
   * reason for the two-level key hierarchy (ARCHITECTURE §4.1). `vaultRev` still advances, because
   * peers need a reason to pull the new header.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    this.#throwDeferred();
    this.#assertUnlocked('changing the password');
    const header = this.#header;
    const dek = this.#dek;
    if (header === null || dek === null) throw new VaultLockedError('changing the password');
    assertPasswordLength(newPassword);

    await this.verifyPassword(currentPassword);

    const salt = generateKdfSalt();
    const kek = await deriveKek(newPassword, salt, RECOMMENDED_KDF_PARAMS);
    const wrappedDek = await wrapDek(kek, dek.value);

    this.#header = {
      ...header,
      kdf: { ...RECOMMENDED_KDF_PARAMS, salt: toBase64Url(salt) },
      wrappedDek,
      vaultRev: header.vaultRev + 1,
      updatedAt: this.#now(),
    };
    this.#headerDirty = true;
    await this.flush();
  }

  /**
   * Write everything pending, now.
   *
   * Buckets first, header last (§"Things that are easy to get wrong"): a crash between the two must
   * leave a header pointing at the *old* revision, not at half-written buckets.
   */
  async flush(): Promise<void> {
    this.#cancelTimer();
    this.#flushing = (this.#flushing ?? Promise.resolve()).then(
      () => this.#writePending(),
      () => this.#writePending(),
    );
    const flushing = this.#flushing;
    try {
      await flushing;
    } finally {
      if (this.#flushing === flushing) this.#flushing = null;
    }
    this.#throwDeferred();
  }

  /** Bucket indices with unwritten changes. Exposed for tests and for the sync scheduler. */
  dirtyBuckets(): ReadonlySet<number> {
    return this.#dirtyBuckets;
  }

  /* ---------------------------------------------------------------- sync (Phase 7) */

  /**
   * The local working copy as ciphertext: the header, and the sealed bytes already on disk.
   *
   * The bytes are read back rather than re-sealed, so a push sends exactly what `storage.local`
   * holds and the two cannot drift. Callers that need to push a *different* item set — the sync
   * engine does, while a conflict is pending — use {@link sealSnapshot} instead.
   */
  async exportEncrypted(): Promise<EncryptedVault> {
    this.#assertUnlocked('exporting the vault');
    const header = this.header();
    await this.flush();
    const stored = header.buckets.filter((meta) => meta.parts > 0).map((meta) => meta.i);
    return { header: this.header(), buckets: await readBuckets(stored) };
  }

  /**
   * Seal an arbitrary item set at this vault's current revision, writing nothing.
   *
   * Fresh IVs mean the ciphertext differs from what is on disk even for buckets that did not
   * change — which is precisely why the header carries a keyed HMAC over each bucket's *plaintext*.
   * A provider compares tags, not bytes, so re-sealing here does not turn into a full re-upload.
   */
  async sealSnapshot(
    items: ItemMap,
    vaultRev?: number,
    settings: SyncedSettings = this.#settings,
  ): Promise<EncryptedVault> {
    this.#assertUnlocked('sealing a vault snapshot');
    const current = this.header();
    const header: VaultHeader = { ...current, vaultRev: vaultRev ?? current.vaultRev };
    const { sealed, metas } = await this.#sealBuckets(items, header, undefined, settings);

    const buckets = new Map<number, Bytes>();
    for (const [index, bytes] of sealed) {
      if (bytes !== null) buckets.set(index, bytes);
    }
    return {
      header: { ...header, buckets: header.buckets.map((meta) => metas.get(meta.i) ?? meta) },
      buckets,
    };
  }

  /**
   * Decrypt a vault that came off a provider.
   *
   * Every bucket tag is verified, so a remote assembled from parts written by two different pushes
   * is rejected here rather than merged. Nothing local is touched: this answers "what do they
   * have?", and the merge decides what to do about it.
   */
  async openEncrypted(vault: EncryptedVault): Promise<ItemMap> {
    return (await this.openVault(vault)).items;
  }

  /**
   * The same, plus the synced settings record the remote carried.
   *
   * Two entry points rather than one because most callers - an import, an adoption, a verification
   * - want the items and nothing else, and `migrate()` deliberately returns only items: it is the
   * boundary where a decrypted payload becomes typed `VaultItem`s, and widening its return type to
   * carry a preference through would be the wrong shape entirely.
   */
  async openVault(vault: EncryptedVault): Promise<{ items: ItemMap; settings: SyncedSettings }> {
    this.#assertUnlocked('reading a remote vault');
    const raw: Record<string, unknown>[] = [];
    let settings: SyncedSettings = EMPTY_SYNCED_SETTINGS;
    for (const meta of vault.header.buckets) {
      if (meta.parts === 0) continue;
      const bytes = vault.buckets.get(meta.i);
      if (bytes === undefined) {
        throw new CorruptVaultError(`Remote header lists bucket ${meta.i}, which is not present.`);
      }
      const payload = await openBucket(
        this.#requireItemsKey(),
        this.#requireHmacKey(),
        meta.i,
        bytes,
        meta.tag,
      );
      raw.push(...payload.items);
      if (meta.i === SETTINGS_BUCKET) settings = settingsIn(payload);
    }
    return {
      items: toItemMap(migrate({ items: raw }, vault.header.schemaVersion).items),
      settings,
    };
  }

  /* ---------------------------------------------------------------- synced settings */

  /** The record as it stands. Empty on a vault where nothing has ever been changed from a default. */
  syncedSettings(): SyncedSettings {
    this.#assertUnlocked('reading the synced settings');
    return this.#settings;
  }

  /**
   * Replace the record, and commit it.
   *
   * A revision of its own, because peers need a reason to pull it - and one bucket write, because
   * the record lives in bucket 0 and nothing else moved. Returns whether anything actually changed,
   * so a settings screen repaint does not cost a sync.
   */
  async setSyncedSettings(settings: SyncedSettings): Promise<boolean> {
    this.#throwDeferred();
    this.#assertUnlocked('writing the synced settings');
    const header = this.#header;
    if (header === null) throw new VaultLockedError('writing the synced settings');
    if (canonicalJson(this.#settings) === canonicalJson(settings)) return false;

    this.#settings = settings;
    this.#dirtyBuckets.add(SETTINGS_BUCKET);
    this.#header = { ...header, vaultRev: header.vaultRev + 1, updatedAt: this.#now() };
    this.#headerDirty = true;
    // Written immediately rather than coalesced, for the same reason `purge()` is: this arrives
    // from someone changing a setting, not from a burst of keystrokes, and there is nothing for a
    // 300 ms window to save. Leaving a timer behind that an MV3 teardown could swallow would cost
    // the change for nothing.
    await this.flush();
    return true;
  }

  /**
   * Replace the entire item set, and adopt a header from elsewhere.
   *
   * Used after a pull or a merge. `deviceId` is deliberately **not** adopted: it labels this
   * install, and taking the remote's would make every device in a profile claim to be the same one
   * — which is the only thing the field is for (labelling the sides of a conflict). Everything else
   * in the header, `kdf` and `wrappedDek` included, is vault-global and genuinely shared: that is
   * how a password changed on one device reaches the others.
   */
  async replaceAll(items: ItemMap, header: VaultHeader, settings?: SyncedSettings): Promise<void> {
    this.#throwDeferred();
    this.#assertUnlocked('replacing the vault contents');
    const current = this.header();

    if (settings !== undefined) this.#settings = settings;
    this.#items = items;
    this.#bucketByItem = new Map();
    for (const item of items.values()) {
      this.#bucketByItem.set(item.id, await bucketOf(item.id, header.bucketCount));
    }
    this.#index = null;

    this.#header = { ...header, deviceId: current.deviceId, updatedAt: this.#now() };
    for (let i = 0; i < header.bucketCount; i++) this.#dirtyBuckets.add(i);
    this.#headerDirty = true;
    await this.flush();
  }

  /** Seal and open, with this vault's item key applied. See {@link VaultCipher}. */
  cipher(): VaultCipher {
    const key = this.#requireItemsKey();
    return {
      seal: (purpose, id, value) => sealJson(key, purpose, id, value),
      open: (purpose, id, sealed) => openJson(key, purpose, id, sealed),
    };
  }

  /** The same, under `k_thumbs`, for the heavy tier. See {@link ThumbCipher}. */
  thumbCipher(): ThumbCipher {
    const key = this.#thumbsKey;
    if (key === null) throw new VaultLockedError('sealing a thumbnail');
    return {
      seal: (itemId, bytes) => sealBytes(key, 'thumb', itemId, bytes),
      open: (itemId, sealed) => openBytes(key, 'thumb', itemId, sealed),
    };
  }

  /* ---------------------------------------------------------------- internals */

  async #writePending(): Promise<void> {
    const header = this.#header;
    if (header === null || this.#itemsKey === null || this.#hmacKey === null) return;
    if (this.#dirtyBuckets.size === 0 && !this.#headerDirty) return;

    const dirty = [...this.#dirtyBuckets].sort((a, b) => a - b);
    this.#dirtyBuckets.clear();
    this.#headerDirty = false;
    try {
      await this.#writeBucketsAndHeader(header, dirty);
    } catch (error) {
      // A failed write must stay pending: the items are still in memory and correct, and the next
      // flush has to try again rather than leave `storage.local` a revision behind for good.
      for (const index of dirty) this.#dirtyBuckets.add(index);
      this.#headerDirty = true;
      throw error;
    }
  }

  async #writeBucketsAndHeader(header: VaultHeader, dirty: readonly number[]): Promise<void> {
    const { sealed, metas } = await this.#sealBuckets(this.#items, header, dirty);

    if (sealed.size > 0) await writeBuckets(sealed);

    const buckets = header.buckets.map((meta) => metas.get(meta.i) ?? meta);
    const next: VaultHeader = { ...header, buckets };
    this.#header = next;
    await writeHeader(next);
  }

  /**
   * Seal a set of buckets, and compute the header entries that describe them.
   *
   * Shared by the write path (which passes the dirty indices) and by {@link sealSnapshot} (which
   * passes none, meaning all). A bucket that comes out empty is sealed as `null` — an empty bucket
   * is deleted rather than stored, because sixteen sealed empty payloads would spend ~7 KB of a
   * 100 KB sync quota to say nothing.
   */
  async #sealBuckets(
    items: ItemMap,
    header: VaultHeader,
    only?: readonly number[],
    settings: SyncedSettings = this.#settings,
  ): Promise<{ sealed: Map<number, Bytes | null>; metas: Map<number, BucketMeta> }> {
    const itemsKey = this.#requireItemsKey();
    const hmacKey = this.#requireHmacKey();
    const wanted = new Set(
      only ?? Array.from({ length: header.bucketCount }, (_unused, index) => index),
    );

    const grouped = new Map<number, VaultItem[]>();
    for (const index of wanted) grouped.set(index, []);
    for (const item of items.values()) {
      const index =
        this.#bucketByItem.get(item.id) ?? (await bucketOf(item.id, header.bucketCount));
      grouped.get(index)?.push(item);
    }

    const sealed = new Map<number, Bytes | null>();
    const metas = new Map<number, BucketMeta>();
    // Bucket 0 carries the synced settings beside its items (§3.2). An empty record is left out
    // entirely rather than written as `{}`, so a vault where nothing has ever been changed from a
    // default seals byte for byte what it sealed before this field existed.
    const carriesSettings = Object.keys(settings).length > 0;
    for (const [index, bucketItems] of grouped) {
      bucketItems.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const holdsSettings = index === SETTINGS_BUCKET && carriesSettings;
      const payload: BucketPayload = holdsSettings
        ? { items: bucketItems, settings }
        : { items: bucketItems };
      if (bucketItems.length === 0 && !holdsSettings) {
        sealed.set(index, null);
        metas.set(index, {
          i: index,
          rev: header.vaultRev,
          parts: 0,
          tag: await bucketTag(hmacKey, payload),
        });
        continue;
      }
      const { sealed: bytes, tag } = await sealBucket(itemsKey, hmacKey, index, payload);
      sealed.set(index, bytes);
      metas.set(index, { i: index, rev: header.vaultRev, parts: partsFor(bytes.length), tag });
    }
    return { sealed, metas };
  }

  async #adoptKeys(dek: Bytes): Promise<void> {
    this.#dek?.dispose();
    this.#dek = new Secret(dek);
    this.#itemsKey = await subkey(dek, 'items');
    this.#hmacKey = await subkey(dek, 'hmac');
    this.#thumbsKey = await subkey(dek, 'thumbs');
  }

  #scheduleFlush(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush().catch((error: unknown) => {
        this.#deferredError = error;
      });
    }, this.#coalesceMs);
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #throwDeferred(): void {
    const error = this.#deferredError;
    if (error === null) return;
    this.#deferredError = null;
    // Rethrown verbatim: this is a value caught from a write that failed on the coalescing timer,
    // and re-wrapping it would bury the storage error the caller actually needs to see.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw error;
  }

  #assertUnlocked(operation: string): void {
    if (this.locked) throw new VaultLockedError(operation);
  }

  #requireItemsKey(): CryptoKey {
    if (this.#itemsKey === null) throw new VaultLockedError('sealing bucket contents');
    return this.#itemsKey;
  }

  #requireHmacKey(): CryptoKey {
    if (this.#hmacKey === null) throw new VaultLockedError('computing a bucket tag');
    return this.#hmacKey;
  }
}

/**
 * The one hard password rule (ARCHITECTURE §4.6). Everything softer than this — the strength
 * meter, the "are you sure" for a weak-but-legal password — is the UI's job.
 *
 * Counted in code points, so ten emoji are ten characters, exactly as `estimateStrength` counts.
 */
function assertPasswordLength(password: string): void {
  if (passwordLength(password) < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(MIN_PASSWORD_LENGTH);
  }
}

/**
 * The synced settings a decrypted bucket carried, validated.
 *
 * `openBucket` answers with a `RawPayload`, which is deliberately untyped past its items array -
 * everything after it has been through `migrate()`. The settings record has not, so it is parsed
 * here rather than cast.
 */
function settingsIn(payload: RawPayload): SyncedSettings {
  return parseSyncedSettings((payload as { settings?: unknown }).settings);
}

/** A bucket table for a vault with nothing in it: every bucket present, none of them stored. */
function emptyBucketTable(bucketCount: number, rev: number, tag: string): BucketMeta[] {
  return Array.from({ length: bucketCount }, (_unused, i) => ({ i, rev, parts: 0, tag }));
}
