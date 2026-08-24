/**
 * Stored favicons: one sealed icon per host, kept so a vault restored on a second computer shows
 * real icons instead of a column of initials (ARCHITECTURE §10.1, issue #6).
 *
 * It is `store.ts` one level of indirection further along, and the indirection is the point.
 *
 * - **Keyed by host, not by item.** Fifty bookmarks on one host share one file. That is what makes
 *   icons about two orders of magnitude cheaper than thumbnails, which are per item because every
 *   page has a different picture.
 * - **The stored name is an HMAC of the host, never the host.** The set of domains is enumerable:
 *   an unkeyed name would let anyone holding the Drive folder hash the top million sites and read
 *   off which files are present — the leak D28 refuses a third-party favicon service over. This
 *   module never writes a host anywhere; it asks {@link IconCipher.name} and files the answer.
 * - **Nothing here has a key**, exactly as `store.ts` has none. The repository lends naming,
 *   sealing and opening, and keeps the key to itself.
 *
 * What this module does *not* do is decide when to capture. Reading `_favicon/` needs `chrome`, so
 * that lives in `background/favicons.ts`, with the three moments it is allowed to happen at.
 */

import type { Bytes } from '../crypto/codec.js';
import { equalBytes } from '../crypto/hash.js';
import {
  deleteIcons,
  iconBytesInUse,
  listIconNames,
  readIcon,
  readIconsLru,
  writeIcon,
  writeIconsLru,
} from '../storage/local.js';
import type { IconCipher } from '../storage/repo.js';
import type { SyncProvider } from '../sync/provider.js';
import { hasHeavyTier } from './store.js';

/**
 * How much of `storage.local` the icon cache may take (§5.1).
 *
 * 1 MB beside the thumbnail cache's 8, and its own cache rather than a share of one: an evicted
 * picture costs one round trip for one item, while an evicted icon costs one for every row on that
 * host — and a vault whose pictures filled a shared cache would leave a restored profile looking
 * exactly as it did before any of this existed. At 1–3 KB an icon this holds a few hundred hosts,
 * which is more than the vault sizes §5.3 calls comfortable.
 */
export const ICON_CACHE_BYTES = 1024 * 1024;

/**
 * The largest response we will keep.
 *
 * A favicon is 1–3 KB. These bytes come from Chrome's own cache rather than from a page, so this is
 * not the hostile-input boundary §14.2 is — it is a bound on how wrong that assumption can be.
 */
export const MAX_ICON_BYTES = 64 * 1024;

/* -------------------------------------------------- where an icon came from (§10.1, D37) */

/**
 * The two sources an icon can have.
 *
 * `chrome` is `_favicon/` — the browser's own database, free to read and stored exactly as returned.
 * `page` is Phase 19's: the bytes the page itself served for `tab.favIconUrl`, fetched in page
 * context and put through `processIcon`. The distinction is not bookkeeping — it decides what a
 * refresh is allowed to destroy, because a Chrome miss is permanent for a site the user only ever
 * opens through the vault.
 */
export type IconSource = 'chrome' | 'page';

/**
 * The frame that carries {@link IconSource} inside the sealed plaintext: `0xF0 'V' 'M' <source>`.
 *
 * **`0xF0` is the whole trick.** No image format this store can hold begins with it — PNG is `0x89`,
 * JPEG `0xFF 0xD8`, GIF `'G'`, BMP `'B'`, WebP `'R'`, ICO and AVIF `0x00` — so a stored blob that
 * does not start with this frame cannot be an ambiguous case. It is an icon written **before Phase
 * 19**, and every one of those is a `_favicon/` response. {@link unframeIcon} reads it as `chrome`
 * and hands back the bytes untouched.
 *
 * That is what makes this free to introduce: nothing already in a vault is invalidated, nothing is
 * re-uploaded on upgrade, and no `SCHEMA_VERSION` is involved — the icon store is not part of the
 * vault format (§10.1).
 *
 * It lives in the plaintext rather than in the AAD because the AAD has to be built *before* the blob
 * opens; a provenance field there would mean sealing under one of two AADs and, at read time,
 * trying both to see which authenticates.
 */
const FRAME_MAGIC = Object.freeze([0xf0, 0x56, 0x4d]); // 0xF0 'V' 'M'

/** The byte that names the source, and the only part of the frame that varies. */
const SOURCE_BYTE: Readonly<Record<IconSource, number>> = { chrome: 0x63, page: 0x70 }; // 'c', 'p'

/** Wrap icon bytes for storage. The inverse of {@link unframeIcon}. */
export function frameIcon(source: IconSource, bytes: Bytes): Bytes {
  const framed = new Uint8Array(FRAME_MAGIC.length + 1 + bytes.length);
  framed.set(FRAME_MAGIC, 0);
  framed[FRAME_MAGIC.length] = SOURCE_BYTE[source];
  framed.set(bytes, FRAME_MAGIC.length + 1);
  return framed;
}

/**
 * Read a stored blob back into its source and its image bytes.
 *
 * An unframed blob — or one carrying a source byte this build does not know — is `chrome` with the
 * bytes as they are. Both are the same judgement: this is an older or stranger writer's icon, it is
 * a cache of something re-capturable, and treating it as the browser's own is the reading that
 * cannot lose anything a refresh would then delete.
 */
export function unframeIcon(stored: Bytes): { readonly source: IconSource; readonly bytes: Bytes } {
  const framed =
    stored.length > FRAME_MAGIC.length &&
    FRAME_MAGIC.every((byte, at) => stored[at] === byte) &&
    stored[FRAME_MAGIC.length] === SOURCE_BYTE.page;
  return framed
    ? { source: 'page', bytes: stored.subarray(FRAME_MAGIC.length + 1) }
    : { source: 'chrome', bytes: unframeChrome(stored) };
}

/** Strip a `chrome` frame if there is one; hand back an unframed blob as it stands. */
function unframeChrome(stored: Bytes): Bytes {
  const framed =
    stored.length > FRAME_MAGIC.length &&
    FRAME_MAGIC.every((byte, at) => stored[at] === byte) &&
    stored[FRAME_MAGIC.length] === SOURCE_BYTE.chrome;
  return framed ? stored.subarray(FRAME_MAGIC.length + 1) : stored;
}

export interface IconStoreDeps {
  readonly cipher: IconCipher;
  /** The active provider, or `null` when there is no backend to reach. */
  readonly provider: SyncProvider | null;
  readonly now?: () => number;
}

/**
 * The host an icon is filed under: the URL's `host`, with a leading `www.` dropped.
 *
 * The same string the row shows under the title (`ui/favicon.ts`, `displayHost`), so one icon
 * serves the rows that look to a reader like they share a site. `null` for anything `URL` will not
 * parse — a bookmark is stored as the user saved it, and one that is not a URL keeps its letter.
 */
export function iconHost(pageUrl: string): string | null {
  try {
    const host = new URL(pageUrl).host.replace(/^www\./u, '');
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/** What a `_favicon/` response is worth keeping as. */
export type IconVerdict = 'store' | 'placeholder' | 'empty' | 'too-large';

/**
 * Judge one `_favicon/` response.
 *
 * **The placeholder check is the one that matters.** Chrome answers for a site it knows nothing
 * about with a generic globe, at HTTP 200 — two never-visited hosts get byte-identical bytes — so
 * without this the vault fills with hundreds of copies of one picture. The comparison is against
 * the bytes this same Chrome returns for a page that can never have an icon, not against a hash
 * committed to this repository: the globe differs per requested size and is free to change with a
 * Chrome version or a theme (§10.1, measured).
 *
 * A `null` placeholder means the calibration itself failed, and then nothing is stored — an unknown
 * globe is a globe we would otherwise store several hundred times.
 */
export function classifyIcon(bytes: Bytes, placeholder: Bytes | null): IconVerdict {
  if (bytes.length === 0) return 'empty';
  if (bytes.length > MAX_ICON_BYTES) return 'too-large';
  if (placeholder === null || equalBytes(bytes, placeholder)) return 'placeholder';
  return 'store';
}

/**
 * Seal one host's icon, write both copies, then bring the cache back under its cap.
 *
 * `source` is stamped into the plaintext by {@link frameIcon} before sealing, so it travels with the
 * bytes to Drive and back and costs no second read to recover.
 */
export async function saveIcon(
  deps: IconStoreDeps,
  host: string,
  bytes: Bytes,
  source: IconSource = 'chrome',
): Promise<{ readonly name: string; readonly pushed: boolean }> {
  const name = await deps.cipher.name(host);
  const sealed = await deps.cipher.seal(name, frameIcon(source, bytes));
  await writeIcon(name, sealed);
  await touchIcon(deps, name);

  let pushed = false;
  if (hasHeavyTier(deps.provider)) {
    try {
      await deps.provider?.putIcon(name, sealed);
      pushed = true;
    } catch {
      // Offline, unauthorized, rate-limited. The local copy is already good and the next capture
      // for this host will carry it up; an icon is not worth reporting a failure over.
    }
  }

  await evictIcons();
  return { name, pushed };
}

/**
 * The plaintext bytes of one host's icon, or `null`.
 *
 * Local cache first, and on a miss the provider — which is a network request, and is the whole
 * point of the feature: on a freshly restored profile the local cache is empty and Drive holds
 * every icon the vault has. It happens for a host whose row is on screen, never for the vault at
 * large (§10.1, "three moments").
 */
export async function loadIcon(deps: IconStoreDeps, host: string): Promise<StoredIcon | null> {
  const name = await deps.cipher.name(host);

  const cached = await readIcon(name);
  if (cached !== null) {
    const bytes = await openQuietly(deps, name, cached);
    if (bytes !== null) {
      await touchIcon(deps, name);
      return unframeIcon(bytes);
    }
    // Sealed bytes that will not open belong to another vault, or to an older schema (§10.1). Drop
    // them so the miss path can replace them; an icon is a cache of something re-capturable.
    await deleteIcons([name]);
  }

  if (!hasHeavyTier(deps.provider)) return null;

  let fetched: Bytes | null;
  try {
    const raw = (await deps.provider?.getIcon(name)) ?? null;
    // Copied into a plain `ArrayBuffer`-backed view for the reason `store.ts` copies: a bare
    // `Uint8Array` from a provider may be `SharedArrayBuffer`-backed, and is then not a
    // `BufferSource` the crypto layer will take.
    fetched = raw === null ? null : new Uint8Array(raw);
  } catch {
    return null;
  }
  if (fetched === null) return null;

  const bytes = await openQuietly(deps, name, fetched);
  if (bytes === null) return null;

  await writeIcon(name, fetched);
  await touchIcon(deps, name);
  await evictIcons();
  return unframeIcon(bytes);
}

/** One stored icon: the image bytes, and where they came from. */
export interface StoredIcon {
  readonly source: IconSource;
  readonly bytes: Bytes;
}

/** Whether this device already holds an icon for a host, without opening it. */
export async function hasIcon(deps: IconStoreDeps, host: string): Promise<boolean> {
  return (await readIcon(await deps.cipher.name(host))) !== null;
}

/** Forget the icons for a set of hosts: the local copy always, the remote one best-effort. */
export async function dropIcons(deps: IconStoreDeps, hosts: readonly string[]): Promise<void> {
  if (hosts.length === 0) return;
  const names = await Promise.all(hosts.map((host) => deps.cipher.name(host)));
  await dropIconsByName(deps, names);
}

/** The same, for names already derived — which is what the sweep has in hand. */
export async function dropIconsByName(
  deps: IconStoreDeps,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;
  await deleteIcons(names);
  if (!hasHeavyTier(deps.provider)) return;
  for (const name of names) {
    try {
      await deps.provider?.deleteIcon(name);
    } catch {
      // Same as a thumbnail: refusing to tidy up because Drive is unreachable would be worse than
      // one sealed blob left behind in the user's own folder.
    }
  }
}

/**
 * Drop the icons of hosts that are no longer in the vault (§10.1, §14.6).
 *
 * By comparison rather than by list, and that is not an optimisation: a **host** leaves the vault
 * when its last bookmark does, and no delete ever mentions a host. The same walk catches what a
 * merge, an import or a rollback left behind.
 */
export async function sweepIcons(
  deps: IconStoreDeps,
  liveHosts: Iterable<string>,
): Promise<readonly string[]> {
  const stored = await listIconNames();
  if (stored.length === 0) return [];
  const live = new Set<string>();
  for (const host of new Set(liveHosts)) live.add(await deps.cipher.name(host));
  const orphans = stored.filter((name) => !live.has(name));
  if (orphans.length === 0) return [];
  await dropIconsByName(deps, orphans);
  return orphans;
}

/** Record that an icon was shown. The whole of the LRU's input. */
export async function touchIcon(deps: IconStoreDeps, name: string): Promise<void> {
  const lru = await readIconsLru();
  lru[name] = (deps.now ?? Date.now)();
  await writeIconsLru(lru);
}

/** Bring the icon cache back under its cap, least-recently-shown first. */
export async function evictIcons(cap: number = ICON_CACHE_BYTES): Promise<readonly string[]> {
  const names = await listIconNames();
  let used = await iconBytesInUse(names);
  if (used <= cap) return [];

  const lru = await readIconsLru();
  const oldestFirst = [...names].sort((a, b) => (lru[a] ?? 0) - (lru[b] ?? 0));

  const evicted: string[] = [];
  for (const name of oldestFirst) {
    if (used <= cap) break;
    used -= await iconBytesInUse([name]);
    evicted.push(name);
  }
  // Local only: Drive is the system of record, which is what makes the cap safe to enforce.
  await deleteIcons(evicted);
  return evicted;
}

async function openQuietly(
  deps: IconStoreDeps,
  name: string,
  sealed: Bytes,
): Promise<Bytes | null> {
  try {
    return await deps.cipher.open(name, sealed);
  } catch {
    return null;
  }
}
