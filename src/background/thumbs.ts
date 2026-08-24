/**
 * Where a thumbnail comes from and where it goes (ARCHITECTURE §14).
 *
 * This is the only module that runs the whole pipeline — inject, validate, process, seal, store,
 * record — and it is deliberately the only one that knows the pipeline exists. `items.ts` asks it to
 * try, and does not care whether it did.
 *
 * Three rules it exists to keep in one place:
 *
 * - **Capture happens at add time, from a tab the user just acted on, and nowhere else.** There is no
 *   timer here, no background sweep, no re-capture on view. The `activeTab` grant that makes the
 *   injection legal is created by the same click that vaulted the page, and it does not outlive it.
 * - **Nothing is injected when nothing would be captured** (§14.4). On the Chrome tier with the
 *   opt-in off, `capture()` returns before it touches `chrome.scripting`. That is asserted by a test,
 *   because "we injected but then threw the result away" is the version of this that looks the same
 *   from the outside and is not the same at all.
 * - **A failure is never an error.** Most of the web has no `og:image`, and most of the rest will not
 *   let a page fetch it. Every path here answers with a reason and lets the caller carry on.
 */

import { fromBase64Url, toBase64Url, type Bytes } from '../crypto/codec.js';
import { sha256 } from '../crypto/hash.js';
import type { CaptureRequest, CaptureResult } from '../content/og.js';
import type { ThumbResponse } from '../shared/messages.js';
import { listThumbIds, readSettings } from '../storage/local.js';
import type { VaultRepository } from '../storage/repo.js';
import { currentProvider } from '../sync/engine.js';
import type { SyncProvider } from '../sync/provider.js';
import { hasIcon, iconHost, saveIcon, type IconStoreDeps } from '../thumbs/favicons.js';
import { processIcon, processThumb } from '../thumbs/process.js';
import {
  dropThumbs,
  hasHeavyTier,
  loadThumb,
  saveThumb,
  type ThumbStoreDeps,
} from '../thumbs/store.js';
import {
  ThumbRejected,
  validateCandidate,
  validateIconCandidate,
  type RejectReason,
} from '../thumbs/validate.js';
import { isBookmark, type VaultSettings } from '../vault/types.js';
import { forgetIconMiss } from './icon-cache.js';

/** The file `build/mv3-plugin.ts` emits for `src/content/og-capture.ts`. */
export const CAPTURE_FILE = 'og-capture.js';

/** What the picture half of one capture came to. `'off'` means the tier gate refused first. */
export type CaptureOutcome = 'stored' | 'metadata-only' | 'off' | RejectReason;

/**
 * What the icon half of one capture came to.
 *
 * Three answers and no error among them, because this is the vocabulary the popup's one notice is
 * written against: `'unavailable'` is the Chrome tier, which keeps no icons at all; `'none'` is a
 * page that offered nothing this vault can keep; `'stored'` is an icon in the store.
 */
export type PageIconOutcome = 'stored' | 'none' | 'unavailable';

/**
 * Both halves of one injection.
 *
 * They are reported together because they *happen* together — one script in the page, one pair of
 * concurrent fetches — and separating them at the boundary would invite a second injection to ask
 * the other half, which is the thing §14.4 exists to prevent.
 */
export interface CaptureReport {
  readonly thumb: CaptureOutcome;
  readonly icon: PageIconOutcome;
}

/**
 * Whether this device captures at all right now (§14.4).
 *
 * Drive captures by default; Chrome sync does not capture unless the user opted into keeping
 * pictures on this device only. A provider that cannot be reached is not a reason to stop: its
 * *capabilities* are a static property of the backend, not something `init()` discovers.
 */
export function capturesThumbs(settings: VaultSettings, provider: SyncProvider | null): boolean {
  return hasHeavyTier(provider) || settings.localThumbnails;
}

/** Whether now is the moment to ask about the opt-in. At most once per profile (§14.4). */
export function offersThumbnails(settings: VaultSettings, provider: SyncProvider | null): boolean {
  return !hasHeavyTier(provider) && !settings.localThumbnails && !settings.thumbnailsOffered;
}

export interface CaptureOptions {
  /**
   * Treat what the page offers now as the whole truth, and clear what it no longer offers.
   *
   * Off for an add, where there is nothing to clear. On for a re-capture, where there is: a page
   * that has lost its `og:image`, or a bookmark pointed at a different address, would otherwise
   * keep the previous page's picture and words — a preview that describes something the bookmark
   * no longer opens, which is worse than no preview at all.
   */
  readonly replace?: boolean;

  /**
   * Ask the page for its own icon, too (§10.1, D37).
   *
   * Off unless the caller knows the vault holds nothing for this host — which on the add path is
   * what `captureOnAdd`'s outcome already says, so nothing re-reads the store to find out. An
   * upgrade never overwrites (§10.1), and the cheapest way to honour that is not to ask.
   *
   * It no longer means "fetch `tab.favIconUrl`". The page chooses which of its declared icons to
   * fetch and rasterises an SVG one on the way out (`content/og.ts`); `favIconUrl` is passed as a
   * hint when Chrome has one, and its absence is no longer a reason not to ask — a site the user
   * only ever opens through the vault is precisely the site Chrome has no icon for.
   */
  readonly wantIcon?: boolean;

  /**
   * Let the page's icon replace one already stored, rather than only fill an absence.
   *
   * On exactly for the explicit refresh, where the user is looking at the page and saying that this
   * is its icon. Off for an add, where {@link wantIcon} was only turned on because the store held
   * nothing — and where a race between two adds for the same host must not overwrite.
   */
  readonly replaceIcon?: boolean;
}

/**
 * Capture for `itemId` from the tab the user is on, and record whatever came back.
 *
 * Never throws. The worst outcome is a bookmark with no picture, which is the outcome for most
 * bookmarks and is not worth a single line of user-facing anything.
 */
export async function capture(
  repo: VaultRepository,
  itemId: string,
  options: CaptureOptions = {},
): Promise<CaptureReport> {
  const provider = await activeProvider();
  const settings = await readSettings();
  // The icon has nowhere to live without a heavy tier, so it is not asked for there — an injection
  // that fetched one to throw it away would be a request made in someone's page for nothing.
  const heavy = hasHeavyTier(provider);
  const wantIcon = options.wantIcon === true && heavy;
  // What the icon half comes to on every path that gives up before the injection.
  const icon: PageIconOutcome = heavy ? 'none' : 'unavailable';
  if (!capturesThumbs(settings, provider)) return { thumb: 'off', icon };

  const tab = await activeTab();
  const tabId = tab?.id ?? null;
  if (tabId === null) return { thumb: 'blocked', icon };

  const hint = wantIcon ? pageIconUrl(tab) : undefined;
  const result = await inject(tabId, {
    ...(wantIcon ? { icon: true } : {}),
    ...(hint === undefined ? {} : { iconUrl: hint }),
  });
  // Nothing was read, so nothing is known — and `replace` clears only what the page contradicts.
  // An injection that never ran contradicts nothing, and must not take a good preview with it.
  if (result === null) return { thumb: 'blocked', icon };

  const replace = options.replace === true;
  await recordOgMeta(repo, itemId, result, replace);

  // Before the thumbnail, deliberately: the picture is the half that usually fails, it fails by
  // throwing, and an icon that arrived on the same trip must not be lost to a refused preview.
  const iconOutcome = await keepPageIcon(repo, provider, itemId, result, options);

  if (result.image === undefined || result.imageUrl === undefined) {
    if (replace) await clearThumb(repo, itemId, provider);
    return { thumb: result.reason ?? 'no-image', icon: iconOutcome };
  }

  try {
    const raw = fromBase64Url(result.image);
    const { contentType } = validateCandidate({
      url: result.imageUrl,
      contentType: result.contentType,
      declaredBytes: result.declaredBytes,
      byteLength: raw.length,
    });
    const thumb = await processThumb(raw, contentType);
    const deps = storeDeps(repo, provider);
    const digest = toBase64Url(await sha256(thumb.bytes));
    const { sealedBytes } = await saveThumb(deps, itemId, thumb.bytes);

    await repo.apply([
      {
        kind: 'update',
        id: itemId,
        patch: {
          thumb: {
            sha256: digest,
            w: thumb.width,
            h: thumb.height,
            bytes: sealedBytes,
            src: result.src ?? 'og',
            at: Date.now(),
          },
        },
      },
    ]);
    await repo.flush();
    return { thumb: 'stored', icon: iconOutcome };
  } catch (error) {
    // A refusal is the expected outcome for a large part of the web, and it is the only thing that
    // reaches here — `processThumb` and the validators throw nothing else. Anything that is not a
    // `ThumbRejected` is a bug, and it still must not take the add down with it.
    if (replace) await clearThumb(repo, itemId, provider);
    const thumb = error instanceof ThumbRejected ? error.reason : 'blocked';
    return { thumb, icon: iconOutcome };
  }
}

/**
 * Store a page-declared icon that arrived on an injection.
 *
 * Whether it may overwrite is the caller's to say and this module's to enforce, and the check that
 * the store is empty is made **here rather than at the call site** — not out of distrust:
 * `wantIcon` is decided before the injection from what `captureOnAdd` just did, and between then
 * and now the page has been visited, fetched from and decoded. `hasIcon` is one `storage.local`
 * read, and it is what keeps §10.1's *an upgrade never overwrites* true even if two adds for the
 * same host race.
 *
 * Never throws. Everything here is a decoration on a bookmark that is already saved.
 */
async function keepPageIcon(
  repo: VaultRepository,
  provider: SyncProvider | null,
  itemId: string,
  result: CaptureResult,
  options: CaptureOptions,
): Promise<PageIconOutcome> {
  if (!hasHeavyTier(provider)) return 'unavailable';
  if (result.icon === undefined) return 'none';
  const item = repo.getItem(itemId);
  if (item === undefined || !isBookmark(item)) return 'none';
  const host = iconHost(item.url);
  if (host === null) return 'none';

  let deps: IconStoreDeps;
  try {
    deps = iconDeps(repo, provider);
  } catch {
    return 'none'; // Locked between the add and here. The bookmark is safe; the icon is re-capturable.
  }
  if (options.replaceIcon !== true && (await hasIcon(deps, host))) return 'stored';

  const bytes = await iconBytesFrom(result);
  if (bytes === null) return 'none';
  await saveIcon(deps, host, bytes, 'page');
  forgetIconMiss(host);
  return 'stored';
}

/**
 * Fetch and process the icon the page declares, from the tab the user is looking at (§10.1, D37).
 *
 * The seam behind *Refresh icon* and the popup's *Use this page's icon*, and the only path that
 * injects for an icon alone. It **does not store**: the two callers have different rules about what
 * they may overwrite, and those rules live with them in `background/favicons.ts`.
 *
 * The tab has to *be* the bookmark's page, checked here rather than trusted — the same reason
 * {@link refresh} checks it. A capture that ran against whatever page happened to be in front would
 * quietly put one site's icon on another site's rows, and an icon is keyed by host, so it would put
 * it on all of them.
 */
export async function capturePageIcon(
  url: string,
  provider: SyncProvider | null,
): Promise<Bytes | null> {
  if (!hasHeavyTier(provider)) return null;

  const tab = await activeTab();
  if (tab?.id === undefined || !samePage(tab.url ?? '', url)) return null;

  // A missing `favIconUrl` is no longer a reason to stop, and that is the whole point: the page
  // this path exists for is the one Chrome has no icon for. The hint is passed when there is one.
  const hint = pageIconUrl(tab);
  // `image: false` so the page is not made to fetch an OG picture this path would discard.
  const result = await inject(tab.id, {
    icon: true,
    image: false,
    ...(hint === undefined ? {} : { iconUrl: hint }),
  });
  if (result === null) return null;
  return await iconBytesFrom(result);
}

/**
 * Validate and process the icon half of a capture, or `null`.
 *
 * The bytes came off a page, so they take §14.2's pipeline whole: the URL must be `https:` and a
 * public DNS name, the type must be on the icon allowlist, and `createImageBitmap` must agree it is
 * an image before anything is stored. A refusal is the ordinary outcome for about a quarter of the
 * web — every SVG favicon lands here — and is not an error anywhere.
 */
async function iconBytesFrom(result: CaptureResult): Promise<Bytes | null> {
  if (result.icon === undefined || result.iconUrl === undefined) return null;
  try {
    const raw = fromBase64Url(result.icon);
    const { contentType } = validateIconCandidate({
      url: result.iconUrl,
      contentType: result.iconContentType,
      declaredBytes: result.iconDeclaredBytes,
      byteLength: raw.length,
    });
    return (await processIcon(raw, contentType)).bytes;
  } catch {
    // `ThumbRejected` is the whole of what reaches here; anything else is a bug and still must not
    // take an add down over a 32-pixel picture.
    return null;
  }
}

/**
 * The icon URL to hand the page as a hint, or `undefined`.
 *
 * `https:` only, and checked here rather than left to the validator, because everything downstream
 * of this point happens **inside somebody's page**. Chrome fills `favIconUrl` with `data:` URLs and
 * `chrome://` addresses often enough that asking the page to fetch one would be routine wasted work
 * in a context that is not ours to waste.
 *
 * A hint and nothing more since the SVG fix: the page reads its own `<link rel="icon">` set and
 * decides, so `undefined` here means "Chrome has no opinion", not "do not look".
 */
function pageIconUrl(tab: chrome.tabs.Tab | null): string | undefined {
  const url = tab?.favIconUrl;
  if (typeof url !== 'string' || url === '') return undefined;
  try {
    // Parsed rather than prefix-matched: `URL` lowercases the scheme, so this also refuses the
    // spellings a string comparison would let through, and it costs nothing at one call per add.
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function iconDeps(repo: VaultRepository, provider: SyncProvider | null): IconStoreDeps {
  return { cipher: repo.iconCipher(), provider };
}

/**
 * Forget the picture for one item: the record inside the vault, and the bytes in both copies.
 *
 * Exported because a picture also stops being true without any capture running — editing a
 * bookmark's URL points it at a different page — and `organize.ts` clears the record in the same
 * batch as the edit, so the bytes are all that is left for this to take.
 */
export async function forgetThumb(repo: VaultRepository, itemId: string): Promise<void> {
  await dropThumbs(storeDeps(repo, await activeProvider()), [itemId]);
}

/**
 * Drop a stale picture, record and bytes.
 *
 * The vault write is skipped when there is no record to remove: a re-capture on the ordinary page
 * with no `og:image` at all must not spend a revision — and therefore a sync push — saying so.
 */
async function clearThumb(
  repo: VaultRepository,
  itemId: string,
  provider: SyncProvider | null,
): Promise<void> {
  const item = repo.getItem(itemId);
  if (item === undefined || !isBookmark(item) || item.thumb === undefined) return;
  await repo.apply([{ kind: 'update', id: itemId, patch: { thumb: null } }]);
  await repo.flush();
  await dropThumbs(storeDeps(repo, provider), [itemId]);
}

/**
 * Store the card's text, whether or not there was a picture.
 *
 * `og:title` and `og:description` are light-tier data — a few hundred bytes inside the ciphertext —
 * and they are the reason a preview is worth expanding even when the image was refused. Written only
 * when something is actually there, so a page with no card costs no revision — unless this is a
 * re-capture, where a page that has stopped publishing a card is exactly the thing that has to be
 * written down, or the card keeps showing the words of a page that is no longer at this address.
 */
async function recordOgMeta(
  repo: VaultRepository,
  itemId: string,
  result: CaptureResult,
  replace: boolean,
): Promise<void> {
  const item = repo.getItem(itemId);
  if (item === undefined || !isBookmark(item)) return;

  const empty = result.ogTitle === undefined && result.ogDescription === undefined;
  if (empty && (!replace || item.og === undefined)) return;

  await repo.apply([
    {
      kind: 'update',
      id: itemId,
      patch: {
        og: empty
          ? null
          : {
              ...(result.ogTitle === undefined ? {} : { title: result.ogTitle }),
              ...(result.ogDescription === undefined ? {} : { description: result.ogDescription }),
            },
      },
    },
  ]);
  // Written through rather than left to the 300 ms coalescer, for the same reason `add.ts` flushes:
  // a capture is the last thing that happens on an add, so it is exactly when MV3 is free to tear
  // this worker down — and a timer that fires after the teardown writes a stale revision into
  // whatever world exists then. The unit suite found this as one test's write landing in the next
  // test's storage.
  await repo.flush();
}

/**
 * Re-capture, from the page in the active tab (§14.5).
 *
 * The tab has to *be* the item's page, and that is checked here rather than trusted: the caller is a
 * popup that believes the two match, and a refresh that ran against whatever page happened to be in
 * front would quietly put one site's picture on another site's bookmark.
 *
 * It **replaces**. A refresh is the user saying "this is what the page shows now", so a page that
 * has lost its card loses the card here too — the alternative is a button that reports "this page
 * offered no preview picture" while leaving the old picture on screen, which reads as the button
 * being broken and is how this was reported.
 */
export async function refresh(repo: VaultRepository, itemId: string): Promise<ThumbResponse> {
  const item = repo.getItem(itemId);
  if (item === undefined || !isBookmark(item)) return absent(itemId);

  const tab = await activeTab();
  if (tab === null || !samePage(tab.url ?? '', item.url)) return await get(repo, itemId);

  /*
   * **The icon comes back on the same injection**, which is why the popup has one button rather
   * than two. Both halves were already one script and one pair of concurrent fetches; asking for
   * them separately meant two injections, two eight-second worst cases, and a second button whose
   * only honest label named the same gesture as the first.
   *
   * `replaceIcon` because this is the explicit refresh: the user is looking at the page and saying
   * that this is what it shows now, the same thing `replace` says about the picture.
   */
  const report = await capture(repo, itemId, { replace: true, wantIcon: true, replaceIcon: true });
  return { ...(await get(repo, itemId)), icon: report.icon };
}

/**
 * The bytes for one item, for a UI that asked to see them.
 *
 * The dimensions come from the item's own `thumb` record rather than from the picture, so a `remote`
 * answer still carries the aspect ratio — which is what lets the row reserve the right box and
 * degrade without a layout shift (§14.5).
 */
export async function get(repo: VaultRepository, itemId: string): Promise<ThumbResponse> {
  const item = repo.getItem(itemId);
  const bookmark = item !== undefined && isBookmark(item) ? item : undefined;
  const meta = bookmark?.thumb;

  /*
   * The card's text is answered whether or not there is a picture, which is why this no longer
   * returns early on a missing `thumb`. `og:title` and `og:description` have been captured since
   * Phase 11 precisely so that a page whose *image* was refused — CSP, a CDN, a `data:` URL we
   * would not follow — still has something worth opening; until this landed nothing ever read them.
   */
  const text = {
    ogTitle: bookmark?.og?.title ?? null,
    ogDescription: bookmark?.og?.description ?? null,
  };

  if (meta === undefined) return { ...absent(itemId), ...text };

  const provider = await activeProvider();
  const loaded = await loadThumb(storeDeps(repo, provider), itemId);
  return {
    type: 'THUMB',
    id: itemId,
    state: loaded.state,
    image: loaded.bytes === null ? null : toBase64Url(loaded.bytes),
    width: meta.w,
    height: meta.h,
    ...text,
  };
}

/**
 * Drop thumbnails whose item is gone (§14.6).
 *
 * Reached from the housekeeping alarm rather than from the delete path, and that is a deliberate
 * reading of "deleting an item deletes its thumbnail": in this codebase a delete is a *tombstone*
 * with an undo behind it, and taking the picture at that moment would make the undo lossy on a
 * device that cannot re-fetch it. A purge is the point at which the item is actually gone.
 *
 * It sweeps by comparison rather than by list, so it also catches the orphans a merge, an import or a
 * rollback leaves behind — none of which passes through the delete path at all.
 */
export async function sweepOrphans(repo: VaultRepository): Promise<readonly string[]> {
  const stored = await listThumbIds();
  if (stored.length === 0) return [];
  const live = repo.items();
  const orphans = stored.filter((id) => !live.has(id));
  if (orphans.length === 0) return [];
  await dropThumbs(storeDeps(repo, await activeProvider()), orphans);
  return orphans;
}

/* ------------------------------------------------------------------ plumbing */

function storeDeps(repo: VaultRepository, provider: SyncProvider | null): ThumbStoreDeps {
  return { cipher: repo.thumbCipher(), provider };
}

function absent(itemId: string): ThumbResponse {
  return {
    type: 'THUMB',
    id: itemId,
    state: 'none',
    image: null,
    width: 0,
    height: 0,
    ogTitle: null,
    ogDescription: null,
  };
}

/**
 * The active provider, or `null`.
 *
 * `init()` reaches the network on the Drive tier, and a picture is not worth failing an add over —
 * so an unreachable backend answers `null`, which reads downstream as "no heavy tier here right
 * now". A capture that is skipped because Drive was offline is a capture the user can repeat.
 */
export async function activeProvider(): Promise<SyncProvider | null> {
  try {
    return await currentProvider();
  } catch {
    return null;
  }
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

/** Same page, ignoring the fragment — a refresh should survive `#section` drift. */
function samePage(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = '';
    right.hash = '';
    return left.href === right.href;
  } catch {
    return false;
  }
}

/**
 * Run the capture script in the page, and read what it produced.
 *
 * **Two injections, and the second one is not redundant.** A `files:` injection reports the
 * completion value of the *program*, and a bundled program is one IIFE expression statement whose
 * value is `undefined` whatever the module did — so the script publishes a function instead, and
 * this tiny `func:` injection is what calls it and gives Chrome something serialisable to hand back.
 * Chrome awaits a returned promise, which is what lets the fetch happen inside the page.
 *
 * The reader is written as a standalone function on purpose: `func` is serialised with `toString`,
 * so anything it closed over would arrive as a `ReferenceError` in the page.
 */
async function inject(tabId: number, request: CaptureRequest): Promise<CaptureResult | null> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CAPTURE_FILE] });
    /*
     * `args` only when there is something to say. A capture with no icon request and the picture
     * wanted is what every caller before Phase 19 made, and it should cross the boundary as the
     * same call it always did — an empty object serialised into the page each time buys nothing.
     */
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      ...(Object.keys(request).length === 0 ? {} : { args: [request] }),
      func: readCapture,
    });
    const result = frames[0]?.result;
    return isCaptureResult(result) ? result : null;
  } catch {
    // A restricted page, a tab that navigated away, an `activeTab` grant that was never ours.
    return null;
  }
}

/** Evaluated in the page's isolated world. Must not reference anything outside itself. */
function readCapture(request?: CaptureRequest): unknown {
  const hook = (globalThis as unknown as Record<string, unknown>)['__vmOgCapture'];
  return typeof hook === 'function' ? (hook as (arg?: CaptureRequest) => unknown)(request) : null;
}

/**
 * Narrow what came back out of a page.
 *
 * Shallow, and that is enough: every field is re-validated downstream by `thumbs/validate.ts`, which
 * is the module that treats all of this as hostile. What this guards is the shape, so a page that
 * overwrote the hook with something returning a number does not reach `fromBase64Url`.
 */
function isCaptureResult(value: unknown): value is CaptureResult {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const strings = [
    'ogTitle',
    'ogDescription',
    'imageUrl',
    'contentType',
    'image',
    'src',
    'reason',
    'iconUrl',
    'icon',
    'iconContentType',
    'iconReason',
  ];
  for (const key of strings) {
    const field = record[key];
    if (field !== undefined && typeof field !== 'string') return false;
  }
  for (const key of ['declaredBytes', 'iconDeclaredBytes']) {
    const field = record[key];
    if (field !== undefined && typeof field !== 'number') return false;
  }
  return true;
}
