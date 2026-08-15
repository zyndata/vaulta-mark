/**
 * The heavy tier: where a thumbnail lives, and for how long (ARCHITECTURE §14.6, §5.1).
 *
 * Two copies, with different jobs. **Drive is the system of record** — it holds every thumbnail the
 * vault has, sealed, for as long as the vault does. **`storage.local` is a cache** — capped at 8 MB,
 * evicted least-recently-viewed first, and rebuildable one request at a time. That split is what
 * makes the cap safe to enforce: dropping a picture from the cache costs a round trip, not data.
 *
 * Everything written here is sealed under `k_thumbs` before it reaches either copy, and it is the
 * *same* sealed bytes that go to both — Drive receives ciphertext it cannot open, exactly as it
 * receives buckets (INV-6). Nothing in this module has a key; the repository lends it seal and open
 * through {@link ThumbCipher} and keeps the key to itself.
 *
 * On the Chrome tier there is no second copy: `capabilities.heavyTier` is false, the provider is not
 * asked, and eviction is genuinely lossy. That is the price of the "keep thumbnails on this device
 * only" opt-in and is why it is an opt-in (§14.4) — the picture is re-capturable from the page, and
 * an item whose bytes are gone renders as favicon-and-title like any other (§14.5).
 */

import type { Bytes } from '../crypto/codec.js';
import {
  deleteThumbs,
  listThumbIds,
  readThumb,
  readThumbsLru,
  thumbBytesInUse,
  writeThumb,
  writeThumbsLru,
} from '../storage/local.js';
import type { ThumbCipher } from '../storage/repo.js';
import type { SyncProvider } from '../sync/provider.js';

/**
 * How much of `storage.local` the picture cache may take (§14.6).
 *
 * 8 MB of the 10 MB an extension gets without `unlimitedStorage`, which leaves 2 MB for the vault
 * itself — comfortably more than the ~100 KB a large light-tier vault occupies. We do not request
 * `unlimitedStorage`: it is a permission whose warning string is about disk usage, asked for in
 * order to cache decorations.
 */
export const THUMB_CACHE_BYTES = 8 * 1024 * 1024;

export interface ThumbStoreDeps {
  readonly cipher: ThumbCipher;
  /** The active provider, or `null` when there is no backend to reach. */
  readonly provider: SyncProvider | null;
  readonly now?: () => number;
}

/** Whether this backend keeps thumbnails at all. `null` and the Chrome tier both answer false. */
export function hasHeavyTier(provider: SyncProvider | null): boolean {
  return provider?.capabilities.heavyTier === true;
}

/**
 * Store a freshly captured thumbnail: seal once, write both copies, then enforce the cap.
 *
 * The push happens **after** the local write and its failure is not fatal. A device that captured a
 * picture and could not reach Drive still has the picture, and the next capture or the next sweep
 * will carry it up; the reverse order would mean an offline capture is a capture thrown away.
 */
export async function saveThumb(
  deps: ThumbStoreDeps,
  itemId: string,
  bytes: Bytes,
): Promise<{ readonly pushed: boolean; readonly sealedBytes: number }> {
  const sealed = await deps.cipher.seal(itemId, bytes);
  await writeThumb(itemId, sealed);
  await touchThumb(deps, itemId);

  let pushed = false;
  if (hasHeavyTier(deps.provider)) {
    try {
      await deps.provider?.putThumb(itemId, sealed);
      pushed = true;
    } catch {
      // Offline, unauthorized, rate-limited. Nothing to report and nobody to report it to: the
      // picture is a decoration and the local copy is already good.
    }
  }

  await evictThumbs();
  // The *sealed* length, because that is what `ThumbMeta.bytes` is for: a quota estimate that costs
  // no decryption (§3.2).
  return { pushed, sealedBytes: sealed.length };
}

/** What a viewer can be shown for one item. */
export type ThumbState =
  /** Bytes in hand. */
  | 'ready'
  /**
   * The item claims a thumbnail, this device does not hold it, and the backend that does cannot be
   * reached from here. The row shows favicon and title with a quiet "preview stored in Drive" note
   * rather than a spinner that never resolves (§14.5).
   */
  | 'remote'
  /** There is no thumbnail, here or anywhere. */
  | 'none';

export interface LoadedThumb {
  readonly state: ThumbState;
  readonly bytes: Bytes | null;
}

/**
 * The plaintext bytes of one thumbnail.
 *
 * Local cache first, and on a miss the provider — which is a network request and therefore happens
 * only for a picture somebody asked to look at. **Nothing here runs while a list is merely being
 * rendered** (INV-4): the caller is a click on an eye icon or a hover that survived its delay.
 */
export async function loadThumb(deps: ThumbStoreDeps, itemId: string): Promise<LoadedThumb> {
  const cached = await readThumb(itemId);
  if (cached !== null) {
    const bytes = await openQuietly(deps, itemId, cached);
    if (bytes !== null) {
      await touchThumb(deps, itemId);
      return { state: 'ready', bytes };
    }
    // Sealed bytes that will not open are bytes from another vault, or a damaged value. Either way
    // this device does not have the picture; drop the value so the miss path can replace it.
    await deleteThumbs([itemId]);
  }

  if (!hasHeavyTier(deps.provider)) return { state: 'remote', bytes: null };

  let fetched: Bytes | null;
  try {
    const raw = (await deps.provider?.getThumb(itemId)) ?? null;
    // Copied into a plain `ArrayBuffer`-backed view: `SyncProvider` answers with a bare
    // `Uint8Array`, which under TS 5.7+ may be backed by a `SharedArrayBuffer` and is therefore not
    // a `BufferSource` the crypto layer will take (`codec.ts`, `Bytes`).
    fetched = raw === null ? null : new Uint8Array(raw);
  } catch {
    return { state: 'remote', bytes: null };
  }
  if (fetched === null) return { state: 'none', bytes: null };

  const bytes = await openQuietly(deps, itemId, fetched);
  if (bytes === null) return { state: 'none', bytes: null };

  await writeThumb(itemId, fetched);
  await touchThumb(deps, itemId);
  await evictThumbs();
  return { state: 'ready', bytes };
}

/**
 * Forget thumbnails for items that are going away.
 *
 * The local copy always goes. The remote copy is best-effort and its failure is swallowed, because
 * the alternative is refusing to delete a bookmark because Drive is unreachable — and the file left
 * behind is one sealed blob in the user's own Drive folder, which the next successful delete for
 * that item, or the user, can clear.
 */
export async function dropThumbs(deps: ThumbStoreDeps, itemIds: readonly string[]): Promise<void> {
  if (itemIds.length === 0) return;
  await deleteThumbs(itemIds);
  if (!hasHeavyTier(deps.provider)) return;
  for (const id of itemIds) {
    try {
      await deps.provider?.deleteThumb(id);
    } catch {
      // See above.
    }
  }
}

/** Record that a picture was looked at. This is the whole of the LRU's input. */
export async function touchThumb(deps: ThumbStoreDeps, itemId: string): Promise<void> {
  const lru = await readThumbsLru();
  lru[itemId] = (deps.now ?? Date.now)();
  await writeThumbsLru(lru);
}

/**
 * Bring the cache back under the cap, oldest view first.
 *
 * A thumbnail with no LRU entry sorts as never-viewed and goes first: the only way to have bytes and
 * no entry is a write that was interrupted between the two, and a picture nobody has looked at is
 * the cheapest thing to lose. Returns what was evicted, for the tests and for nothing else.
 */
export async function evictThumbs(cap: number = THUMB_CACHE_BYTES): Promise<readonly string[]> {
  const ids = await listThumbIds();
  let used = await thumbBytesInUse(ids);
  if (used <= cap) return [];

  const lru = await readThumbsLru();
  const oldestFirst = [...ids].sort((a, b) => (lru[a] ?? 0) - (lru[b] ?? 0));

  const evicted: string[] = [];
  for (const id of oldestFirst) {
    if (used <= cap) break;
    used -= await thumbBytesInUse([id]);
    evicted.push(id);
  }
  // One `remove` for the batch: eviction runs on the write path, and a hundred storage operations
  // where one would do is a hundred chances for the worker to be torn down halfway.
  await deleteThumbs(evicted);
  return evicted;
}

/** Unseal, answering `null` rather than throwing — see {@link loadThumb} for why. */
async function openQuietly(
  deps: ThumbStoreDeps,
  itemId: string,
  sealed: Bytes,
): Promise<Bytes | null> {
  try {
    return await deps.cipher.open(itemId, sealed);
  } catch {
    return null;
  }
}
