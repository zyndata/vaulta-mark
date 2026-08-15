import { describe, expect, it } from 'vitest';

import { InvalidMutationError, ItemNotFoundError } from '../../../src/vault/errors.js';
import {
  addItem,
  addItems,
  allTags,
  applyMutations,
  canonicalJson,
  countsByFolder,
  deleteFolderMutations,
  deleteItem,
  descendantsOf,
  duplicateKeyOf,
  listChildren,
  moveItem,
  normalizeTags,
  normalizeUrl,
  pathOf,
  purgeTombstones,
  renameTagMutations,
  restoreItem,
  tagMutations,
  toItemMap,
  updateItem,
  type MutationContext,
} from '../../../src/vault/model.js';
import { compareOrder } from '../../../src/vault/order.js';
import {
  MAX_TAGS_PER_ITEM,
  ROOT_ID,
  TOMBSTONE_TTL_MS,
  isBookmark,
  isDeleted,
  noteOf,
  tagsOf,
  type Bookmark,
  type ItemMap,
  type VaultItem,
} from '../../../src/vault/types.js';

const NOW = 1_750_000_000_000;

/**
 * Deterministic ids, so a failure names the same item every run. `prefix` keeps a second context
 * used against an existing vault from re-minting ids the first one already handed out.
 */
function ctx(overrides: Partial<MutationContext> = {}, prefix = 'id'): MutationContext {
  let next = 0;
  return {
    now: NOW,
    rev: 2,
    newId: () => `${prefix}-${String(++next)}`,
    ...overrides,
  };
}

/** Build a small tree: root › Reading › two bookmarks, plus one bookmark at the top level. */
function sampleVault(): { items: ItemMap; ids: Record<string, string> } {
  let items: ItemMap = new Map();
  const context = ctx();
  const folder = addItem(items, { type: 'folder', title: 'Reading' }, context);
  items = folder.items;
  const alpha = addItem(
    items,
    {
      type: 'bookmark',
      url: 'https://example.org/alpha',
      title: 'Alpha paper',
      tags: ['Crypto', 'crypto ', 'Papers'],
      parentId: folder.changed[0]!.id,
    },
    context,
  );
  items = alpha.items;
  const beta = addItem(
    items,
    {
      type: 'bookmark',
      url: 'https://example.org/beta',
      title: 'Beta notes',
      note: 'Read chapter 4 first',
      parentId: folder.changed[0]!.id,
    },
    context,
  );
  items = beta.items;
  const loose = addItem(
    items,
    { type: 'bookmark', url: 'https://example.com/', title: 'Example Domain' },
    context,
  );
  items = loose.items;

  return {
    items,
    ids: {
      folder: folder.changed[0]!.id,
      alpha: alpha.changed[0]!.id,
      beta: beta.changed[0]!.id,
      loose: loose.changed[0]!.id,
    },
  };
}

describe('normalizeTags', () => {
  it('trims, folds case, collapses whitespace and dedupes', () => {
    expect(normalizeTags([' Reading ', 'reading', 'TO   READ', ''])).toEqual([
      'reading',
      'to read',
    ]);
  });

  it('caps the tag count and the tag length', () => {
    const many = Array.from({ length: 50 }, (_unused, i) => `tag${String(i)}`);
    expect(normalizeTags(many)).toHaveLength(MAX_TAGS_PER_ITEM);
    expect(normalizeTags(['x'.repeat(200)])[0]).toHaveLength(64);
  });

  it('normalizes to NFC so two encodings of one tag are one tag', () => {
    // "café" precomposed vs. decomposed — the same tag typed on two different devices.
    expect(normalizeTags(['café', 'café'])).toEqual(['café']);
  });
});

describe('normalizeUrl', () => {
  it('lowercases the scheme and host and drops the default port', () => {
    expect(normalizeUrl('  HTTPS://Example.COM:443/Path?q=1#frag  ')).toBe(
      'https://example.com/Path?q=1#frag',
    );
  });

  it('keeps the query and the fragment', () => {
    expect(normalizeUrl('https://example.com/a?b=c#d')).toContain('#d');
    expect(normalizeUrl('https://example.com/a?b=c#d')).toContain('b=c');
  });

  it('stores an unparseable value verbatim rather than losing it', () => {
    expect(normalizeUrl('  not a url  ')).toBe('not a url');
  });
});

describe('duplicateKeyOf', () => {
  it('ignores the fragment and the query order', () => {
    expect(duplicateKeyOf('https://example.com/a?b=1&a=2#x')).toBe(
      duplicateKeyOf('https://example.com/a?a=2&b=1'),
    );
  });

  it('treats a bare origin with and without a trailing slash as one page', () => {
    expect(duplicateKeyOf('https://example.com/')).toBe(duplicateKeyOf('https://example.com'));
  });

  it('falls back to a folded literal for an unparseable URL', () => {
    expect(duplicateKeyOf(' Weird Thing ')).toBe('weird thing');
  });
});

describe('addItem', () => {
  it('appends after the last live sibling', () => {
    const { items, ids } = sampleVault();
    const children = listChildren(items, ids.folder!);
    expect(children.map((item) => item.title)).toEqual(['Alpha paper', 'Beta notes']);
    expect(compareOrder(children[0]!.order, children[1]!.order)).toBe(-1);
  });

  it('normalizes tags and omits empty optional fields', () => {
    const { items, ids } = sampleVault();
    const alpha = items.get(ids.alpha!) as Bookmark;
    expect(alpha.tags).toEqual(['crypto', 'papers']);
    expect('note' in alpha).toBe(false);
    expect(noteOf(alpha)).toBe('');
  });

  it('rejects an unknown parent', () => {
    expect(() =>
      addItem(new Map(), { type: 'bookmark', url: 'https://x.test/', parentId: 'nope' }, ctx()),
    ).toThrow(ItemNotFoundError);
  });

  it('rejects a bookmark used as a parent', () => {
    const { items, ids } = sampleVault();
    expect(() =>
      addItem(items, { type: 'folder', title: 'Nested', parentId: ids.loose! }, ctx()),
    ).toThrow(InvalidMutationError);
  });

  it('rejects a duplicate id', () => {
    const { items, ids } = sampleVault();
    expect(() =>
      addItem(items, { type: 'bookmark', url: 'https://x.test/', id: ids.alpha! }, ctx()),
    ).toThrow(InvalidMutationError);
  });

  it('rejects a deleted folder as a parent', () => {
    const { items, ids } = sampleVault();
    const after = deleteItem(items, ids.folder!, ctx()).items;
    expect(() =>
      addItem(after, { type: 'bookmark', url: 'https://x.test/', parentId: ids.folder! }, ctx()),
    ).toThrow(InvalidMutationError);
  });
});

describe('addItems', () => {
  it('appends a whole tree in one pass, parents before children', () => {
    const { items, changed } = addItems(
      new Map(),
      [
        { type: 'folder', title: 'Work', id: 'f1' },
        { type: 'bookmark', url: 'https://a.test/', title: 'A', parentId: 'f1' },
        { type: 'bookmark', url: 'https://b.test/', title: 'B', parentId: 'f1' },
      ],
      ctx(),
    );

    expect(changed).toHaveLength(3);
    const children = listChildren(items, 'f1');
    expect(children.map((item) => item.title)).toEqual(['A', 'B']);
    expect(compareOrder(children[0]!.order, children[1]!.order)).toBe(-1);
  });

  it('appends after the items already there', () => {
    const { items, ids } = sampleVault();
    const after = addItems(
      items,
      [{ type: 'bookmark', url: 'https://c.test/', title: 'Gamma', parentId: ids.folder! }],
      ctx({}, 'bulk'),
    ).items;
    expect(listChildren(after, ids.folder!).map((item) => item.title)).toEqual([
      'Alpha paper',
      'Beta notes',
      'Gamma',
    ]);
  });

  it('produces the same result as adding them one at a time', () => {
    // The fast path has to agree with the slow one, or an import produces a subtly different tree
    // from the same bookmarks added by hand.
    const inputs = [
      { type: 'folder' as const, title: 'Work', id: 'f1' },
      { type: 'bookmark' as const, url: 'https://a.test/', title: 'A', parentId: 'f1', id: 'b1' },
      { type: 'bookmark' as const, url: 'https://b.test/', title: 'B', parentId: 'f1', id: 'b2' },
      { type: 'bookmark' as const, url: 'https://c.test/', title: 'C', id: 'b3' },
    ];
    const bulk = addItems(new Map(), inputs, ctx()).items;
    const oneByOne = applyMutations(
      new Map(),
      inputs.map((input) => ({ kind: 'add' as const, input })),
      ctx(),
    ).items;
    expect(canonicalJson([...bulk.values()])).toBe(canonicalJson([...oneByOne.values()]));
  });

  it('rejects the whole batch when any one of it is invalid', () => {
    const before = sampleVault().items;
    expect(() =>
      addItems(
        before,
        [
          { type: 'bookmark', url: 'https://a.test/', title: 'A' },
          { type: 'bookmark', url: 'https://b.test/', title: 'B', parentId: 'nowhere' },
        ],
        ctx({}, 'bulk'),
      ),
    ).toThrow(ItemNotFoundError);
  });

  it('rejects a duplicate id inside the batch', () => {
    expect(() =>
      addItems(
        new Map(),
        [
          { type: 'bookmark', url: 'https://a.test/', title: 'A', id: 'same' },
          { type: 'bookmark', url: 'https://b.test/', title: 'B', id: 'same' },
        ],
        ctx(),
      ),
    ).toThrow(InvalidMutationError);
  });

  it('rejects a bookmark used as a parent', () => {
    const { items, ids } = sampleVault();
    expect(() =>
      addItems(
        items,
        [{ type: 'bookmark', url: 'https://a.test/', title: 'A', parentId: ids.alpha! }],
        ctx({}, 'bulk'),
      ),
    ).toThrow(InvalidMutationError);
  });

  it('changes nothing for an empty batch', () => {
    const { items } = sampleVault();
    const result = addItems(items, [], ctx());
    expect(result.items).toBe(items);
    expect(result.changed).toEqual([]);
  });

  it('ignores tombstones when it works out where to append', () => {
    const { items, ids } = sampleVault();
    const withTombstone = deleteItem(items, ids.beta!, ctx()).items;
    const after = addItems(
      withTombstone,
      [{ type: 'bookmark', url: 'https://c.test/', title: 'Gamma', parentId: ids.folder! }],
      ctx({}, 'bulk'),
    ).items;
    expect(listChildren(after, ids.folder!).map((item) => item.title)).toEqual([
      'Alpha paper',
      'Gamma',
    ]);
  });

  it('is reachable as a mutation, so a whole import is one batch', () => {
    const result = applyMutations(
      new Map(),
      [
        {
          kind: 'addMany',
          inputs: [
            { type: 'folder', title: 'Work', id: 'f1' },
            { type: 'bookmark', url: 'https://a.test/', title: 'A', parentId: 'f1' },
          ],
        },
      ],
      ctx(),
    );
    expect(result.changed).toHaveLength(2);
    expect(result.changed.every((item) => item.rev === 2)).toBe(true);
  });
});

describe('updateItem', () => {
  it('changes only the named fields and stamps the revision', () => {
    const { items, ids } = sampleVault();
    const result = updateItem(items, ids.alpha!, { title: '  Renamed  ' }, ctx({ rev: 9 }));
    const alpha = result.items.get(ids.alpha!) as Bookmark;
    expect(alpha.title).toBe('Renamed');
    expect(alpha.url).toBe('https://example.org/alpha');
    expect(alpha.rev).toBe(9);
    expect(result.changed).toHaveLength(1);
  });

  it('clears an optional field when the patch says null', () => {
    const { items, ids } = sampleVault();
    const result = updateItem(items, ids.beta!, { note: null, tags: null }, ctx());
    const beta = result.items.get(ids.beta!) as Bookmark;
    expect('note' in beta).toBe(false);
    expect(tagsOf(beta)).toEqual([]);
  });

  it('treats an empty note the same as no note', () => {
    const { items, ids } = sampleVault();
    const beta = updateItem(items, ids.beta!, { note: '   ' }, ctx()).items.get(ids.beta!)!;
    // Whitespace is content — only a genuinely empty string clears the field.
    expect(noteOf(beta)).toBe('   ');
    const cleared = updateItem(items, ids.beta!, { note: '' }, ctx()).items.get(ids.beta!)!;
    expect('note' in cleared).toBe(false);
  });

  it('reports no change for an edit that changes nothing', () => {
    const { items, ids } = sampleVault();
    const result = updateItem(items, ids.alpha!, { title: 'Alpha paper' }, ctx({ rev: 99 }));
    expect(result.changed).toEqual([]);
    expect(result.items).toBe(items);
    expect(result.items.get(ids.alpha!)!.rev).toBe(2);
  });

  it('refuses bookmark-only fields on a folder', () => {
    const { items, ids } = sampleVault();
    expect(() => updateItem(items, ids.folder!, { url: 'https://x.test/' }, ctx())).toThrow(
      InvalidMutationError,
    );
  });

  it('refuses to edit a tombstone', () => {
    const { items, ids } = sampleVault();
    const after = deleteItem(items, ids.alpha!, ctx()).items;
    expect(() => updateItem(after, ids.alpha!, { title: 'x' }, ctx())).toThrow(
      InvalidMutationError,
    );
  });

  it('raises ItemNotFoundError for an unknown id', () => {
    expect(() => updateItem(new Map(), 'nope', { title: 'x' }, ctx())).toThrow(ItemNotFoundError);
  });
});

describe('deleteItem', () => {
  it('tombstones rather than removing, so a stale peer cannot resurrect the item', () => {
    const { items, ids } = sampleVault();
    const result = deleteItem(items, ids.loose!, ctx());
    const loose = result.items.get(ids.loose!)!;
    expect(isDeleted(loose)).toBe(true);
    expect(loose.deletedAt).toBe(NOW);
    expect(result.items.size).toBe(items.size);
  });

  it('takes the whole subtree with a folder', () => {
    const { items, ids } = sampleVault();
    const result = deleteItem(items, ids.folder!, ctx());
    expect(result.changed.map((item) => item.id).toSorted()).toEqual(
      [ids.folder!, ids.alpha!, ids.beta!].toSorted(),
    );
    expect(listChildren(result.items, ROOT_ID).map((item) => item.id)).toEqual([ids.loose!]);
  });

  it('is idempotent', () => {
    const { items, ids } = sampleVault();
    const once = deleteItem(items, ids.loose!, ctx());
    const twice = deleteItem(once.items, ids.loose!, ctx());
    expect(twice.changed).toEqual([]);
    expect(twice.items).toBe(once.items);
  });
});

describe('restoreItem', () => {
  it('lifts the tombstone under the same id, so an undo stays one bookmark', () => {
    const { items, ids } = sampleVault();
    const deleted = deleteItem(items, ids.loose!, ctx());
    const restored = restoreItem(deleted.items, ids.loose!, ctx({ rev: 9 }));

    const loose = restored.items.get(ids.loose!)!;
    expect(isDeleted(loose)).toBe(false);
    expect(loose.deletedAt).toBe(undefined);
    expect(loose.rev).toBe(9);
    expect(restored.items.size).toBe(items.size);
    expect(listChildren(restored.items, ROOT_ID).map((item) => item.id).toSorted()).toEqual(
      [ids.folder!, ids.loose!].toSorted(),
    );
  });

  it('brings back the subtree that went down with a folder, and nothing else', () => {
    const { items, ids } = sampleVault();
    // Alpha is deleted on its own first: undoing the folder's delete must not resurrect it.
    const alphaGone = deleteItem(items, ids.alpha!, ctx({ now: NOW - 60_000 }));
    const folderGone = deleteItem(alphaGone.items, ids.folder!, ctx());
    const restored = restoreItem(folderGone.items, ids.folder!, ctx());

    expect(restored.changed.map((item) => item.id).toSorted()).toEqual(
      [ids.folder!, ids.beta!].toSorted(),
    );
    expect(isDeleted(restored.items.get(ids.alpha!)!)).toBe(true);
  });

  it('brings an orphan back at the top level rather than under a tombstone', () => {
    const { items, ids } = sampleVault();
    // Alpha alone is deleted, then its folder — so restoring alpha finds a deleted parent.
    const alphaGone = deleteItem(items, ids.alpha!, ctx({ now: NOW - 60_000 }));
    const folderGone = deleteItem(alphaGone.items, ids.folder!, ctx());
    const restored = restoreItem(folderGone.items, ids.alpha!, ctx());

    expect(restored.items.get(ids.alpha!)!.parentId).toBe(ROOT_ID);
    expect(listChildren(restored.items, ROOT_ID).map((item) => item.id).toSorted()).toEqual(
      [ids.alpha!, ids.loose!].toSorted(),
    );
  });

  it('does nothing to an item that is not deleted', () => {
    const { items, ids } = sampleVault();
    const result = restoreItem(items, ids.loose!, ctx());
    expect(result.changed).toEqual([]);
    expect(result.items).toBe(items);
  });

  it('refuses an id that is not in the vault', () => {
    expect(() => restoreItem(sampleVault().items, 'nope', ctx())).toThrow(ItemNotFoundError);
  });
});

describe('moveItem', () => {
  it('appends to the new parent and touches only the moved item', () => {
    const { items, ids } = sampleVault();
    const result = moveItem(items, ids.loose!, ids.folder!, undefined, ctx({ rev: 7 }));
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]!.id).toBe(ids.loose!);
    expect(listChildren(result.items, ids.folder!).map((item) => item.id)).toEqual([
      ids.alpha!,
      ids.beta!,
      ids.loose!,
    ]);
    expect(result.items.get(ids.alpha!)).toBe(items.get(ids.alpha!));
  });

  it('places an item first when afterId is null', () => {
    const { items, ids } = sampleVault();
    const result = moveItem(items, ids.beta!, ids.folder!, null, ctx());
    expect(listChildren(result.items, ids.folder!).map((item) => item.id)).toEqual([
      ids.beta!,
      ids.alpha!,
    ]);
  });

  it('places an item after a named sibling', () => {
    const { items, ids } = sampleVault();
    const moved = moveItem(items, ids.loose!, ids.folder!, ids.alpha, ctx());
    expect(listChildren(moved.items, ids.folder!).map((item) => item.id)).toEqual([
      ids.alpha!,
      ids.loose!,
      ids.beta!,
    ]);
  });

  it('refuses to move a folder inside itself', () => {
    const { items, ids } = sampleVault();
    expect(() => moveItem(items, ids.folder!, ids.folder!, undefined, ctx())).toThrow(
      InvalidMutationError,
    );
    const nested = addItem(
      items,
      { type: 'folder', title: 'Inner', parentId: ids.folder! },
      ctx({}, 'nested'),
    );
    expect(() =>
      moveItem(nested.items, ids.folder!, nested.changed[0]!.id, undefined, ctx()),
    ).toThrow(InvalidMutationError);
  });

  it('refuses an afterId that is not a live sibling', () => {
    const { items, ids } = sampleVault();
    expect(() => moveItem(items, ids.loose!, ids.folder!, 'nope', ctx())).toThrow(
      InvalidMutationError,
    );
  });

  it('refuses to move a tombstone', () => {
    const { items, ids } = sampleVault();
    const after = deleteItem(items, ids.loose!, ctx()).items;
    expect(() => moveItem(after, ids.loose!, ids.folder!, undefined, ctx())).toThrow(
      InvalidMutationError,
    );
  });

  it('reports no change when the item is already where it is asked to go', () => {
    const { items, ids } = sampleVault();
    const result = moveItem(items, ids.beta!, ids.folder!, ids.alpha, ctx());
    expect(result.changed).toEqual([]);
  });
});

describe('applyMutations', () => {
  it('folds a batch, letting later mutations see earlier ones', () => {
    const context = ctx();
    const result = applyMutations(
      new Map(),
      [
        { kind: 'add', input: { type: 'folder', title: 'Inbox' } },
        { kind: 'add', input: { type: 'bookmark', url: 'https://x.test/', parentId: 'id-1' } },
        { kind: 'update', id: 'id-2', patch: { title: 'Renamed' } },
      ],
      context,
    );
    expect(result.items.size).toBe(2);
    // id-2 was added and then renamed inside one batch: it appears once in `changed`, at its
    // final value, because a bucket is written once per commit however many times it was touched.
    expect(result.changed).toHaveLength(2);
    expect(result.changed.find((item) => item.id === 'id-2')!.title).toBe('Renamed');
  });
});

describe('purgeTombstones', () => {
  it('drops tombstones past the TTL and keeps the rest', () => {
    const { items, ids } = sampleVault();
    const deleted = deleteItem(items, ids.loose!, ctx()).items;
    expect(purgeTombstones(deleted, NOW + TOMBSTONE_TTL_MS - 1).purged).toEqual([]);
    const purged = purgeTombstones(deleted, NOW + TOMBSTONE_TTL_MS + 1);
    expect(purged.purged).toEqual([ids.loose!]);
    expect(purged.items.has(ids.loose!)).toBe(false);
    expect(purged.items.size).toBe(items.size - 1);
  });
});

describe('queries', () => {
  it('lists children in order, tombstones excluded', () => {
    const { items, ids } = sampleVault();
    const deleted = deleteItem(items, ids.alpha!, ctx()).items;
    expect(listChildren(deleted, ids.folder!).map((item) => item.id)).toEqual([ids.beta!]);
  });

  it('walks the path from the top level down to the item', () => {
    const { items, ids } = sampleVault();
    expect(pathOf(items, ids.alpha!).map((item) => item.title)).toEqual(['Reading', 'Alpha paper']);
    expect(pathOf(items, ids.loose!).map((item) => item.id)).toEqual([ids.loose!]);
  });

  it('truncates rather than looping on a parent cycle', () => {
    // A merge of two divergent moves can produce this; the UI must still render.
    const { items, ids } = sampleVault();
    const cyclic = new Map(items);
    cyclic.set(ids.folder!, { ...items.get(ids.folder!)!, parentId: ids.alpha! });
    expect(pathOf(cyclic, ids.alpha!).length).toBeLessThanOrEqual(cyclic.size);
  });

  it('counts direct children and descendant bookmarks per folder', () => {
    const { items, ids } = sampleVault();
    const counts = countsByFolder(items);
    // `direct` is what sits immediately under the folder; `descendants` is every bookmark in the
    // subtree, which for the root is the whole vault.
    expect(counts.get(ROOT_ID)).toEqual({ direct: 2, descendants: 3 });
    expect(counts.get(ids.folder!)).toEqual({ direct: 2, descendants: 2 });
  });

  it('counts nested folders into the ancestor total', () => {
    const { items, ids } = sampleVault();
    const nested = addItem(
      items,
      { type: 'folder', title: 'Inner', parentId: ids.folder! },
      ctx({}, 'nested'),
    );
    const withChild = addItem(
      nested.items,
      { type: 'bookmark', url: 'https://x.test/', parentId: nested.changed[0]!.id },
      ctx({}, 'child'),
    ).items;
    expect(countsByFolder(withChild).get(ids.folder!)).toEqual({ direct: 3, descendants: 3 });
  });

  it('lists tags by frequency, ties alphabetical', () => {
    const { items, ids } = sampleVault();
    const tagged = updateItem(items, ids.beta!, { tags: ['papers', 'zeta'] }, ctx()).items;
    expect(allTags(tagged)).toEqual([
      { tag: 'papers', count: 2 },
      { tag: 'crypto', count: 1 },
      { tag: 'zeta', count: 1 },
    ]);
  });

  it('excludes tombstoned items from tag counts', () => {
    const { items, ids } = sampleVault();
    const deleted = deleteItem(items, ids.alpha!, ctx()).items;
    expect(allTags(deleted)).toEqual([]);
  });

  it('finds every descendant, tombstones included', () => {
    const { items, ids } = sampleVault();
    const deleted = deleteItem(items, ids.alpha!, ctx()).items;
    expect(
      descendantsOf(deleted, ids.folder!)
        .map((item) => item.id)
        .toSorted(),
    ).toEqual([ids.alpha!, ids.beta!].toSorted());
  });
});

describe('toItemMap', () => {
  it('keys items by id', () => {
    const items: VaultItem[] = [...sampleVault().items.values()];
    const map = toItemMap(items);
    expect(map.size).toBe(items.length);
    expect(map.get(items[0]!.id)).toBe(items[0]);
  });
});

describe('canonicalJson', () => {
  it('emits object keys in sorted order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJson({ items: [2, 1] })).toBe('{"items":[2,1]}');
  });

  it('is stable across two spellings of the same item', () => {
    const { items, ids } = sampleVault();
    const alpha = items.get(ids.alpha!)!;
    const reordered = Object.fromEntries(Object.entries(alpha).toReversed());
    expect(canonicalJson(reordered)).toBe(canonicalJson(alpha));
  });
});

describe('tagMutations', () => {
  it('adds a tag to every named bookmark, normalized', () => {
    const { items, ids } = sampleVault();
    const mutations = tagMutations(items, [ids.alpha!, ids.loose!], { add: ['  Reading LIST '] });
    const applied = applyMutations(items, mutations, ctx({}, 'tag'));
    expect(tagsOf(applied.items.get(ids.alpha!)!)).toEqual(['crypto', 'papers', 'reading list']);
    expect(tagsOf(applied.items.get(ids.loose!)!)).toEqual(['reading list']);
  });

  it('removes a tag, and clears the field when the last one goes', () => {
    const { items, ids } = sampleVault();
    const mutations = tagMutations(items, [ids.alpha!], { remove: ['Crypto', 'papers'] });
    const applied = applyMutations(items, mutations, ctx({}, 'tag'));
    const alpha = applied.items.get(ids.alpha!)! as Bookmark;
    expect(tagsOf(alpha)).toEqual([]);
    // Cleared rather than stored as `[]`: an empty array costs real bytes in every bucket.
    expect('tags' in alpha).toBe(false);
  });

  it('lets a removal win over an addition of the same tag', () => {
    const { items, ids } = sampleVault();
    const mutations = tagMutations(items, [ids.loose!], { add: ['x'], remove: ['x'] });
    expect(mutations).toEqual([]);
  });

  it('emits nothing for items that would not change', () => {
    const { items, ids } = sampleVault();
    // `alpha` already carries `crypto`; `beta` does not.
    const mutations = tagMutations(items, [ids.alpha!, ids.beta!], { add: ['crypto'] });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ kind: 'update', id: ids.beta });
  });

  it('skips folders, tombstones, unknown ids and duplicate ids', () => {
    const { items, ids } = sampleVault();
    const deleted = deleteItem(items, ids.beta!, ctx({}, 'del')).items;
    const mutations = tagMutations(
      deleted,
      [ids.folder!, ids.beta!, 'nope', ids.loose!, ids.loose!],
      { add: ['x'] },
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ id: ids.loose });
  });

  it('emits nothing when the change itself is empty', () => {
    const { items, ids } = sampleVault();
    expect(tagMutations(items, [ids.alpha!], {})).toEqual([]);
    expect(tagMutations(items, [ids.alpha!], { add: ['  '], remove: [] })).toEqual([]);
  });
});

describe('renameTagMutations', () => {
  it('renames the tag on every bookmark that carries it, keeping its position', () => {
    const { items, ids } = sampleVault();
    const withBoth = applyMutations(
      items,
      tagMutations(items, [ids.beta!], { add: ['crypto'] }),
      ctx({}, 'seed'),
    ).items;

    const applied = applyMutations(
      withBoth,
      renameTagMutations(withBoth, 'Crypto', 'Cryptography'),
      ctx({}, 'ren'),
    );
    expect(tagsOf(applied.items.get(ids.alpha!)!)).toEqual(['cryptography', 'papers']);
    expect(tagsOf(applied.items.get(ids.beta!)!)).toEqual(['cryptography']);
  });

  it('folds into an existing occurrence instead of duplicating it', () => {
    const { items, ids } = sampleVault();
    const applied = applyMutations(
      items,
      renameTagMutations(items, 'crypto', 'papers'),
      ctx({}, 'ren'),
    );
    expect(tagsOf(applied.items.get(ids.alpha!)!)).toEqual(['papers']);
  });

  it('touches nothing when the tag is unused, or when both names fold to the same tag', () => {
    const { items } = sampleVault();
    expect(renameTagMutations(items, 'unused', 'other')).toEqual([]);
    expect(renameTagMutations(items, 'crypto', ' CRYPTO ')).toEqual([]);
  });

  it('refuses a rename with an empty side rather than deleting the tag', () => {
    const { items } = sampleVault();
    expect(() => renameTagMutations(items, 'crypto', '   ')).toThrow(InvalidMutationError);
    expect(() => renameTagMutations(items, '', 'crypto')).toThrow(InvalidMutationError);
  });

  it('leaves tombstoned items alone', () => {
    const { items, ids } = sampleVault();
    const deleted = deleteItem(items, ids.alpha!, ctx({}, 'del')).items;
    expect(renameTagMutations(deleted, 'crypto', 'cryptography')).toEqual([]);
  });
});

describe('deleteFolderMutations', () => {
  it('recursively tombstones the folder and everything under it', () => {
    const { items, ids } = sampleVault();
    const applied = applyMutations(
      items,
      deleteFolderMutations(items, ids.folder!, 'recursive'),
      ctx({}, 'del'),
    );
    expect(isDeleted(applied.items.get(ids.folder!)!)).toBe(true);
    expect(isDeleted(applied.items.get(ids.alpha!)!)).toBe(true);
    expect(isDeleted(applied.items.get(ids.beta!)!)).toBe(true);
  });

  it('lifts the children to the folder’s parent and deletes only the folder', () => {
    const { items, ids } = sampleVault();
    const applied = applyMutations(
      items,
      deleteFolderMutations(items, ids.folder!, 'reparent'),
      ctx({}, 'del'),
    );
    expect(isDeleted(applied.items.get(ids.folder!)!)).toBe(true);
    expect(isDeleted(applied.items.get(ids.alpha!)!)).toBe(false);
    expect(applied.items.get(ids.alpha!)!.parentId).toBe(ROOT_ID);
    expect(applied.items.get(ids.beta!)!.parentId).toBe(ROOT_ID);
  });

  it('reparents into a nested folder’s own parent, not into the root', () => {
    const { items, ids } = sampleVault();
    const context = ctx({}, 'nest');
    const inner = addItem(
      items,
      { type: 'folder', title: 'Inner', parentId: ids.folder! },
      context,
    );
    const moved = moveItem(inner.items, ids.alpha!, inner.changed[0]!.id, undefined, context);
    const applied = applyMutations(
      moved.items,
      deleteFolderMutations(moved.items, inner.changed[0]!.id, 'reparent'),
      ctx({}, 'del'),
    );
    expect(applied.items.get(ids.alpha!)!.parentId).toBe(ids.folder);
  });

  it('moves only the direct children — deeper items travel with their own parent', () => {
    const { items, ids } = sampleVault();
    const context = ctx({}, 'nest');
    const inner = addItem(items, { type: 'folder', title: 'Inner', parentId: ids.folder! }, context);
    const innerId = inner.changed[0]!.id;
    const moved = moveItem(inner.items, ids.alpha!, innerId, undefined, context);

    const mutations = deleteFolderMutations(moved.items, ids.folder!, 'reparent');
    const applied = applyMutations(moved.items, mutations, ctx({}, 'del'));
    expect(applied.items.get(innerId)!.parentId).toBe(ROOT_ID);
    // Still inside `Inner`, which simply lives somewhere else now.
    expect(applied.items.get(ids.alpha!)!.parentId).toBe(innerId);
  });

  it('refuses to treat a bookmark as a folder, and an unknown id as anything', () => {
    const { items, ids } = sampleVault();
    expect(() => deleteFolderMutations(items, ids.loose!, 'recursive')).toThrow(
      InvalidMutationError,
    );
    expect(() => deleteFolderMutations(items, 'nope', 'reparent')).toThrow(ItemNotFoundError);
  });
});

describe('type guards', () => {
  it('separates bookmarks from folders', () => {
    const { items, ids } = sampleVault();
    expect(isBookmark(items.get(ids.alpha!)!)).toBe(true);
    expect(isBookmark(items.get(ids.folder!)!)).toBe(false);
    expect(tagsOf(items.get(ids.folder!)!)).toEqual([]);
    expect(noteOf(items.get(ids.folder!)!)).toBe('');
  });
});
