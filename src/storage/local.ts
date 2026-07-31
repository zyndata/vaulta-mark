/**
 * `chrome.storage.local` — the working copy (ARCHITECTURE §5.1).
 *
 * The app reads and writes here; the sync providers are transport (D17). Keeping the two apart is
 * what keeps UI latency off the sync path and gives the merge engine a stable local snapshot to
 * work against.
 *
 * **Nothing in this file may write vault content in the clear (INV-6).** The header is the single
 * documented exception, and only because the KDF parameters are what we need in order to derive the
 * key — they cannot themselves sit behind it. Everything else arrives already sealed, and this
 * module's only contribution is base64url: `chrome.storage.local` JSON-serialises its values, so a
 * `Uint8Array` handed to it comes back as `{"0":12,"1":…}` — five bytes of storage per byte of
 * ciphertext, and a silent shape change on the way back out.
 */

import { fromBase64Url, toBase64Url, type Bytes } from '../crypto/codec.js';
import { CorruptVaultError } from '../crypto/errors.js';
import {
  DEFAULT_SETTINGS,
  DETAIL_WIDTH,
  SIDEBAR_WIDTH,
  VAULT_MAGIC,
  clampPaneWidth,
  isSortKey,
  type BaseMeta,
  type BucketMeta,
  type PaneWidth,
  type VaultHeader,
  type VaultSettings,
} from '../vault/types.js';

/** Every key VaultaMark owns in `storage.local`. Phase 3 writes the first five. */
export const LOCAL_KEYS = {
  meta: 'vm.meta',
  bucketPrefix: 'vm.buckets.',
  base: 'vm.base',
  baseMeta: 'vm.baseMeta',
  settings: 'vm.settings',
  /** Written from Phase 11; listed here so `destroy()` cannot forget them. */
  thumbPrefix: 'vm.thumbs.',
  thumbsLru: 'vm.thumbsLru',
  conflicts: 'vm.conflicts',
  onboarding: 'vm.onboarding',
} as const;

export function bucketKey(index: number): string {
  return `${LOCAL_KEYS.bucketPrefix}${index}`;
}

/* ------------------------------------------------------------------ header */

export async function readHeader(): Promise<VaultHeader | null> {
  const raw = (await area().get(LOCAL_KEYS.meta))[LOCAL_KEYS.meta];
  return raw === undefined ? null : parseHeader(raw);
}

export async function writeHeader(header: VaultHeader): Promise<void> {
  await area().set({ [LOCAL_KEYS.meta]: header });
}

/**
 * Validate a stored header.
 *
 * This is the first thing that runs against bytes we did not just produce, and everything after it
 * trusts the result — so it checks shape rather than assuming it. A **newer** `schemaVersion` is
 * deliberately *not* rejected here: `repo.unlock()` raises `UnsupportedSchemaError` for that, with
 * the version numbers the UI needs to explain itself.
 */
export function parseHeader(raw: unknown): VaultHeader {
  if (raw === null || typeof raw !== 'object') {
    throw new CorruptVaultError('Vault header is not an object.');
  }
  const header = raw as Record<string, unknown>;
  if (header['magic'] !== VAULT_MAGIC) {
    throw new CorruptVaultError('Stored data is not a VaultaMark vault header.');
  }
  for (const field of [
    'schemaVersion',
    'vaultRev',
    'bucketCount',
    'createdAt',
    'updatedAt',
  ] as const) {
    if (typeof header[field] !== 'number' || !Number.isFinite(header[field])) {
      throw new CorruptVaultError(`Vault header is missing a numeric "${field}".`);
    }
  }
  if (typeof header['deviceId'] !== 'string') {
    throw new CorruptVaultError('Vault header is missing a device id.');
  }

  const kdf = header['kdf'];
  if (
    kdf === null ||
    typeof kdf !== 'object' ||
    typeof (kdf as Record<string, unknown>)['alg'] !== 'string' ||
    typeof (kdf as Record<string, unknown>)['iterations'] !== 'number' ||
    typeof (kdf as Record<string, unknown>)['salt'] !== 'string'
  ) {
    throw new CorruptVaultError('Vault header has no usable KDF parameters.');
  }

  const wrapped = header['wrappedDek'];
  if (
    wrapped === null ||
    typeof wrapped !== 'object' ||
    typeof (wrapped as Record<string, unknown>)['iv'] !== 'string' ||
    typeof (wrapped as Record<string, unknown>)['ct'] !== 'string'
  ) {
    throw new CorruptVaultError('Vault header has no usable wrapped data key.');
  }

  const buckets = header['buckets'];
  if (!Array.isArray(buckets)) {
    throw new CorruptVaultError('Vault header has no bucket table.');
  }
  for (const meta of buckets) {
    if (
      meta === null ||
      typeof meta !== 'object' ||
      typeof (meta as BucketMeta).i !== 'number' ||
      typeof (meta as BucketMeta).rev !== 'number' ||
      typeof (meta as BucketMeta).parts !== 'number' ||
      typeof (meta as BucketMeta).tag !== 'string'
    ) {
      throw new CorruptVaultError('Vault header has a malformed bucket entry.');
    }
  }

  // Every field above has been checked individually; the cast records that, and there is no
  // narrowing left for a type predicate to do.
  return raw as VaultHeader;
}

/* ------------------------------------------------------------------ buckets */

/** Read one sealed bucket. `null` means the bucket is empty and was never stored. */
export async function readBucket(index: number): Promise<Bytes | null> {
  const key = bucketKey(index);
  const raw = (await area().get(key))[key];
  if (raw === undefined) return null;
  if (typeof raw !== 'string') {
    throw new CorruptVaultError(`Stored bucket ${index} is not a base64url string.`);
  }
  return fromBase64Url(raw);
}

/** Read several buckets in one call. Missing ones are simply absent from the result. */
export async function readBuckets(indices: Iterable<number>): Promise<Map<number, Bytes>> {
  const wanted = [...indices];
  const stored = await area().get(wanted.map(bucketKey));
  const out = new Map<number, Bytes>();
  for (const index of wanted) {
    const raw = stored[bucketKey(index)];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') {
      throw new CorruptVaultError(`Stored bucket ${index} is not a base64url string.`);
    }
    out.set(index, fromBase64Url(raw));
  }
  return out;
}

/**
 * Write sealed buckets, and delete the ones that became empty, in as few operations as possible.
 *
 * One `set` for the whole batch is not just an optimisation: `chrome.storage` charges write
 * operations against a rate budget on the sync tier, and the local tier shares this code path with
 * it in Phase 7.
 */
export async function writeBuckets(sealed: ReadonlyMap<number, Bytes | null>): Promise<void> {
  const updates: Record<string, string> = {};
  const removals: string[] = [];
  for (const [index, bytes] of sealed) {
    if (bytes === null) removals.push(bucketKey(index));
    else updates[bucketKey(index)] = toBase64Url(bytes);
  }
  if (Object.keys(updates).length > 0) await area().set(updates);
  if (removals.length > 0) await area().remove(removals);
}

/* ------------------------------------------------------------------ merge base (Phase 7) */

export async function readBase(): Promise<Bytes | null> {
  const raw = (await area().get(LOCAL_KEYS.base))[LOCAL_KEYS.base];
  if (raw === undefined) return null;
  if (typeof raw !== 'string') throw new CorruptVaultError('Stored merge base is not base64url.');
  return fromBase64Url(raw);
}

export async function writeBase(sealed: Bytes, meta: BaseMeta): Promise<void> {
  await area().set({ [LOCAL_KEYS.base]: toBase64Url(sealed), [LOCAL_KEYS.baseMeta]: meta });
}

export async function readBaseMeta(): Promise<BaseMeta | null> {
  const raw = (await area().get(LOCAL_KEYS.baseMeta))[LOCAL_KEYS.baseMeta];
  return raw === undefined ? null : (raw as BaseMeta);
}

/* ------------------------------------------------------------------ settings */

/**
 * Settings, with defaults filled in for anything absent or of the wrong type.
 *
 * Never throws: a corrupted settings blob must not be able to keep a user out of their vault. The
 * worst case is a theme reset, and that is a much better failure than a lock screen that will not
 * render.
 */
export async function readSettings(): Promise<VaultSettings> {
  const raw = (await area().get(LOCAL_KEYS.settings))[LOCAL_KEYS.settings];
  if (raw === null || typeof raw !== 'object') return DEFAULT_SETTINGS;
  const stored = raw as Partial<VaultSettings>;
  return {
    theme: pick(stored.theme, DEFAULT_SETTINGS.theme, ['system', 'light', 'dark']),
    // `0` is a legal value and means "never auto-lock" (`IDLE_TIMEOUT_NEVER`); a negative or
    // non-finite one is corruption and falls back to the default.
    idleTimeoutMinutes:
      typeof stored.idleTimeoutMinutes === 'number' &&
      Number.isFinite(stored.idleTimeoutMinutes) &&
      stored.idleTimeoutMinutes >= 0
        ? stored.idleTimeoutMinutes
        : DEFAULT_SETTINGS.idleTimeoutMinutes,
    providerId: pick(stored.providerId, DEFAULT_SETTINGS.providerId, ['chrome', 'drive']),
    lockOnBrowserBlur:
      typeof stored.lockOnBrowserBlur === 'boolean'
        ? stored.lockOnBrowserBlur
        : DEFAULT_SETTINGS.lockOnBrowserBlur,
    stripTrackingParams:
      typeof stored.stripTrackingParams === 'boolean'
        ? stored.stripTrackingParams
        : DEFAULT_SETTINGS.stripTrackingParams,
    reuseIncognitoWindow:
      typeof stored.reuseIncognitoWindow === 'boolean'
        ? stored.reuseIncognitoWindow
        : DEFAULT_SETTINGS.reuseIncognitoWindow,
    sortBy: isSortKey(stored.sortBy) ? stored.sortBy : DEFAULT_SETTINGS.sortBy,
    sidebarWidth: paneWidth(stored.sidebarWidth, SIDEBAR_WIDTH),
    detailWidth: paneWidth(stored.detailWidth, DETAIL_WIDTH),
  };
}

/** A stored column width, clamped — see {@link clampPaneWidth}. Anything else is the default. */
function paneWidth(value: unknown, bounds: PaneWidth): number {
  return typeof value === 'number' ? clampPaneWidth(value, bounds) : bounds.initial;
}

export async function writeSettings(settings: VaultSettings): Promise<void> {
  await area().set({ [LOCAL_KEYS.settings]: settings });
}

/* ------------------------------------------------------------------ housekeeping */

/** Every `vm.` key currently present. */
export async function listVaultKeys(): Promise<string[]> {
  return Object.keys(await area().get(null)).filter((key) => key.startsWith('vm.'));
}

/**
 * Remove everything VaultaMark owns, settings included.
 *
 * Enumerates rather than deleting a fixed list: a key added by a later phase and forgotten here
 * would leave sealed vault content on disk after the user asked for it to be gone, which is the one
 * outcome `destroy()` exists to prevent.
 */
export async function clearVault(): Promise<void> {
  const keys = await listVaultKeys();
  if (keys.length > 0) await area().remove(keys);
}

/** Bytes `storage.local` is charging us for. */
export async function localBytesInUse(): Promise<number> {
  return area().getBytesInUse(null);
}

function pick<T extends string>(value: unknown, fallback: T, allowed: readonly T[]): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Resolved per call rather than captured at module load.
 *
 * The service worker is torn down and restarted constantly (§7), and tests install a fresh mock
 * between cases; a module-scope reference to `chrome.storage.local` would pin whichever object
 * happened to exist when this file was first imported.
 */
function area(): chrome.storage.LocalStorageArea {
  return chrome.storage.local;
}
