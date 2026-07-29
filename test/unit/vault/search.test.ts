import { describe, expect, it } from 'vitest';

import { addItem, deleteItem, toItemMap, type MutationContext } from '../../../src/vault/model.js';
import {
  buildSearchIndex,
  foldText,
  parseQuery,
  search,
  tokenize,
} from '../../../src/vault/search.js';
import { ROOT_ID, type ItemMap, type VaultItem } from '../../../src/vault/types.js';

const NOW = 1_750_000_000_000;

function ctx(prefix: string): MutationContext {
  let next = 0;
  return { now: NOW, rev: 1, newId: () => `${prefix}-${String(++next)}` };
}

interface Seed {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly tags?: readonly string[];
  readonly note?: string;
  readonly parentId?: string;
}

const FOLDER_ID = 'folder-work';

const SEEDS: readonly Seed[] = [
  {
    id: 'b1',
    title: 'GitHub · Where software is built',
    url: 'https://github.com/explore',
    tags: ['Dev', 'daily'],
  },
  {
    id: 'b2',
    title: 'Padding oracles, revisited',
    url: 'https://example.org/papers/padding-oracle',
    tags: ['crypto', 'papers'],
    note: 'Section 3 explains the CBC variant',
  },
  {
    id: 'b3',
    title: 'Café Beyoncé — résumé of a résumé',
    url: 'https://example.net/cafe',
    tags: ['música'],
  },
  {
    id: 'b4',
    title: 'Quarterly planning',
    url: 'https://intranet.example.com/planning?quarter=2026Q1',
    parentId: FOLDER_ID,
    tags: ['dev'],
  },
];

function seededVault(): ItemMap {
  let items: ItemMap = new Map();
  const context = ctx('seed');
  items = addItem(items, { type: 'folder', title: 'Work', id: FOLDER_ID }, context).items;
  for (const seed of SEEDS) {
    items = addItem(
      items,
      {
        type: 'bookmark',
        id: seed.id,
        title: seed.title,
        url: seed.url,
        ...(seed.tags === undefined ? {} : { tags: seed.tags }),
        ...(seed.note === undefined ? {} : { note: seed.note }),
        ...(seed.parentId === undefined ? {} : { parentId: seed.parentId }),
      },
      context,
    ).items;
  }
  return items;
}

function ids(hits: readonly { item: VaultItem }[]): string[] {
  return hits.map((hit) => hit.item.id);
}

describe('foldText', () => {
  it('strips diacritics and folds case', () => {
    expect(foldText('Café BEYONCÉ')).toBe('cafe beyonce');
    expect(foldText('Straße')).toBe('straße');
  });

  it('folds compatibility forms, so pasted text matches typed text', () => {
    expect(foldText('ﬁle')).toBe('file');
  });
});

describe('tokenize', () => {
  it('splits on anything that is not a letter or a digit', () => {
    expect(tokenize('github.com/explore?a=1')).toEqual(['github', 'com', 'explore', 'a', '1']);
  });
});

describe('parseQuery', () => {
  it('lifts tag filters out and folds the remaining terms', () => {
    expect(parseQuery('  Padding tag:Crypto oracle ')).toEqual({
      terms: ['padding', 'oracle'],
      tags: ['crypto'],
    });
  });

  it('returns nothing for an empty query', () => {
    expect(parseQuery('   ')).toEqual({ terms: [], tags: [] });
  });
});

describe('search', () => {
  const index = buildSearchIndex(seededVault().values());

  it('finds a title hit', () => {
    expect(ids(search(index, 'padding'))).toEqual(['b2']);
  });

  it('finds a host hit without a word boundary', () => {
    // The whole point: `github` must find `https://github.com/…`.
    expect(ids(search(index, 'github'))).toEqual(['b1']);
  });

  it('finds a mid-token substring, not just a prefix', () => {
    expect(ids(search(index, 'ranet'))).toEqual(['b4']);
  });

  it('finds a note hit', () => {
    expect(ids(search(index, 'cbc'))).toEqual(['b2']);
  });

  it('finds a tag hit as free text', () => {
    expect(ids(search(index, 'papers'))).toEqual(['b2']);
  });

  it('folds diacritics in both the query and the data', () => {
    expect(ids(search(index, 'beyonce'))).toEqual(['b3']);
    expect(ids(search(index, 'Beyoncé'))).toEqual(['b3']);
    expect(ids(search(index, 'musica'))).toEqual(['b3']);
  });

  it('ANDs multiple terms', () => {
    expect(ids(search(index, 'padding oracle'))).toEqual(['b2']);
    expect(ids(search(index, 'padding github'))).toEqual([]);
  });

  it('filters on tag: without scoring it', () => {
    expect(ids(search(index, 'tag:dev')).toSorted()).toEqual(['b1', 'b4']);
    expect(ids(search(index, 'tag:dev planning'))).toEqual(['b4']);
    expect(ids(search(index, 'tag:nonexistent'))).toEqual([]);
  });

  it('scopes to a folder subtree', () => {
    expect(ids(search(index, 'planning', { folderId: FOLDER_ID }))).toEqual(['b4']);
    expect(ids(search(index, 'github', { folderId: FOLDER_ID }))).toEqual([]);
    // ROOT_ID means the whole vault, not "only top-level items".
    expect(ids(search(index, 'planning', { folderId: ROOT_ID }))).toEqual(['b4']);
  });

  it('ranks a title hit above a URL hit', () => {
    const items = seededVault();
    const extra = addItem(
      items,
      { type: 'bookmark', id: 'b5', title: 'Unrelated', url: 'https://example.com/planning' },
      ctx('extra'),
    ).items;
    const hits = search(buildSearchIndex(extra.values()), 'planning');
    expect(ids(hits)).toEqual(['b4', 'b5']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('excludes folders unless asked', () => {
    expect(ids(search(index, 'work'))).toEqual([]);
    expect(ids(search(index, 'work', { includeFolders: true }))).toEqual([FOLDER_ID]);
  });

  it('never surfaces a tombstoned item', () => {
    const items = seededVault();
    const deleted = deleteItem(items, 'b2', ctx('del')).items;
    expect(ids(search(buildSearchIndex(deleted.values()), 'padding'))).toEqual([]);
  });

  it('returns nothing for an empty query rather than the whole vault', () => {
    expect(search(index, '   ')).toEqual([]);
  });

  it('honours a result limit', () => {
    expect(search(index, 'tag:dev', { limit: 1 })).toHaveLength(1);
  });

  it('has no false negatives on any substring of an indexed title', () => {
    const title = 'Padding oracles, revisited';
    for (let start = 0; start < title.length - 3; start++) {
      const term = foldText(title.slice(start, start + 4));
      if (term.trim() === '') continue;
      expect(ids(search(index, term)), term).toContain('b2');
    }
  });

  it('drops the scheme from the URL so a one-letter query is not a wildcard', () => {
    // Every URL starts with `https`; if the scheme were indexed, `h` would match everything.
    expect(ids(search(index, 'https'))).toEqual([]);
  });

  it('indexes an unparseable URL verbatim rather than dropping it', () => {
    const items = addItem(
      new Map(),
      { type: 'bookmark', id: 'weird', title: 'Odd', url: 'not a url at all' },
      ctx('odd'),
    ).items;
    expect(ids(search(buildSearchIndex(items.values()), 'url at all'))).toEqual(['weird']);
  });

  it('does not loop on a parent cycle when scoping', () => {
    const items = new Map(seededVault());
    const folder = items.get(FOLDER_ID)!;
    items.set(FOLDER_ID, { ...folder, parentId: 'b4' });
    expect(() =>
      search(buildSearchIndex(items.values()), 'planning', { folderId: 'b4' }),
    ).not.toThrow();
  });
});

describe('buildSearchIndex', () => {
  it('counts only live items', () => {
    const items = seededVault();
    expect(buildSearchIndex(items.values()).size).toBe(items.size);
    const deleted = deleteItem(items, 'b1', ctx('del')).items;
    expect(buildSearchIndex(deleted.values()).size).toBe(items.size - 1);
  });

  it('is built from an item list, never persisted', () => {
    // A search index is the vault content reorganised; it exists only in memory (INV-6).
    const index = buildSearchIndex(toItemMap([]).values());
    expect(index.size).toBe(0);
  });
});
