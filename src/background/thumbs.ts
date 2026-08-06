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

import { fromBase64Url, toBase64Url } from '../crypto/codec.js';
import { sha256 } from '../crypto/hash.js';
import type { CaptureResult } from '../content/og.js';
import type { ThumbResponse } from '../shared/messages.js';
import { listThumbIds, readSettings } from '../storage/local.js';
import type { VaultRepository } from '../storage/repo.js';
import { currentProvider } from '../sync/engine.js';
import type { SyncProvider } from '../sync/provider.js';
import { processThumb } from '../thumbs/process.js';
import {
  dropThumbs,
  hasHeavyTier,
  loadThumb,
  saveThumb,
  type ThumbStoreDeps,
} from '../thumbs/store.js';
import { ThumbRejected, validateCandidate, type RejectReason } from '../thumbs/validate.js';
import { isBookmark, type VaultSettings } from '../vault/types.js';

/** The file `build/mv3-plugin.ts` emits for `src/content/og-capture.ts`. */
export const CAPTURE_FILE = 'og-capture.js';

/** What one capture attempt came to. `'off'` means the tier gate refused before anything ran. */
export type CaptureOutcome = 'stored' | 'metadata-only' | 'off' | RejectReason;

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

/**
 * Capture for `itemId` from the tab the user is on, and record whatever came back.
 *
 * Never throws. The worst outcome is a bookmark with no picture, which is the outcome for most
 * bookmarks and is not worth a single line of user-facing anything.
 */
export async function capture(repo: VaultRepository, itemId: string): Promise<CaptureOutcome> {
  const provider = await activeProvider();
  const settings = await readSettings();
  if (!capturesThumbs(settings, provider)) return 'off';

  const tabId = await activeTabId();
  if (tabId === null) return 'blocked';

  const result = await inject(tabId);
  if (result === null) return 'blocked';

  await recordOgMeta(repo, itemId, result);

  if (result.image === undefined || result.imageUrl === undefined) {
    return result.reason ?? 'no-image';
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
    return 'stored';
  } catch (error) {
    // A refusal is the expected outcome for a large part of the web, and it is the only thing that
    // reaches here — `processThumb` and the validators throw nothing else. Anything that is not a
    // `ThumbRejected` is a bug, and it still must not take the add down with it.
    return error instanceof ThumbRejected ? error.reason : 'blocked';
  }
}

/**
 * Store the card's text, whether or not there was a picture.
 *
 * `og:title` and `og:description` are light-tier data — a few hundred bytes inside the ciphertext —
 * and they are the reason a preview is worth expanding even when the image was refused. Written only
 * when something is actually there, so a page with no card costs no revision.
 */
async function recordOgMeta(
  repo: VaultRepository,
  itemId: string,
  result: CaptureResult,
): Promise<void> {
  if (result.ogTitle === undefined && result.ogDescription === undefined) return;
  const item = repo.getItem(itemId);
  if (item === undefined || !isBookmark(item)) return;
  await repo.apply([
    {
      kind: 'update',
      id: itemId,
      patch: {
        og: {
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
 */
export async function refresh(repo: VaultRepository, itemId: string): Promise<ThumbResponse> {
  const item = repo.getItem(itemId);
  if (item === undefined || !isBookmark(item)) return absent(itemId);

  const tab = await activeTab();
  if (tab === null || !samePage(tab.url ?? '', item.url)) return await get(repo, itemId);

  await capture(repo, itemId);
  return await get(repo, itemId);
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
  const meta = item !== undefined && isBookmark(item) ? item.thumb : undefined;
  if (meta === undefined) return absent(itemId);

  const provider = await activeProvider();
  const loaded = await loadThumb(storeDeps(repo, provider), itemId);
  return {
    type: 'THUMB',
    id: itemId,
    state: loaded.state,
    image: loaded.bytes === null ? null : toBase64Url(loaded.bytes),
    width: meta.w,
    height: meta.h,
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
  return { type: 'THUMB', id: itemId, state: 'none', image: null, width: 0, height: 0 };
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

async function activeTabId(): Promise<number | null> {
  const tab = await activeTab();
  return tab?.id ?? null;
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
async function inject(tabId: number): Promise<CaptureResult | null> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CAPTURE_FILE] });
    const frames = await chrome.scripting.executeScript({ target: { tabId }, func: readCapture });
    const result = frames[0]?.result;
    return isCaptureResult(result) ? result : null;
  } catch {
    // A restricted page, a tab that navigated away, an `activeTab` grant that was never ours.
    return null;
  }
}

/** Evaluated in the page's isolated world. Must not reference anything outside itself. */
function readCapture(): unknown {
  const hook = (globalThis as unknown as Record<string, unknown>)['__vmOgCapture'];
  return typeof hook === 'function' ? (hook as () => unknown)() : null;
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
  for (const key of ['ogTitle', 'ogDescription', 'imageUrl', 'contentType', 'image', 'src', 'reason']) {
    const field = record[key];
    if (field !== undefined && typeof field !== 'string') return false;
  }
  const declared = record['declaredBytes'];
  return declared === undefined || typeof declared === 'number';
}
