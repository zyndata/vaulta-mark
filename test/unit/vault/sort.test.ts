/**
 * Sort orders (PLAN §9 Phase 6).
 *
 * The property that gets its own tests here is **totality**. A comparator that returns 0 for two
 * different items leaves their relative order up to `Array.prototype.sort`, and a list whose order
 * changes between two renders of identical data moves the selection and the keyboard cursor out
 * from under whoever is using it.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SORT,
  SORT_KEYS,
  compareItems,
  isSortKey,
  sortItems,
  type SortKey,
} from '../../../src/vault/sort.js';
import type { Bookmark, Folder, VaultItem } from '../../../src/vault/types.js';

const NOW = 1_750_000_000_000;

function bookmark(id: string, fields: Partial<Bookmark> = {}): Bookmark {
  return {
    id,
    type: 'bookmark',
    parentId: 'root',
    title: id,
    url: `https://example.com/${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    order: 'a0',
    rev: 1,
    ...fields,
  };
}

function folder(id: string, fields: Partial<Folder> = {}): Folder {
  return {
    id,
    type: 'folder',
    parentId: 'root',
    title: id,
    createdAt: NOW,
    updatedAt: NOW,
    order: 'a0',
    rev: 1,
    ...fields,
  };
}

function ids(items: readonly VaultItem[]): string[] {
  return items.map((item) => item.id);
}

describe('the key set', () => {
  it('is the five orders PLAN §9 names plus the one it can be set to, with a default among them', () => {
    // `manual` arrived in Phase 12 with drag-to-reorder. It is the only key that is not derived
    // from a field of the item, and the only one under which a drop between two rows means
    // anything — see the comment on `SORT_KEYS` in `vault/types.ts`.
    expect(SORT_KEYS).toEqual(['added', 'modified', 'title', 'opened', 'opens', 'manual']);
    expect(SORT_KEYS).toContain(DEFAULT_SORT);
    // Not the default: a fresh vault has never been arranged, so "my own order" would be whatever
    // order things happened to be added in, presented as a choice the user had made.
    expect(DEFAULT_SORT).not.toBe('manual');
  });

  it('puts items in their fractional-index order under `manual`, and nothing else does', () => {
    // Built with orders that disagree with every other key: `c` was added first and titled last.
    const items: VaultItem[] = [
      bookmark('c', { title: 'Zulu', order: 'a0', createdAt: 1 }),
      bookmark('a', { title: 'Alpha', order: 'a1', createdAt: 3 }),
      bookmark('b', { title: 'Mike', order: 'a2', createdAt: 2 }),
    ];
    expect(ids(sortItems(items, 'manual'))).toEqual(['c', 'a', 'b']);
    expect(ids(sortItems(items, 'title'))).toEqual(['a', 'b', 'c']);
    expect(ids(sortItems(items, 'added'))).toEqual(['a', 'b', 'c']);
  });

  it('recognises its own keys and nothing else', () => {
    for (const key of SORT_KEYS) expect(isSortKey(key)).toBe(true);
    expect(isSortKey('sideways')).toBe(false);
    expect(isSortKey(3)).toBe(false);
    expect(isSortKey(undefined)).toBe(false);
  });
});

describe('sortItems', () => {
  it('puts the newest first for "added"', () => {
    const items = [
      bookmark('old', { createdAt: NOW - 1000 }),
      bookmark('new', { createdAt: NOW }),
      bookmark('middle', { createdAt: NOW - 500 }),
    ];
    expect(ids(sortItems(items, 'added'))).toEqual(['new', 'middle', 'old']);
  });

  it('puts the most recently changed first for "modified"', () => {
    const items = [
      bookmark('stale', { updatedAt: NOW - 1000 }),
      bookmark('fresh', { updatedAt: NOW }),
    ];
    expect(ids(sortItems(items, 'modified'))).toEqual(['fresh', 'stale']);
  });

  it('sorts titles A→Z, ignoring case and accents, and reading digits as numbers', () => {
    const items = [
      bookmark('c', { title: 'chapter 10' }),
      bookmark('a', { title: 'Ärger' }),
      bookmark('b', { title: 'Chapter 2' }),
    ];
    expect(ids(sortItems(items, 'title'))).toEqual(['a', 'b', 'c']);
  });

  it('puts the most recently opened first, with never-opened last', () => {
    const items = [
      bookmark('never'),
      bookmark('recent', { openedAt: NOW }),
      bookmark('older', { openedAt: NOW - 1000 }),
    ];
    expect(ids(sortItems(items, 'opened'))).toEqual(['recent', 'older', 'never']);
  });

  it('puts the most opened first, with never-opened last', () => {
    const items = [bookmark('few', { openCount: 2 }), bookmark('never'), bookmark('many', { openCount: 9 })];
    expect(ids(sortItems(items, 'opens'))).toEqual(['many', 'few', 'never']);
  });

  it('does not mutate the array it was given', () => {
    const items = [bookmark('b', { createdAt: NOW - 1 }), bookmark('a', { createdAt: NOW })];
    const before = ids(items);
    sortItems(items, 'added');
    expect(ids(items)).toEqual(before);
  });

  it('lifts folders above bookmarks only when asked', () => {
    const items = [
      bookmark('bookmark', { createdAt: NOW }),
      folder('folder', { createdAt: NOW - 1000 }),
    ];
    expect(ids(sortItems(items, 'added'))).toEqual(['bookmark', 'folder']);
    expect(ids(sortItems(items, 'added', { foldersFirst: true }))).toEqual(['folder', 'bookmark']);
  });

  it('sorts a folder against a folder by the same key', () => {
    const items = [folder('b', { createdAt: NOW - 1 }), folder('a', { createdAt: NOW })];
    expect(ids(sortItems(items, 'added', { foldersFirst: true }))).toEqual(['a', 'b']);
  });

  it('treats a folder as never opened rather than throwing at its missing fields', () => {
    const items = [folder('f'), bookmark('b', { openCount: 1, openedAt: NOW })];
    expect(ids(sortItems(items, 'opens'))).toEqual(['b', 'f']);
    expect(ids(sortItems(items, 'opened'))).toEqual(['b', 'f']);
  });
});

describe('totality', () => {
  /** Two items that tie on every primary key, and differ only in id. */
  const twins = [bookmark('zzz', { title: 'Same' }), bookmark('aaa', { title: 'Same' })];

  it.each(SORT_KEYS)('breaks a complete tie deterministically for "%s"', (key: SortKey) => {
    const compare = compareItems(key);
    expect(compare(twins[0]!, twins[1]!)).toBeGreaterThan(0);
    expect(compare(twins[1]!, twins[0]!)).toBeLessThan(0);
    expect(compare(twins[0]!, twins[0]!)).toBe(0);
    // The same input in either starting order lands the same way round.
    expect(ids(sortItems(twins, key))).toEqual(['aaa', 'zzz']);
    expect(ids(sortItems([...twins].reverse(), key))).toEqual(['aaa', 'zzz']);
  });

  it.each(SORT_KEYS)('falls back to the title before the id for "%s"', (key: SortKey) => {
    // `zzz` is alphabetically last by id and first by title; a comparator that skipped the title
    // tie-break would put it second.
    const items = [bookmark('aaa', { title: 'Beta' }), bookmark('zzz', { title: 'Alpha' })];
    expect(ids(sortItems(items, key))).toEqual(['zzz', 'aaa']);
  });
});
