/**
 * The vault operations a UI asks for: add, list, open, delete, undo.
 *
 * The layer between the message router and the pure pipelines. `add.ts` and `incognito.ts` take
 * their inputs as arguments and can be tested without a session; this file is where those meet the
 * unlocked repository, the settings, and the "the user did something" clock.
 *
 * Two rules it exists to keep in one place:
 *
 * - **Every operation goes through `session.currentRepository()`**, which enforces `unlockedUntil`
 *   before it hands anything back. There is no path here that can read an item on an expired
 *   session, because there is no other way in.
 * - **Every operation is a user action.** Each one touches the idle window, so browsing the vault
 *   keeps it open and walking away from it does not.
 */

import {
  broadcast,
  type IncognitoAccessResponse,
  type ItemSummary,
  type OpenStatus,
  type ThumbResponse,
} from '../shared/messages.js';
import { scheduleSync } from '../sync/engine.js';
import { ItemNotFoundError, VaultLockedError } from '../vault/errors.js';
import type { Mutation } from '../vault/model.js';
import { sortItems } from '../vault/sort.js';
import { isBookmark, isDeleted, type Bookmark } from '../vault/types.js';
import type { VaultRepository } from '../storage/repo.js';
import { addActiveTab as addActiveTabTo, addUrl as addUrlTo, summarize, type AddResult } from './add.js';
import {
  extensionSettingsUrl,
  isAllowedIncognitoAccess,
  openVaulted,
  queueHistoryCleanup,
} from './incognito.js';
import * as session from './session.js';
import * as thumbs from './thumbs.js';

/**
 * There is deliberately **no** default row cap.
 *
 * The one that used to be here existed because a thousand rows means a thousand favicon requests,
 * not because a thousand rows are expensive to build. `ui/favicon.ts` loads icons lazily now, so
 * only the visible ones cost anything and the cap was buying nothing but a "showing 20 of 143" line
 * in front of the user's own bookmarks.
 *
 * `limit` stays in the protocol: Phase 6's virtualized list will ask for windows of the vault, and
 * a caller that wants a bounded answer should be able to say so.
 */

export interface ListOptions {
  readonly query?: string;
  readonly limit?: number;
}

export interface ListResult {
  readonly items: readonly ItemSummary[];
  readonly total: number;
}

export interface OpenOptions {
  readonly force?: boolean;
  readonly clearHistoryAfter?: boolean;
}

/* ------------------------------------------------------------------ adding */

/**
 * Vault the active tab, and try to bring its preview picture with it.
 *
 * The capture runs **after** the add rather than before it, and its failure changes nothing: the
 * bookmark is already in the vault and flushed by the time anything is injected. That ordering is
 * what makes "no thumbnail" the ordinary outcome it should be rather than a way to lose an add.
 *
 * It also runs only for a genuine add. Re-vaulting a page that is already there is a `duplicate`,
 * and quietly re-capturing on it would make the toolbar button a hidden refresh button —
 * `REFRESH_THUMB` is the explicit one (§14.5).
 */
export async function addActiveTab(): Promise<AddResult> {
  const repo = await requireVault();
  const result = await addActiveTabTo(repo, await addOptions());
  if (result.status === 'added') await thumbs.capture(repo, result.item.id);
  await announce(result);
  return result;
}

/**
 * Whether this add is the moment to offer "keep thumbnails on this device only" (§14.4).
 *
 * Asked by the router for the two entry points that have a window to ask in. The keyboard shortcut
 * and the context menu never ask: their only channel is the toolbar badge, and a badge cannot carry
 * a question.
 */
export async function thumbnailOffer(): Promise<boolean> {
  return thumbs.offersThumbnails(await session.settings(), await thumbs.activeProvider());
}

export async function addUrl(url: string, title?: string): Promise<AddResult> {
  const repo = await requireVault();
  const result = await addUrlTo(
    repo,
    { url, ...(title === undefined ? {} : { title }) },
    await addOptions(),
  );
  await announce(result);
  return result;
}

async function addOptions(): Promise<{ stripTrackingParams: boolean }> {
  const settings = await session.settings();
  return { stripTrackingParams: settings.stripTrackingParams };
}

/** Tell open UIs to re-read, but only when something actually changed. */
async function announce(result: AddResult): Promise<void> {
  await session.touch();
  if (result.status !== 'added') return;
  await broadcast({ type: 'VAULT_CHANGED' });
  scheduleSync();
}

/* ------------------------------------------------------------------ listing */

/**
 * Recent bookmarks, or the ones matching `query`.
 *
 * Newest first when there is no query, by relevance when there is — a search whose best match is
 * third because it happens to be older is a search that failed. Folders are excluded either way:
 * the popup lists bookmarks, and folders arrive with the manager in Phase 6.
 */
export async function list(options: ListOptions = {}): Promise<ListResult> {
  const repo = await requireVault();
  await session.touch();
  const query = options.query?.trim() ?? '';

  // `getAll` drops tombstones and `search` drops both tombstones and folders, so the only filter
  // left is "bookmarks" — and it is a type narrowing rather than a second exclusion.
  // `sortItems` rather than a bare `createdAt` comparison: two bookmarks vaulted in the same
  // millisecond — a bulk add, or a fast pair of clicks — tie on the timestamp, and a comparator
  // that returns 0 for them leaves their order to `Array.prototype.sort`. The shared comparators
  // fall back to title and then id, so the same vault always lists the same way round.
  const matches: Bookmark[] =
    query === ''
      ? sortItems(repo.getAll().filter(isBookmark), 'added').filter(isBookmark)
      : repo.search(query).map((hit) => hit.item).filter(isBookmark);

  const limited = options.limit === undefined ? matches : matches.slice(0, options.limit);
  return { items: limited.map(summarize), total: matches.length };
}

/* ------------------------------------------------------------------ opening */

/**
 * Open a vaulted bookmark, and record that it was opened.
 *
 * The open counter is bumped only when something actually opened: a missing incognito permission
 * leaves the item exactly as it was, so the guided prompt is not a click that silently edits the
 * vault.
 */
export async function open(id: string, options: OpenOptions = {}): Promise<OpenStatus> {
  const repo = await requireVault();
  const item = repo.getItem(id);
  if (item === undefined || isDeleted(item) || !isBookmark(item)) throw new ItemNotFoundError(id);

  const settings = await session.settings();
  const status = await openVaulted(item.url, {
    reuseWindow: settings.reuseIncognitoWindow,
    ...(options.force === undefined ? {} : { force: options.force }),
  });
  if (status === 'needs-incognito-access') return status;

  if (status === 'normal' && options.clearHistoryAfter === true) {
    await queueHistoryCleanup(item.url);
  }

  await repo.apply([
    {
      kind: 'update',
      id,
      patch: { openedAt: Date.now(), openCount: (item.openCount ?? 0) + 1 },
    },
  ]);
  // Written through rather than left to the 300 ms coalescer. Opening a bookmark hands focus to a
  // new window, which is exactly the moment MV3 is free to tear this worker down — and from Phase 6
  // these two fields are sort keys ("recently opened", "most opened"), so losing the bump is a
  // visibly wrong list rather than a rounding error.
  await repo.flush();
  await session.touch();
  // `openedAt` and `openCount` are sort keys on every device, not just this one, so an open is a
  // change worth replicating — debounced like any other, so a run of clicks is one push.
  scheduleSync();
  return status;
}

/* ------------------------------------------------------------------ previews */

/** The decrypted preview for one item, or the reason there is none (§14.5). */
export async function thumb(id: string): Promise<ThumbResponse> {
  const repo = await requireVault();
  await session.touch();
  return await thumbs.get(repo, id);
}

/**
 * Re-capture the preview from the page in the active tab.
 *
 * Broadcasts on the way out, because a capture that succeeded changed the item — and the row that
 * gains an eye icon is usually in a manager window, not in the popup that asked.
 */
export async function refreshThumb(id: string): Promise<ThumbResponse> {
  const repo = await requireVault();
  const result = await thumbs.refresh(repo, id);
  await session.touch();
  if (result.state === 'ready') {
    await broadcast({ type: 'VAULT_CHANGED' });
    scheduleSync();
  }
  return result;
}

export async function incognitoAccess(recheck = false): Promise<IncognitoAccessResponse> {
  return {
    type: 'INCOGNITO_ACCESS_STATE',
    allowed: await isAllowedIncognitoAccess(recheck),
    settingsUrl: extensionSettingsUrl(),
  };
}

/* ------------------------------------------------------------------ deleting and undoing */

/**
 * Delete items. Written through immediately, because the undo has to be able to find them.
 *
 * A delete is a tombstone (D20), so the undo is `restore` on the same ids rather than a second add
 * — which is what stops "delete, undo" from arriving on another device as two bookmarks.
 *
 * The whole selection is one batch, so a bulk delete is one revision and one undo. An id that is
 * not in the vault rejects the batch rather than deleting the rest: a caller working from a stale
 * list should be told, not half-obeyed.
 */
export async function remove(ids: readonly string[]): Promise<void> {
  await mutate(ids, (id) => ({ kind: 'delete', id }));
}

export async function restore(ids: readonly string[]): Promise<void> {
  await mutate(ids, (id) => ({ kind: 'restore', id }));
}

async function mutate(ids: readonly string[], build: (id: string) => Mutation): Promise<void> {
  const repo = await requireVault();
  for (const id of ids) {
    if (repo.getItem(id) === undefined) throw new ItemNotFoundError(id);
  }
  await repo.apply(ids.map(build));
  await repo.flush();
  await session.touch();
  await broadcast({ type: 'VAULT_CHANGED' });
  scheduleSync();
}

/* ------------------------------------------------------------------ internals */

/** The unlocked repository, or `VaultLockedError`. Shared with `organize.ts`. */
export async function requireVault(): Promise<VaultRepository> {
  const repo = await session.currentRepository();
  if (repo === null) throw new VaultLockedError('working with vault items');
  return repo;
}
