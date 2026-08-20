/**
 * The duplicate normal form and the grouping over it (PLAN §9 Phase 16).
 *
 * The table below is the specification. This module's whole job is deciding which addresses are
 * "the same page", and every argument about that decision — the tracking-parameter pair, the two
 * videos, the fragment, the query order — is a row here rather than a sentence somewhere. A change
 * to the normal form should break a named row, not a round-trip.
 *
 * Items are built by hand rather than through `addItem`, because the point of most of these tests
 * is a URL that `addItem` would normalize before this module ever saw it.
 */

import { describe, expect, it } from 'vitest';

import { duplicateCount, duplicateGroups, duplicateKey } from '../../../src/vault/duplicates.js';
import { ROOT_ID, type Bookmark, type Folder, type ItemMap, type VaultItem } from '../../../src/vault/types.js';

const NOW = 1_750_000_000_000;

function bookmark(id: string, url: string, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id,
    type: 'bookmark',
    parentId: ROOT_ID,
    title: id,
    url,
    createdAt: NOW,
    updatedAt: NOW,
    order: 'a0',
    rev: 1,
    ...overrides,
  };
}

function vault(...items: VaultItem[]): ItemMap {
  return new Map(items.map((item) => [item.id, item]));
}

/* ---------------------------------------------------------------- the normal form */

describe('duplicateKey', () => {
  /**
   * Pairs that are one address, and pairs that are two.
   *
   * `same: true` means the screen will draw them side by side and offer to remove one; `false`
   * means it will never mention them together. Both halves matter — a normal form that collapses
   * too much proposes deleting bookmarks that are not copies, in a screen whose only verb is
   * delete.
   */
  const table: readonly { readonly name: string; readonly a: string; readonly b: string; readonly same: boolean }[] = [
    {
      name: 'a campaign parameter is not part of the address',
      a: 'https://example.com/a',
      b: 'https://example.com/a?utm_source=newsletter',
      same: true,
    },
    {
      name: 'several campaign parameters, and the ? that held them',
      a: 'https://example.com/a',
      b: 'https://example.com/a?utm_source=x&utm_medium=email&fbclid=abc123',
      same: true,
    },
    {
      name: 'a click identifier beside a real parameter leaves the real one',
      a: 'https://example.com/search?q=vault',
      b: 'https://example.com/search?q=vault&gclid=zzz',
      same: true,
    },
    {
      name: 'two videos are two videos — the query is kept',
      a: 'https://www.youtube.com/watch?v=a',
      b: 'https://www.youtube.com/watch?v=b',
      same: false,
    },
    {
      name: 'a real query parameter dropped is a different page',
      a: 'https://example.com/search?q=vault',
      b: 'https://example.com/search',
      same: false,
    },
    {
      name: 'query order is not meaning',
      a: 'https://example.com/a?x=1&y=2',
      b: 'https://example.com/a?y=2&x=1',
      same: true,
    },
    {
      name: 'a fragment is a position on one page',
      a: 'https://example.com/doc#install',
      b: 'https://example.com/doc#usage',
      same: true,
    },
    {
      name: 'a bare origin with and without its slash',
      a: 'https://example.com',
      b: 'https://example.com/',
      same: true,
    },
    {
      name: 'a trailing slash on a path is a server’s business, and servers disagree',
      a: 'https://example.com/docs',
      b: 'https://example.com/docs/',
      same: false,
    },
    { name: 'host case', a: 'https://Example.COM/a', b: 'https://example.com/a', same: true },
    { name: 'path case', a: 'https://example.com/A', b: 'https://example.com/a', same: false },
    {
      name: 'the default port is the port',
      a: 'https://example.com:443/a',
      b: 'https://example.com/a',
      same: true,
    },
    { name: 'scheme', a: 'http://example.com/a', b: 'https://example.com/a', same: false },
    {
      name: 'a subdomain is a different host',
      a: 'https://example.com/a',
      b: 'https://www.example.com/a',
      same: false,
    },
  ];

  for (const row of table) {
    it(`${row.same ? 'collapses' : 'keeps apart'}: ${row.name}`, () => {
      const a = duplicateKey(row.a);
      const b = duplicateKey(row.b);
      if (row.same) expect(a).toBe(b);
      else expect(a).not.toBe(b);
    });
  }

  it('is wider than the add-time check, on purpose', async () => {
    // The one place the two normalizations are asserted to *differ*. If this ever passes by both
    // sides agreeing, one of them has been changed without the other and PLAN §9 Phase 16 says why
    // they are not supposed to agree.
    const { duplicateKeyOf } = await import('../../../src/vault/model.js');
    const plain = 'https://example.com/a';
    const tagged = 'https://example.com/a?utm_source=x';
    expect(duplicateKeyOf(plain)).not.toBe(duplicateKeyOf(tagged));
    expect(duplicateKey(plain)).toBe(duplicateKey(tagged));
  });

  it('does not throw on a URL the platform cannot parse', () => {
    // `normalizeUrl` stores unparseable input verbatim by design, so the vault can hold one — an
    // import from elsewhere is the usual route. Housekeeping must not be where that is discovered.
    expect(duplicateKey('not a url at all')).toBe('not a url at all');
    expect(duplicateKey('  MAILTO:someone@example.com  ')).toBe('mailto:someone@example.com');
  });

  it('groups two unparseable strings that differ only in case and padding', () => {
    expect(duplicateKey(' Whatever This Is ')).toBe(duplicateKey('whatever this is'));
  });
});

/* ---------------------------------------------------------------- grouping */

describe('duplicateGroups', () => {
  it('returns nothing when every address is saved once', () => {
    const items = vault(
      bookmark('a', 'https://example.com/one'),
      bookmark('b', 'https://example.com/two'),
      bookmark('c', 'https://other.example/one'),
    );
    expect(duplicateGroups(items)).toEqual([]);
    expect(duplicateCount(items)).toBe(0);
  });

  it('groups the copies of one address and leaves the singletons out', () => {
    const items = vault(
      bookmark('a', 'https://example.com/one'),
      bookmark('b', 'https://example.com/one?utm_source=x'),
      bookmark('c', 'https://example.com/two'),
    );
    const groups = duplicateGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(duplicateCount(items)).toBe(1);
  });

  /**
   * A tombstone is a bookmark the user already deleted, kept so the deletion reaches the other
   * device. Counting one would offer to delete what is already deleted — and, in the second case
   * below, would report a duplicate for a bookmark that has no surviving copy at all.
   */
  describe('tombstones', () => {
    it('are never grouped with a live copy', () => {
      const items = vault(
        bookmark('live', 'https://example.com/one'),
        bookmark('gone', 'https://example.com/one', { deleted: true, deletedAt: NOW }),
      );
      expect(duplicateGroups(items)).toEqual([]);
      expect(duplicateCount(items)).toBe(0);
    });

    it('are never grouped with each other', () => {
      const items = vault(
        bookmark('gone-1', 'https://example.com/one', { deleted: true, deletedAt: NOW }),
        bookmark('gone-2', 'https://example.com/one', { deleted: true, deletedAt: NOW }),
      );
      expect(duplicateGroups(items)).toEqual([]);
    });

    it('do not stop the live copies around them from grouping', () => {
      const items = vault(
        bookmark('a', 'https://example.com/one'),
        bookmark('gone', 'https://example.com/one', { deleted: true, deletedAt: NOW }),
        bookmark('b', 'https://example.com/one'),
      );
      const groups = duplicateGroups(items);
      expect(groups).toHaveLength(1);
      expect(groups[0]?.items.map((item) => item.id)).toEqual(['a', 'b']);
    });
  });

  it('ignores folders, which have no address', () => {
    const folder: Folder = {
      id: 'f',
      type: 'folder',
      parentId: ROOT_ID,
      title: 'Reading',
      createdAt: NOW,
      updatedAt: NOW,
      order: 'a0',
      rev: 1,
    };
    const items = vault(folder, bookmark('a', 'https://example.com/one'));
    expect(duplicateGroups(items)).toEqual([]);
  });

  it('puts the copies oldest first, and the biggest group first', () => {
    const items = vault(
      bookmark('pair-new', 'https://example.com/pair', { createdAt: NOW + 5_000 }),
      bookmark('pair-old', 'https://example.com/pair', { createdAt: NOW }),
      bookmark('trio-b', 'https://example.com/trio', { createdAt: NOW + 2_000 }),
      bookmark('trio-c', 'https://example.com/trio', { createdAt: NOW + 3_000 }),
      bookmark('trio-a', 'https://example.com/trio', { createdAt: NOW + 1_000 }),
    );
    const groups = duplicateGroups(items);
    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([
      ['trio-a', 'trio-b', 'trio-c'],
      ['pair-old', 'pair-new'],
    ]);
  });

  it('orders copies saved in the same millisecond by id, so the screen does not reshuffle', () => {
    // Every bookmark from one import file carries the same `createdAt`. Without the tie-break, two
    // renders of the same vault could disagree about which row is which.
    const items = vault(
      bookmark('zeta', 'https://example.com/one'),
      bookmark('alpha', 'https://example.com/one'),
    );
    const once = duplicateGroups(items)[0]?.items.map((item) => item.id);
    expect(once).toEqual(['alpha', 'zeta']);
    expect(duplicateGroups(new Map([...items].reverse()))[0]?.items.map((item) => item.id)).toEqual(once);
  });

  it('counts addresses rather than copies', () => {
    const items = vault(
      bookmark('a1', 'https://example.com/one'),
      bookmark('a2', 'https://example.com/one'),
      bookmark('a3', 'https://example.com/one'),
      bookmark('b1', 'https://example.com/two'),
      bookmark('b2', 'https://example.com/two'),
    );
    // Five bookmarks, two addresses to look at. The sidebar says "2".
    expect(duplicateCount(items)).toBe(2);
    expect(duplicateGroups(items)).toHaveLength(2);
  });

  it('agrees with duplicateGroups, which is the only reason it may be written separately', () => {
    const items = vault(
      bookmark('a', 'https://example.com/one'),
      bookmark('b', 'https://example.com/one?utm_medium=email'),
      bookmark('c', 'https://example.com/two#a'),
      bookmark('d', 'https://example.com/two#b'),
      bookmark('e', 'https://example.com/three'),
      bookmark('gone', 'https://example.com/three', { deleted: true, deletedAt: NOW }),
    );
    expect(duplicateCount(items)).toBe(duplicateGroups(items).length);
  });

  it('takes a plain iterable as well as an item map', () => {
    const items = [bookmark('a', 'https://example.com/one'), bookmark('b', 'https://example.com/one')];
    expect(duplicateGroups(items)).toHaveLength(1);
    expect(duplicateCount(items)).toBe(1);
  });
});
