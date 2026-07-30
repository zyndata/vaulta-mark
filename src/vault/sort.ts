/**
 * The orders a list of vault items can be shown in (PLAN §9 Phase 6).
 *
 * Pure comparators over `VaultItem`, kept out of the manager so they can be tested without a DOM
 * and reused by anything else that has to put items in a row.
 *
 * Two properties every comparator here has, and both matter:
 *
 * - **Total.** Every order falls back to the title and then to the id, so two items that tie on the
 *   primary key still have one fixed relative position. A list whose order changes between two
 *   renders of the same data is a list whose selection and keyboard cursor jump under the user.
 * - **A fixed direction per key.** `added` means newest first, `title` means A→Z; there is no
 *   ascending/descending toggle. The five orders PLAN §9 names each have an obvious useful
 *   direction, and offering ten choices to make five of them useful is not a better menu.
 */

import { isBookmark, type VaultItem } from './types.js';

export const SORT_KEYS = ['added', 'modified', 'title', 'opened', 'opens'] as const;

export type SortKey = (typeof SORT_KEYS)[number];

/** What a fresh install sorts by: the bookmark you saved a minute ago is the one you want. */
export const DEFAULT_SORT: SortKey = 'added';

export function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value);
}

export interface SortOptions {
  /**
   * Keep folders above bookmarks whatever the order says. On for a folder listing — a folder is a
   * place rather than an entry, and mixing the two by date makes the tree unusable — and off for
   * search results, where the ranking is the point.
   */
  readonly foldersFirst?: boolean;
}

/**
 * Comparators for the primary key only. The total order is assembled in {@link compareItems}.
 *
 * `openedAt` and `openCount` are optional on a `Bookmark` and absent on a `Folder`, so both default
 * to zero: never-opened sorts below opened-once, and a folder sorts below every bookmark that has
 * ever been opened, which is what "recently opened" means.
 */
const PRIMARY: Record<SortKey, (a: VaultItem, b: VaultItem) => number> = {
  added: (a, b) => b.createdAt - a.createdAt,
  modified: (a, b) => b.updatedAt - a.updatedAt,
  title: (a, b) => byTitle(a, b),
  opened: (a, b) => openedAt(b) - openedAt(a),
  opens: (a, b) => openCount(b) - openCount(a),
};

/** A total comparator for `key`: primary, then title, then id. */
export function compareItems(key: SortKey): (a: VaultItem, b: VaultItem) => number {
  const primary = PRIMARY[key];
  return (a, b) => primary(a, b) || byTitle(a, b) || byId(a, b);
}

/** A sorted copy. The input is never mutated — callers hand us the repository's own arrays. */
export function sortItems(
  items: Iterable<VaultItem>,
  key: SortKey,
  options: SortOptions = {},
): VaultItem[] {
  const compare = compareItems(key);
  const foldersFirst = options.foldersFirst === true;
  return [...items].sort((a, b) => {
    if (foldersFirst) {
      const rank = Number(isBookmark(a)) - Number(isBookmark(b));
      if (rank !== 0) return rank;
    }
    return compare(a, b);
  });
}

/* ------------------------------------------------------------------ internals */

/**
 * Titles compared the way a person reads them: case- and accent-insensitive, and with digit runs
 * compared as numbers so "Chapter 2" precedes "Chapter 10".
 *
 * `undefined` locale on purpose — the comparison should follow the browser's UI language rather
 * than a locale we picked, and every context this runs in has the same one.
 */
function byTitle(a: VaultItem, b: VaultItem): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
}

function byId(a: VaultItem, b: VaultItem): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function openedAt(item: VaultItem): number {
  return (isBookmark(item) ? item.openedAt : undefined) ?? 0;
}

function openCount(item: VaultItem): number {
  return (isBookmark(item) ? item.openCount : undefined) ?? 0;
}
