/**
 * What the manager is currently looking at, and how it asks the service worker for it.
 *
 * The page holds no key and no vault: it holds *a screenful*, plus the folder tree and tag list
 * that make up the sidebar, and it throws all of it away when the tab closes. Every read is a
 * message; there is no client-side cache to go stale, because a second window editing the same
 * vault would be exactly the thing to make it go stale.
 *
 * Two rules the rest of `src/manager/` relies on:
 *
 * - **`refresh()` is the only way the data changes.** Anything that mutates the vault sends its
 *   message and then calls `refresh()`, so what is on screen is always what the worker just said —
 *   not what the UI predicted it would say.
 * - **A stale answer never lands.** Every fetch carries a token; a response whose token is no
 *   longer the latest is dropped. A slow search for `g` must not overwrite the results for `git`.
 */

import {
  send,
  type ErrorCode,
  type ItemDetail,
  type ListRow,
  type TreeResponse,
  type ViewResponse,
} from '../shared/messages.js';
import { DEFAULT_SORT, type SortKey } from '../vault/sort.js';
import { ROOT_ID } from '../vault/types.js';

/** Which of the sidebar's entries is active. */
export type Scope =
  /** A folder, or the whole vault when `folderId` is `ROOT_ID`. */
  | { readonly kind: 'folder'; readonly folderId: string }
  /** Bookmarks carrying no tags, anywhere in the vault. */
  | { readonly kind: 'untagged' };

export interface ManagerState {
  scope: Scope;
  query: string;
  sort: SortKey;
  /** Selected row ids. Insertion-ordered, which is what makes "the last one clicked" meaningful. */
  selection: Set<string>;
  /** The keyboard cursor's row index, or `-1` when the list has no cursor yet. */
  cursor: number;
  tree: TreeResponse | null;
  view: ViewResponse | null;
  detail: ItemDetail | null;
  /**
   * Bookmarks Chrome's history still holds a visit to (§12.6).
   *
   * Empty while the optional `history` permission is ungranted, which is indistinguishable from
   * "nothing is in history" on purpose: without the permission there is nothing we could truthfully
   * say, and a warning drawn on a guess is worse than no warning.
   */
  inHistory: ReadonlySet<string>;
  /** The last thing that went wrong, for the status line. */
  error: ErrorCode | null;
}

export function initialState(): ManagerState {
  return {
    scope: { kind: 'folder', folderId: ROOT_ID },
    query: '',
    sort: DEFAULT_SORT,
    selection: new Set(),
    cursor: -1,
    tree: null,
    view: null,
    detail: null,
    inHistory: new Set(),
    error: null,
  };
}

export const EMPTY_VIEW: ViewResponse = {
  type: 'VIEW',
  items: [],
  path: [],
  terms: [],
  ranked: false,
};

export function rowsOf(state: ManagerState): readonly ListRow[] {
  return state.view?.items ?? [];
}

/** The row at the keyboard cursor, if there is one. */
export function cursorRow(state: ManagerState): ListRow | undefined {
  return state.cursor < 0 ? undefined : rowsOf(state)[state.cursor];
}

/**
 * Whether a *position* is a thing this view can show, and therefore whether it can be reordered
 * (Phase 12).
 *
 * Three conditions, and each one is a view in which a drop between two rows would rearrange
 * nothing anybody could see. Under a derived order the list re-sorts itself on the next reload; a
 * search or a tag filter draws from every folder at once, and `order` keys are unique only within
 * a parent; and "Untagged" is the same. The gesture is withdrawn rather than made a no-op, because
 * a drag that lands and changes nothing is indistinguishable from one that failed.
 */
export function canReorder(state: ManagerState): boolean {
  return state.sort === 'manual' && state.query.trim() === '' && state.scope.kind === 'folder';
}

/** The folder a reorder happens inside — the scope, which `canReorder` has already vouched for. */
export function reorderParent(state: ManagerState): string | null {
  return canReorder(state) && state.scope.kind === 'folder' ? state.scope.folderId : null;
}

/** The one selected row, or `undefined` when zero or many are selected. */
export function soleSelection(state: ManagerState): ListRow | undefined {
  if (state.selection.size !== 1) return undefined;
  const [id] = state.selection;
  return rowsOf(state).find((row) => row.id === id);
}

/**
 * Re-read everything the current screen shows.
 *
 * The tree and the view are two requests rather than one because they change at different rates:
 * typing in the search box refetches the view on every settled keystroke, and the sidebar has no
 * reason to move while that happens. `refreshView` is the hot path; this is the cold one.
 */
export async function refreshAll(state: ManagerState): Promise<void> {
  await Promise.all([refreshTree(state), refreshView(state)]);
}

export async function refreshTree(state: ManagerState): Promise<void> {
  const response = await send({ type: 'GET_TREE' });
  if (response.type === 'ERROR') {
    state.error = response.code;
    state.tree = null;
    return;
  }
  state.tree = response;
}

/**
 * The token guarding against an out-of-order answer.
 *
 * Module scope rather than state, because it guards the *transport* and there is exactly one
 * manager page per tab. Two fetches in flight is normal — the user is typing — and only the last
 * one started may write to the state.
 */
let latestView = 0;

export async function refreshView(state: ManagerState): Promise<void> {
  const token = ++latestView;
  const query = state.query.trim();
  const response = await send({
    type: 'LIST_VIEW',
    sort: state.sort,
    ...(query === '' ? {} : { query }),
    ...(state.scope.kind === 'untagged'
      ? { untagged: true }
      : state.scope.folderId === ROOT_ID
        ? {}
        : { folderId: state.scope.folderId }),
  });
  if (token !== latestView) return;

  if (response.type === 'ERROR') {
    state.error = response.code;
    state.view = EMPTY_VIEW;
    return;
  }
  state.error = null;
  state.view = response;

  // A selection survives a re-render only as far as the rows do. Keeping ids that are no longer on
  // screen would let a bulk delete reach bookmarks the user can no longer see.
  const present = new Set(response.items.map((row) => row.id));
  for (const id of state.selection) {
    if (!present.has(id)) state.selection.delete(id);
  }
  if (state.cursor >= response.items.length) state.cursor = response.items.length - 1;
}

/**
 * Ask which bookmarks are still in Chrome's history.
 *
 * Deliberately **not** part of `refreshAll`. It costs a search per vaulted domain, so it is asked
 * when the manager opens and after the things that can change the answer — never on the path of a
 * keystroke, a scroll or a selection. A failure leaves the previous answer alone rather than
 * clearing it: a temporary refusal is not evidence that nothing is in history.
 */
export async function refreshHistoryPresence(state: ManagerState): Promise<void> {
  const response = await send({ type: 'HISTORY_PRESENCE' });
  if (response.type === 'ERROR') return;
  state.inHistory = new Set(response.ids);
}

/** Load the detail pane for the single selected row, or clear it. */
export async function refreshDetail(state: ManagerState): Promise<void> {
  const sole = soleSelection(state);
  if (sole === undefined) {
    state.detail = null;
    return;
  }
  const response = await send({ type: 'GET_ITEM', id: sole.id });
  // Only write it back if the selection has not moved on while the round trip was in flight.
  if (response.type === 'ERROR' || soleSelection(state)?.id !== sole.id) return;
  state.detail = response.item;
}
