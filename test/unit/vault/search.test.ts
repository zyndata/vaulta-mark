import { describe, expect, it } from 'vitest';

import { addItem, deleteItem, toItemMap, type MutationContext } from '../../../src/vault/model.js';
import {
  buildSearchIndex,
  foldText,
  foldWithMap,
  isEmptyQuery,
  matchRanges,
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

const EMPTY_QUERY = { terms: [], tags: [], folders: [], hosts: [], fields: [] };

describe('parseQuery', () => {
  it('lifts tag filters out and folds the remaining terms', () => {
    expect(parseQuery('  Padding tag:Crypto oracle ')).toEqual({
      ...EMPTY_QUERY,
      terms: ['padding', 'oracle'],
      tags: ['crypto'],
    });
  });

  it('returns nothing for an empty query', () => {
    expect(parseQuery('   ')).toEqual(EMPTY_QUERY);
  });

  it('lifts folder:, host: and in: as well', () => {
    expect(parseQuery('report folder:Work host:Example.COM in:note')).toEqual({
      terms: ['report'],
      tags: [],
      folders: ['work'],
      hosts: ['example.com'],
      fields: ['note'],
    });
  });

  it('accepts several in: fields and never repeats one', () => {
    expect(parseQuery('x in:note in:title in:note').fields).toEqual(['note', 'title']);
  });

  it('treats an unknown in: field as an ordinary term', () => {
    // The alternative — an empty restriction — would make `in:noets` match every field, which is
    // the one behaviour that hides the typo instead of showing it.
    expect(parseQuery('in:noets')).toEqual({ ...EMPTY_QUERY, terms: ['in:noets'] });
  });

  it('leaves a bare prefix with no value as a term', () => {
    expect(parseQuery('tag:')).toEqual({ ...EMPTY_QUERY, terms: ['tag:'] });
  });
});

describe('isEmptyQuery', () => {
  it('is true only when nothing at all was asked for', () => {
    expect(isEmptyQuery(parseQuery('   '))).toBe(true);
    expect(isEmptyQuery(parseQuery('in:note'))).toBe(true);
    expect(isEmptyQuery(parseQuery('tag:dev'))).toBe(false);
    expect(isEmptyQuery(parseQuery('folder:work'))).toBe(false);
    expect(isEmptyQuery(parseQuery('host:example.com'))).toBe(false);
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

  it('filters on folder: by the name of any ancestor', () => {
    expect(ids(search(index, 'folder:work'))).toEqual(['b4']);
    // A fragment is enough, like every other match in this file.
    expect(ids(search(index, 'folder:wor'))).toEqual(['b4']);
    expect(ids(search(index, 'folder:archive'))).toEqual([]);
    // Combined with a term, it narrows rather than replaces.
    expect(ids(search(index, 'folder:work planning'))).toEqual(['b4']);
    expect(ids(search(index, 'folder:work github'))).toEqual([]);
  });

  it('matches folder: through a grandparent, not only the direct parent', () => {
    let items = seededVault();
    const context = ctx('nested');
    items = addItem(
      items,
      { type: 'folder', title: 'Roadmaps', id: 'sub', parentId: FOLDER_ID },
      context,
    ).items;
    items = addItem(
      items,
      { type: 'bookmark', id: 'deep', title: 'Deep', url: 'https://example.com/deep', parentId: 'sub' },
      context,
    ).items;
    expect(ids(search(buildSearchIndex(items.values()), 'folder:work deep'))).toEqual(['deep']);
  });

  it('filters on host:, including the www. a search term would not see', () => {
    expect(ids(search(index, 'host:github.com'))).toEqual(['b1']);
    expect(ids(search(index, 'host:example'))).toHaveLength(3);
    expect(ids(search(index, 'host:nope.invalid'))).toEqual([]);

    const items = addItem(
      seededVault(),
      { type: 'bookmark', id: 'w', title: 'With www', url: 'https://www.example.io/a' },
      ctx('www'),
    ).items;
    // `searchableUrl` drops `www.` so it is not noise in every term match; `host:` keeps it, so
    // someone who types the host they see in the address bar finds the bookmark.
    expect(ids(search(buildSearchIndex(items.values()), 'host:www.example.io'))).toEqual(['w']);
  });

  it('restricts terms to the fields named by in:', () => {
    // "section" is in b2's note only, "padding" is in its title and its URL.
    expect(ids(search(index, 'in:note section'))).toEqual(['b2']);
    expect(ids(search(index, 'in:note padding'))).toEqual([]);
    expect(ids(search(index, 'in:title padding'))).toEqual(['b2']);
    expect(ids(search(index, 'in:url explore'))).toEqual(['b1']);
    expect(ids(search(index, 'in:tags papers'))).toEqual(['b2']);
    // Two fields widen the restriction rather than intersecting it.
    expect(ids(search(index, 'in:note in:title section'))).toEqual(['b2']);
  });

  it('returns a filter-only query as results rather than as nothing', () => {
    expect(ids(search(index, 'host:github.com')).length).toBeGreaterThan(0);
    // …but `in:` on its own restricts nothing that was asked for, so it stays empty.
    expect(search(index, 'in:note')).toEqual([]);
  });

  it('does not loop on a parent cycle when scoping', () => {
    const items = new Map(seededVault());
    const folder = items.get(FOLDER_ID)!;
    items.set(FOLDER_ID, { ...folder, parentId: 'b4' });
    const cyclic = buildSearchIndex(items.values());
    expect(() => search(cyclic, 'planning', { folderId: 'b4' })).not.toThrow();
    expect(() => search(cyclic, 'folder:work')).not.toThrow();
  });

  it('accepts an already-parsed query, so a caller can parse once and search many times', () => {
    expect(ids(search(index, parseQuery('padding')))).toEqual(['b2']);
  });
});

describe('foldWithMap', () => {
  it('folds like foldText and maps every folded character back to its source', () => {
    const { folded, map } = foldWithMap('Café');
    expect(folded).toBe(foldText('Café'));
    expect(folded).toBe('cafe');
    expect(map).toEqual([0, 1, 2, 3]);
  });

  it('handles a folding that grows and one that shrinks', () => {
    // "ﬁ" is one code point that folds to two characters; both point back at it.
    expect(foldWithMap('ﬁx')).toEqual({ folded: 'fix', map: [0, 0, 1] });
    // A combining mark folds away entirely and contributes no folded character.
    expect(foldWithMap('éx')).toEqual({ folded: 'ex', map: [0, 2] });
  });

  it('advances by the two UTF-16 units a surrogate pair occupies', () => {
    // The emoji is one code point that folds to a two-unit string, so both units point back at
    // offset 0 — and the character after it starts at 2, which is where `slice` expects it.
    const { folded, map } = foldWithMap('😀a');
    expect(folded).toBe('😀a');
    expect(map).toEqual([0, 0, 2]);
  });
});

describe('matchRanges', () => {
  it('finds every occurrence of every term', () => {
    expect(matchRanges('padding oracle padding', ['padding'])).toEqual([
      { start: 0, end: 7 },
      { start: 15, end: 22 },
    ]);
  });

  it('ranges index the original text, not the folded one', () => {
    // Folding "Café" shortens nothing here, but "Beyoncé" after it would shift by one if the
    // ranges were measured on the folded string.
    const text = 'Café Beyoncé';
    const [range] = matchRanges(text, ['beyonce']);
    expect(text.slice(range!.start, range!.end)).toBe('Beyoncé');
  });

  it('merges overlapping and adjacent hits into one highlight', () => {
    expect(matchRanges('github', ['git', 'github'])).toEqual([{ start: 0, end: 6 }]);
    expect(matchRanges('aaaa', ['aa'])).toEqual([{ start: 0, end: 4 }]);
  });

  it('is empty for no terms, empty terms, or empty text', () => {
    expect(matchRanges('anything', [])).toEqual([]);
    expect(matchRanges('anything', [''])).toEqual([]);
    expect(matchRanges('', ['a'])).toEqual([]);
    expect(matchRanges('anything', ['nothere'])).toEqual([]);
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
