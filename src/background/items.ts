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
} from '../shared/messages.js';
import { ItemNotFoundError, VaultLockedError } from '../vault/errors.js';
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

/** How many rows the popup shows before the list is trimmed. */
export const DEFAULT_LIST_LIMIT = 20;

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

export async function addActiveTab(): Promise<AddResult> {
  const repo = await requireVault();
  const result = await addActiveTabTo(repo, await addOptions());
  await announce(result);
  return result;
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
  if (result.status === 'added') await broadcast({ type: 'VAULT_CHANGED' });
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
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const query = options.query?.trim() ?? '';

  // `getAll` drops tombstones and `search` drops both tombstones and folders, so the only filter
  // left is "bookmarks" — and it is a type narrowing rather than a second exclusion.
  const matches: Bookmark[] =
    query === ''
      ? repo.getAll().filter(isBookmark).sort(newestFirst)
      : repo.search(query).map((hit) => hit.item).filter(isBookmark);

  return { items: matches.slice(0, limit).map(summarize), total: matches.length };
}

function newestFirst(a: Bookmark, b: Bookmark): number {
  return b.createdAt - a.createdAt;
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
  await session.touch();
  return status;
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
 * Delete a bookmark. Written through immediately, because the undo has to be able to find it.
 *
 * A delete is a tombstone (D20), so the undo is `restore` on the same id rather than a second add
 * — which is what stops "delete, undo" from arriving on another device as two bookmarks.
 */
export async function remove(id: string): Promise<void> {
  const repo = await requireVault();
  if (repo.getItem(id) === undefined) throw new ItemNotFoundError(id);
  await repo.apply([{ kind: 'delete', id }]);
  await repo.flush();
  await session.touch();
  await broadcast({ type: 'VAULT_CHANGED' });
}

export async function restore(id: string): Promise<void> {
  const repo = await requireVault();
  if (repo.getItem(id) === undefined) throw new ItemNotFoundError(id);
  await repo.apply([{ kind: 'restore', id }]);
  await repo.flush();
  await session.touch();
  await broadcast({ type: 'VAULT_CHANGED' });
}

/* ------------------------------------------------------------------ internals */

async function requireVault(): Promise<VaultRepository> {
  const repo = await session.currentRepository();
  if (repo === null) throw new VaultLockedError('working with vault items');
  return repo;
}
