/**
 * Where a stored favicon comes from, and the three moments it is allowed to be captured
 * (ARCHITECTURE §10.1).
 *
 * The source is `chrome-extension://<id>/_favicon/`, our own origin, read with `fetch` from the
 * worker. **That is not a network request** — it is a lookup in the favicon database Chrome built
 * while the user was browsing — so INV-4 is untouched, no permission is added, and the E2E route
 * trap stays empty. It is also the only source there will ever be: fetching `https://<site>/
 * favicon.ico`, or parsing `<link rel="icon">` from the extension origin, would send every vaulted
 * domain to its host from the user's own address, which is the traffic this product exists to
 * avoid (D28, INV-4).
 *
 * **`_favicon/` is no longer the only source** (Phase 19, D37). A site the user reaches *only*
 * through the vault is opened in an incognito window, an incognito profile writes no favicon entry,
 * and so `_favicon/` will answer with the globe for that host for ever. For those, the page's own
 * declared icon is fetched **in the page** by the OG injection — never from this origin, which
 * would send every vaulted domain to its host and is what INV-4 forbids. That capture lives in
 * `background/thumbs.ts`, which owns the injection; what lives here is the policy about when it may
 * run and what it is allowed to replace.
 *
 * Three rules this module exists to keep in one place:
 *
 * - **Three moments, and no fourth**: an add, an opportunistic upgrade while a row was being
 *   rendered anyway, and an explicit refresh. No timer, no startup sweep, no fetch for rows nobody
 *   is looking at — the rule §14 imposes on thumbnails, for the same reason. The popup's refresh is
 *   the third of those and reaches this module through `background/thumbs.ts`, because there it
 *   rides on the same injection as the preview.
 * - **Chrome's placeholder is never stored.** Two never-visited hosts get byte-identical globes, so
 *   without the check the vault fills with hundreds of copies of one picture. What the placeholder
 *   *is* gets measured at runtime, against a page URL that can never have an icon.
 * - **Drive tier only.** The heavy tier never touches `chrome.storage.sync` (INV-6), so on the
 *   Chrome tier every function here returns before it fetches anything.
 */

import { toBase64Url, type Bytes } from '../crypto/codec.js';
import type { IconResponse } from '../shared/messages.js';
import type { VaultRepository } from '../storage/repo.js';
import type { SyncProvider } from '../sync/provider.js';
import {
  classifyIcon,
  dropIcons,
  hasIcon,
  iconHost,
  loadIcon,
  saveIcon,
  sweepIcons,
  type IconSource,
  type IconStoreDeps,
} from '../thumbs/favicons.js';
import { hasHeavyTier } from '../thumbs/store.js';
import { isBookmark } from '../vault/types.js';
import {
  forgetIconMiss,
  iconKnownMissing,
  markIconMissing,
  resetIconMisses,
} from './icon-cache.js';
import { activeProvider, capturePageIcon } from './thumbs.js';

/**
 * The size asked of `_favicon/`, which must match `DEFAULT_FAVICON_SIZE` in `ui/favicon.ts`.
 *
 * Not imported from there: `src/ui/` is the layer above this one, and pulling a DOM module into the
 * worker to share a number would be the wrong trade. A unit test asserts the two agree — they have
 * to, because a row asking for 32 and the store keeping 16 would put a blurred icon on every
 * restored device, which is exactly the failure this feature exists to prevent.
 */
export const ICON_SIZE = 32;

/**
 * The page URL used to learn what "Chrome has nothing" looks like.
 *
 * `about:blank` can never have a favicon, so whatever comes back is this browser's placeholder by
 * construction. Measured on 2026-08-21 against the real build: identical bytes to a never-visited
 * `https://` host at 16, 32 and 64 px (§10.1). A `chrome-extension://` URL is *not* usable — it
 * answers with our own icon.
 */
const PLACEHOLDER_PAGE_URL = 'about:blank';

/**
 * The placeholder bytes for this worker's lifetime.
 *
 * Memoised in module scope and nowhere else. MV3 tears the worker down every ~30 seconds, so this
 * is re-learned often — which costs one local cache read, and buys never having to decide whether a
 * stored hash is still true after a Chrome update or a theme change.
 */
let placeholder: Promise<Bytes | null> | null = null;

/** Forget what this worker has learned. Tests only; the worker's own lifetime does it for free. */
export function resetIconState(): void {
  placeholder = null;
  resetIconMisses();
}

/**
 * Capture the icon for a freshly added bookmark.
 *
 * All four add gestures reach this, unlike a thumbnail: `_favicon/` needs no `activeTab` grant, so
 * a URL that arrived from a context menu is as capturable as the page in front of the popup.
 *
 * Never throws and never delays the add. The bookmark is already in the vault by the time this
 * runs; an icon that could not be captured is the ordinary outcome for a site the user has not
 * visited yet, and the opportunistic upgrade will catch it later.
 */
export async function captureOnAdd(repo: VaultRepository, url: string): Promise<IconOutcome> {
  const provider = await activeProvider();
  if (!hasHeavyTier(provider)) return 'off';
  const host = iconHost(url);
  if (host === null) return 'unusable';
  const deps = storeDeps(repo, provider);
  if (await hasIcon(deps, host)) return 'held';
  return await capture(deps, host, url);
}

/**
 * Answer one row's question, and take the one free chance to improve on it.
 *
 * The ordinary case answers `image: null`: Chrome's cache has the icon, and the `<img>` the row
 * already built is showing it. Bytes are sent only when Chrome answered with the globe and this
 * vault holds something better — which is precisely the second-computer case the feature is for.
 *
 * `available: false` is the tier gate, and it is what stops a Chrome-tier profile paying a message
 * per host forever: the page is told once that there are no stored icons here and stops asking.
 */
export async function iconFor(repo: VaultRepository, url: string): Promise<IconResponse> {
  const provider = await activeProvider();
  if (!hasHeavyTier(provider)) return { type: 'ICON', url, image: null, available: false };

  const host = iconHost(url);
  if (host === null) return answer(url, null);

  const deps = storeDeps(repo, provider);
  const fetched = await readFavicon(url);
  if (fetched !== null && classifyIcon(fetched, await placeholderBytes()) === 'store') {
    // Chrome has a real icon: the row is already showing it, so the answer is "nothing better".
    // Storing it here is the opportunistic upgrade — free, because the bytes are in hand, and only
    // when we hold nothing, because a cache changing is not evidence that a site's icon did.
    if (!(await hasIcon(deps, host))) {
      await saveIcon(deps, host, fetched);
      forgetIconMiss(host);
    }
    return answer(url, null);
  }

  if (iconKnownMissing(host)) return answer(url, null);
  const stored = await loadIcon(deps, host);
  if (stored === null) markIconMissing(host);
  return answer(url, stored?.bytes ?? null);
}

/**
 * Work out what this host's icon is now, and write that down — including an absence.
 *
 * A refresh is the user saying "this is what the icon is now", so it is the path that replaces; the
 * alternative is a button that reports nothing and leaves the old picture on screen, which is how
 * the thumbnail refresh was reported as broken (§14.5).
 *
 * **What it is allowed to destroy changed in Phase 19, and that is the defect this exists to
 * avoid.** Until then a Chrome miss dropped the stored icon, deliberately — "including that it is
 * nothing". With page-sourced icons in the store that rule deletes good data every time it runs: a
 * vault-only site is by definition one the regular profile has never visited, so `_favicon/` will
 * answer with the globe for it for ever. So the order is the page, then Chrome, then *keep what we
 * have if the page put it there*:
 *
 * 1. The page, when the active tab is on this bookmark — it is the authority on its own icon, and
 *    `_favicon/` is a cache of what some earlier visit saw. The manager's own tab is never the
 *    bookmark's page, so from there this step is a no-op and step 2 is what runs; the popup reaches
 *    the page half through `background/thumbs.ts` instead, on the preview's injection.
 * 2. Chrome, unchanged: a real answer is stored and returned.
 * 3. Neither: a `chrome`-sourced icon is cleared, which is the original behaviour and the case it
 *    was written for. A **`page`-sourced icon is kept**, because nothing here contradicts it.
 */
export async function refreshIcon(repo: VaultRepository, url: string): Promise<IconResponse> {
  const provider = await activeProvider();
  if (!hasHeavyTier(provider)) return { type: 'ICON', url, image: null, available: false };

  const host = iconHost(url);
  if (host === null) return answer(url, null);

  const deps = storeDeps(repo, provider);

  const fromPage = await capturePageIcon(url, provider);
  if (fromPage !== null) return await keep(deps, url, host, fromPage, 'page');

  const fetched = await readFavicon(url);
  if (fetched !== null && classifyIcon(fetched, await placeholderBytes()) === 'store') {
    return await keep(deps, url, host, fetched, 'chrome');
  }

  const stored = await loadIcon(deps, host);
  if (stored?.source === 'page') return answer(url, stored.bytes);

  await dropIcons(deps, [host]);
  markIconMissing(host);
  return answer(url, null);
}

/** Store one host's icon and answer with it. The tail every capturing path here shares. */
async function keep(
  deps: IconStoreDeps,
  url: string,
  host: string,
  bytes: Bytes,
  source: IconSource,
): Promise<IconResponse> {
  await saveIcon(deps, host, bytes, source);
  forgetIconMiss(host);
  return answer(url, bytes);
}

/**
 * Drop the icons of hosts that are no longer in the vault.
 *
 * Reached from the housekeeping alarm, beside the thumbnail sweep and for the same reason (§14.6):
 * a delete is a tombstone with an undo behind it, and a purge is the point at which the item is
 * really gone. The comparison is over *hosts*, which is a step further than the thumbnail sweep
 * goes — a host leaves the vault when its last bookmark does, and no delete ever mentions one.
 */
export async function sweepOrphans(repo: VaultRepository): Promise<readonly string[]> {
  const provider = await activeProvider();
  const deps = storeDeps(repo, provider);
  const hosts = new Set<string>();
  for (const item of repo.items().values()) {
    if (!isBookmark(item)) continue;
    const host = iconHost(item.url);
    if (host !== null) hosts.add(host);
  }
  return await sweepIcons(deps, hosts);
}

/** What one capture attempt came to. Reported to tests and to nobody else. */
export type IconOutcome = 'stored' | 'placeholder' | 'unreadable' | 'held' | 'off' | 'unusable';

/**
 * Whether, after {@link captureOnAdd}, it is worth asking the page for its own icon (§10.1, D37).
 *
 * Exactly the two outcomes that mean *the tier is on, the host is usable, and we still hold
 * nothing*: Chrome answered with the globe, or would not answer at all. `stored` and `held` are an
 * icon we have — and an upgrade never overwrites. `off` is the Chrome tier, where the heavy tier
 * does not exist. `unusable` is a URL with no host, which has nowhere to file an icon.
 *
 * It lives here rather than at the call site because it is a statement about what these outcomes
 * mean, and they are this module's vocabulary.
 */
export function wantsPageIcon(outcome: IconOutcome): boolean {
  return outcome === 'placeholder' || outcome === 'unreadable';
}

/* ------------------------------------------------------------------ plumbing */

async function capture(deps: IconStoreDeps, host: string, url: string): Promise<IconOutcome> {
  const bytes = await readFavicon(url);
  if (bytes === null) return 'unreadable';
  if (classifyIcon(bytes, await placeholderBytes()) !== 'store') return 'placeholder';
  await saveIcon(deps, host, bytes);
  forgetIconMiss(host);
  return 'stored';
}

/**
 * Read one page's icon out of Chrome's cache.
 *
 * `null` for anything that did not come back as bytes. Every reason for that — a revoked
 * permission, a URL Chrome will not look up, a worker being torn down mid-read — is "no icon", and
 * an icon is a decoration: nothing here is worth failing a caller over.
 */
async function readFavicon(pageUrl: string): Promise<Bytes | null> {
  try {
    const url = new URL(chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', pageUrl);
    url.searchParams.set('size', String(ICON_SIZE));
    const response = await fetch(url.toString());
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function placeholderBytes(): Promise<Bytes | null> {
  placeholder ??= readFavicon(PLACEHOLDER_PAGE_URL);
  return await placeholder;
}

function storeDeps(repo: VaultRepository, provider: SyncProvider | null): IconStoreDeps {
  return { cipher: repo.iconCipher(), provider };
}

function answer(url: string, bytes: Bytes | null): IconResponse {
  return {
    type: 'ICON',
    url,
    image: bytes === null ? null : toBase64Url(bytes),
    available: true,
  };
}
