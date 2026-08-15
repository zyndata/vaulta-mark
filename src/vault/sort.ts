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

import { compareOrder } from './order.js';
import { isBookmark, type SortKey, type VaultItem } from './types.js';

// The key names themselves live in `types.ts`, which `VaultSettings` needs them for and which this
// file already depends on for the item types. Re-exported here so a caller that wants the whole
// sorting vocabulary has one import.
export { DEFAULT_SORT, SORT_KEYS, isSortKey, type SortKey } from './types.js';

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
  /*
   * The one order the user sets by hand, and the only one that reads a field maintained rather
   * than observed. Fractional index keys are unique *within a parent*, which is exactly the scope
   * that can be reordered — a folder listing. Across parents (a search, a tag filter, "Untagged")
   * they interleave arbitrarily, which is why those views refuse to reorder rather than pretending
   * a drop there means something; the comparator is still total, so the list does not shuffle.
   */
  manual: (a, b) => compareOrder(a.order, b.order),
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
