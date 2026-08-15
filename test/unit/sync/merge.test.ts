/**
 * The merge engine (ARCHITECTURE §6.4).
 *
 * This is the code that can lose someone's bookmarks, so it is tested by enumeration rather than by
 * example: every row of the table in §6.4 has a case here, and the four properties the spec claims
 * — no loss, idempotent, order-independent, deterministic — are asserted directly rather than
 * inferred from the rows.
 */

import { describe, expect, it } from 'vitest';

import { merge, outboundView, type Conflict, type MergeResult } from '../../../src/sync/merge.js';
import { ROOT_ID, type ItemMap, type VaultItem } from '../../../src/vault/types.js';
import {
  T0,
  bookmark,
  deleted,
  folder,
  itemMap,
  liveIds,
  seededRandom,
} from '../../helpers/items.js';

const CTX = { now: T0 + 5_000 } as const;

function run(base: ItemMap | null, local: ItemMap, remote: ItemMap): MergeResult {
  return merge(base, local, remote, CTX);
}

function item(result: MergeResult, id: string): VaultItem {
  const found = result.merged.get(id);
  if (found === undefined) throw new Error(`merged has no item ${id}`);
  return found;
}

/* ------------------------------------------------------------------ adds */

describe('adds', () => {
  it('takes an item only the local side has', () => {
    const result = run(itemMap(), itemMap(bookmark('a')), itemMap());
    expect(liveIds(result.merged)).toEqual(['a']);
    expect(result.conflicts).toEqual([]);
  });

  it('takes an item only the remote side has', () => {
    const result = run(itemMap(), itemMap(), itemMap(bookmark('b', { rev: 6 })));
    expect(liveIds(result.merged)).toEqual(['b']);
    expect(item(result, 'b').rev).toBe(6);
  });

  it('keeps both when the two sides added different ids', () => {
    const result = run(itemMap(), itemMap(bookmark('a')), itemMap(bookmark('b')));
    expect(liveIds(result.merged)).toEqual(['a', 'b']);
    expect(result.conflicts).toEqual([]);
  });

  it('takes either when the same id was added identically on both sides', () => {
    const result = run(null, itemMap(bookmark('a')), itemMap(bookmark('a')));
    expect(item(result, 'a').title).toBe('Bookmark a');
    expect(result.conflicts).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it('conflicts when the same id was added with different contents', () => {
    const result = run(
      null,
      itemMap(bookmark('a', { title: 'Mine' })),
      itemMap(bookmark('a', { title: 'Theirs' })),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.kind).toBe('add-add');
    expect(result.conflicts[0]?.fields).toEqual(['title']);
    expect(result.conflicts[0]?.base).toBeNull();
    // Provisionally this device's answer, so the vault stays usable behind the banner.
    expect(item(result, 'a').title).toBe('Mine');
  });
});

/* ------------------------------------------------------------------ edits */

describe('edits', () => {
  const base = itemMap(bookmark('a'));

  it('takes base when neither side touched the item', () => {
    const result = run(base, itemMap(bookmark('a')), itemMap(bookmark('a')));
    expect(result.changed).toEqual([]);
    expect(item(result, 'a').rev).toBe(1);
  });

  it('takes the local side when only it changed', () => {
    const result = run(base, itemMap(bookmark('a', { title: 'Mine' })), itemMap(bookmark('a')));
    expect(item(result, 'a').title).toBe('Mine');
    expect(result.conflicts).toEqual([]);
  });

  it('takes the remote side when only it changed', () => {
    const result = run(
      base,
      itemMap(bookmark('a')),
      itemMap(bookmark('a', { title: 'Theirs', rev: 9 })),
    );
    expect(item(result, 'a').title).toBe('Theirs');
    expect(item(result, 'a').rev).toBe(9);
  });

  it('merges disjoint field edits without a conflict', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { title: 'Mine' })),
      itemMap(bookmark('a', { note: 'Theirs' })),
    );
    const merged = item(result, 'a');
    expect(merged.title).toBe('Mine');
    expect(merged.type === 'bookmark' && merged.note).toBe('Theirs');
    expect(result.conflicts).toEqual([]);
  });

  it('conflicts when both sides set the same field differently', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { title: 'Mine' })),
      itemMap(bookmark('a', { title: 'Theirs' })),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.kind).toBe('field');
    expect(result.conflicts[0]?.fields).toEqual(['title']);
    expect(result.conflicts[0]?.mine.title).toBe('Mine');
    expect(result.conflicts[0]?.theirs.title).toBe('Theirs');
  });

  it('does not conflict when both sides made the same edit', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { title: 'Same' })),
      itemMap(bookmark('a', { title: 'Same' })),
    );
    expect(result.conflicts).toEqual([]);
    expect(item(result, 'a').title).toBe('Same');
  });

  it('reports every disagreeing field, not just the first', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { title: 'Mine', url: 'https://mine.example/' })),
      itemMap(bookmark('a', { title: 'Theirs', url: 'https://theirs.example/' })),
    );
    expect(result.conflicts[0]?.fields).toEqual(['title', 'url']);
  });

  it('conflicts when one side made an id a folder and the other a bookmark', () => {
    const result = run(base, itemMap(bookmark('a')), itemMap(folder('a')));
    expect(result.conflicts[0]?.fields).toEqual(['type']);
    expect(item(result, 'a').type).toBe('bookmark');
  });

  it('merges a move on one side with a rename on the other', () => {
    const withFolder = itemMap(folder('f'), bookmark('a'));
    const result = run(
      withFolder,
      itemMap(folder('f'), bookmark('a', { parentId: 'f' })),
      itemMap(folder('f'), bookmark('a', { title: 'Renamed' })),
    );
    expect(item(result, 'a').parentId).toBe('f');
    expect(item(result, 'a').title).toBe('Renamed');
    expect(result.conflicts).toEqual([]);
  });

  it('conflicts when both sides moved an item to different parents', () => {
    const withFolders = itemMap(folder('f'), folder('g'), bookmark('a'));
    const result = run(
      withFolders,
      itemMap(folder('f'), folder('g'), bookmark('a', { parentId: 'f' })),
      itemMap(folder('f'), folder('g'), bookmark('a', { parentId: 'g' })),
    );
    expect(result.conflicts[0]?.fields).toEqual(['parentId']);
    expect(item(result, 'a').parentId).toBe('f');
  });

  it('takes the earlier createdAt and the later updatedAt', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { createdAt: T0, updatedAt: T0 + 100, title: 'Mine' })),
      itemMap(bookmark('a', { createdAt: T0 - 500, updatedAt: T0 + 50 })),
    );
    expect(item(result, 'a').createdAt).toBe(T0 - 500);
    expect(item(result, 'a').updatedAt).toBe(T0 + 100);
  });
});

/* ------------------------------------------------------------------ deletes */

describe('deletes', () => {
  const base = itemMap(bookmark('a'));

  it('propagates a local delete the remote did not touch', () => {
    const result = run(base, itemMap(deleted(bookmark('a'))), itemMap(bookmark('a')));
    expect(liveIds(result.merged)).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('propagates a remote delete the local side did not touch', () => {
    const result = run(base, itemMap(bookmark('a')), itemMap(deleted(bookmark('a'))));
    expect(liveIds(result.merged)).toEqual([]);
    expect(result.merged.get('a')?.deleted).toBe(true);
  });

  it('keeps one tombstone when both sides deleted, stamped at the earlier deletion', () => {
    const result = run(
      base,
      itemMap(deleted(bookmark('a'), T0 + 900)),
      itemMap(deleted(bookmark('a'), T0 + 100)),
    );
    expect(result.merged.get('a')?.deletedAt).toBe(T0 + 100);
    expect(result.conflicts).toEqual([]);
  });

  it('conflicts when the local side edited and the remote deleted', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { title: 'Mine' })),
      itemMap(deleted(bookmark('a'))),
    );
    expect(result.conflicts[0]?.kind).toBe('edit-delete');
    // Nothing is discarded: the edit stays visible locally until someone chooses.
    expect(item(result, 'a').title).toBe('Mine');
    expect(item(result, 'a').deleted).toBeUndefined();
  });

  it('conflicts when the local side deleted and the remote edited', () => {
    const result = run(
      base,
      itemMap(deleted(bookmark('a'))),
      itemMap(bookmark('a', { title: 'Theirs' })),
    );
    expect(result.conflicts[0]?.kind).toBe('edit-delete');
    expect(item(result, 'a').deleted).toBe(true);
    expect(result.conflicts[0]?.theirs.title).toBe('Theirs');
  });

  it('does not treat opening a bookmark as an edit against a delete', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { openedAt: T0 + 10, openCount: 3 })),
      itemMap(deleted(bookmark('a'))),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.merged.get('a')?.deleted).toBe(true);
  });

  it('restores an item the local side resurrected after the base was a tombstone', () => {
    const tombstone = itemMap(deleted(bookmark('a')));
    const result = run(tombstone, itemMap(bookmark('a')), tombstone);
    expect(liveIds(result.merged)).toEqual(['a']);
  });
});

/* ------------------------------------------------------------------ purges */

describe('purges', () => {
  const base = itemMap(bookmark('a'), bookmark('b'));

  it('drops an id purged on one side and untouched on the other', () => {
    const result = run(base, itemMap(bookmark('a'), bookmark('b')), itemMap(bookmark('b')));
    expect([...result.merged.keys()]).toEqual(['b']);
    expect(result.changed.map((entry) => entry.id)).toEqual(['a']);
  });

  it('drops an id purged on both sides', () => {
    const result = run(base, itemMap(bookmark('b')), itemMap(bookmark('b')));
    expect([...result.merged.keys()]).toEqual(['b']);
  });

  it('keeps an id one side purged and the other changed — a change outranks a purge', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { title: 'Edited' }), bookmark('b')),
      itemMap(bookmark('b')),
    );
    expect(item(result, 'a').title).toBe('Edited');
  });
});

/* ------------------------------------------------------------------ tags */

describe('tags', () => {
  const base = itemMap(bookmark('a', { tags: ['keep', 'drop'] }));

  it('unions additions from both sides', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { tags: ['keep', 'drop', 'mine'] })),
      itemMap(bookmark('a', { tags: ['keep', 'drop', 'theirs'] })),
    );
    expect(tagsOfMerged(result, 'a')).toEqual(['drop', 'keep', 'mine', 'theirs']);
    expect(result.conflicts).toEqual([]);
  });

  it('honours a removal made on one side only', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { tags: ['keep'] })),
      itemMap(bookmark('a', { tags: ['keep', 'drop'] })),
    );
    expect(tagsOfMerged(result, 'a')).toEqual(['keep']);
  });

  it('applies an addition on one side and a removal on the other', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { tags: ['keep', 'drop', 'mine'] })),
      itemMap(bookmark('a', { tags: ['keep'] })),
    );
    expect(tagsOfMerged(result, 'a')).toEqual(['keep', 'mine']);
  });

  it('honours removals from both sides', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { tags: ['drop'] })),
      itemMap(bookmark('a', { tags: ['keep'] })),
    );
    expect(tagsOfMerged(result, 'a')).toEqual([]);
  });

  it('leaves identical tag lists exactly as they are, order included', () => {
    const tagged = itemMap(bookmark('a', { tags: ['zebra', 'apple'] }));
    const result = run(tagged, tagged, tagged);
    expect(tagsOfMerged(result, 'a')).toEqual(['zebra', 'apple']);
    expect(result.changed).toEqual([]);
  });

  it('keeps one side’s order when the merged set is that side’s set', () => {
    const result = run(
      itemMap(bookmark('a', { tags: ['zebra', 'apple'] })),
      itemMap(bookmark('a', { tags: ['zebra', 'apple'] })),
      itemMap(bookmark('a', { tags: ['apple'] })),
    );
    expect(tagsOfMerged(result, 'a')).toEqual(['apple']);
  });
});

function tagsOfMerged(result: MergeResult, id: string): readonly string[] {
  const merged = result.merged.get(id);
  return merged?.type === 'bookmark' ? (merged.tags ?? []) : [];
}

/* ------------------------------------------------------------------ derived fields */

describe('derived fields', () => {
  const base = itemMap(bookmark('a'));

  it('takes the maximum of openedAt and openCount, and never conflicts', () => {
    const result = run(
      base,
      itemMap(bookmark('a', { openedAt: T0 + 10, openCount: 2 })),
      itemMap(bookmark('a', { openedAt: T0 + 90, openCount: 1 })),
    );
    const merged = item(result, 'a');
    expect(merged.type === 'bookmark' && merged.openedAt).toBe(T0 + 90);
    expect(merged.type === 'bookmark' && merged.openCount).toBe(2);
    expect(result.conflicts).toEqual([]);
  });

  it('takes the newer thumbnail without asking', () => {
    const older = { sha256: 'a', w: 320, h: 168, bytes: 10, src: 'og' as const, at: T0 };
    const newer = { ...older, sha256: 'b', at: T0 + 1_000 };
    const result = run(
      base,
      itemMap(bookmark('a', { thumb: older })),
      itemMap(bookmark('a', { thumb: newer })),
    );
    const merged = item(result, 'a');
    expect(merged.type === 'bookmark' && merged.thumb?.sha256).toBe('b');
    expect(result.conflicts).toEqual([]);
  });

  it('keeps a thumbnail one side removed and the other left alone', () => {
    const thumb = { sha256: 'a', w: 320, h: 168, bytes: 10, src: 'og' as const, at: T0 };
    const withThumb = itemMap(bookmark('a', { thumb }));
    const result = run(withThumb, itemMap(bookmark('a')), withThumb);
    const merged = item(result, 'a');
    expect(merged.type === 'bookmark' && merged.thumb).toBeUndefined();
  });

  it('takes the side that changed the OG metadata', () => {
    const result = run(
      base,
      itemMap(bookmark('a')),
      itemMap(bookmark('a', { og: { title: 'From the page' } })),
    );
    const merged = item(result, 'a');
    expect(merged.type === 'bookmark' && merged.og?.title).toBe('From the page');
    expect(result.conflicts).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the tree afterwards */

describe('the tree afterwards', () => {
  it('reattaches a bookmark added into a folder the other side deleted', () => {
    const base = itemMap(folder('f'));
    const result = run(
      base,
      itemMap(folder('f'), bookmark('a', { parentId: 'f' })),
      itemMap(deleted(folder('f'))),
    );
    expect(liveIds(result.merged)).toEqual(['a']);
    expect(item(result, 'a').parentId).toBe(ROOT_ID);
  });

  it('breaks a cycle produced by two independent moves', () => {
    const base = itemMap(folder('f'), folder('g'));
    const result = run(
      base,
      itemMap(folder('f', { parentId: 'g' }), folder('g')),
      itemMap(folder('f'), folder('g', { parentId: 'f' })),
    );
    // Each side's move is legal on its own; together they are a loop no listing can reach. One
    // link is cut rather than both — the point is reachability, and detaching more than the
    // minimum would throw away a placement the user did ask for.
    expect(everythingReachesRoot(result.merged)).toBe(true);
    expect(item(result, 'f').parentId).toBe(ROOT_ID);
    expect(item(result, 'g').parentId).toBe('f');
  });

  it('leaves a well-formed tree untouched', () => {
    const tree = itemMap(folder('f'), bookmark('a', { parentId: 'f' }));
    const result = run(tree, tree, tree);
    expect(item(result, 'a').parentId).toBe('f');
    expect(result.changed).toEqual([]);
  });
});

/** Whether every live item's parent chain ends at the root — i.e. whether the tree is a tree. */
function everythingReachesRoot(items: ItemMap): boolean {
  for (const start of items.values()) {
    if (start.deleted === true) continue;
    const seen = new Set([start.id]);
    let parentId = start.parentId;
    while (parentId !== ROOT_ID) {
      const parent = items.get(parentId);
      if (parent?.type !== 'folder' || seen.has(parent.id)) return false;
      seen.add(parent.id);
      parentId = parent.parentId;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ revisions */

describe('revisions', () => {
  it('takes the higher of the two revisions, and reports only what moved', () => {
    const base = itemMap(bookmark('a', { rev: 3 }), bookmark('b', { rev: 4 }));
    const result = run(
      base,
      itemMap(bookmark('a', { rev: 3 }), bookmark('b', { rev: 4 })),
      itemMap(bookmark('a', { rev: 3 }), bookmark('b', { rev: 7, title: 'Theirs' })),
    );
    expect(item(result, 'a').rev).toBe(3);
    expect(item(result, 'b').rev).toBe(7);
    expect(result.changed.map((entry) => entry.id)).toEqual(['b']);
  });

  it('picks a revision that does not depend on which device did the merging', () => {
    // The reason `rev` is `max(local, remote)` and not the merging device's next `vaultRev`: both
    // devices have to arrive at the same bytes, and a locally-invented number never can.
    const base = itemMap(bookmark('a', { rev: 2 }));
    const mine = itemMap(bookmark('a', { rev: 4, title: 'Mine' }));
    const theirs = itemMap(bookmark('a', { rev: 9, note: 'Theirs' }));
    expect(item(run(base, mine, theirs), 'a').rev).toBe(9);
    expect(item(run(base, theirs, mine), 'a').rev).toBe(9);
  });
});

/* ------------------------------------------------------------------ the outbound view */

describe('outboundView', () => {
  it('is the item set itself when nothing is in conflict', () => {
    const items = itemMap(bookmark('a'));
    expect(outboundView(items, [])).toBe(items);
  });

  it('puts the remote side back for every unresolved conflict', () => {
    const mine = bookmark('a', { title: 'Mine' });
    const theirs = bookmark('a', { title: 'Theirs' });
    const conflict: Conflict = {
      id: 'a',
      kind: 'field',
      fields: ['title'],
      mine,
      theirs,
      base: bookmark('a'),
      detectedAt: T0,
    };
    const out = outboundView(itemMap(mine, bookmark('b')), [conflict]);
    expect(out.get('a')?.title).toBe('Theirs');
    expect(out.get('b')?.title).toBe('Bookmark b');
  });

  it('leaves an imported conflict alone — a file is not a device with an answer to protect', () => {
    // §6.5 withholds a conflicted item so a push cannot overwrite the *other device's* version.
    // Nothing holds the imported version, so substituting it would push a backup's copy of a
    // bookmark to every device — a version the user has not chosen.
    const mine = bookmark('a', { title: 'Mine' });
    const conflict: Conflict = {
      id: 'a',
      kind: 'add-add',
      fields: ['title'],
      mine,
      theirs: bookmark('a', { title: 'From the file' }),
      base: null,
      detectedAt: T0,
      origin: 'import',
    };
    expect(outboundView(itemMap(mine), [conflict]).get('a')?.title).toBe('Mine');
  });

  it('still withholds the sync conflicts when an import conflict sits beside them', () => {
    const sideBySide: Conflict[] = [
      {
        id: 'a',
        kind: 'field',
        fields: ['title'],
        mine: bookmark('a', { title: 'Mine' }),
        theirs: bookmark('a', { title: 'Theirs' }),
        base: bookmark('a'),
        detectedAt: T0,
      },
      {
        id: 'b',
        kind: 'add-add',
        fields: ['title'],
        mine: bookmark('b', { title: 'Mine' }),
        theirs: bookmark('b', { title: 'From the file' }),
        base: null,
        detectedAt: T0,
        origin: 'import',
      },
    ];
    const out = outboundView(itemMap(bookmark('a', { title: 'Mine' }), bookmark('b', { title: 'Mine' })), sideBySide);
    expect(out.get('a')?.title).toBe('Theirs');
    expect(out.get('b')?.title).toBe('Mine');
  });
});

describe('the origin of a conflict', () => {
  it('is absent for an ordinary sync merge', () => {
    const result = merge(
      itemMap(bookmark('a')),
      itemMap(bookmark('a', { title: 'Mine' })),
      itemMap(bookmark('a', { title: 'Theirs' })),
      CTX,
    );
    expect(result.conflicts[0]?.origin).toBeUndefined();
  });

  it('is stamped on every conflict a merge against a file produces', () => {
    const result = merge(
      null,
      itemMap(bookmark('a', { title: 'Mine' })),
      itemMap(bookmark('a', { title: 'From the file' })),
      { ...CTX, origin: 'import' },
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.origin).toBe('import');
  });
});

/* ------------------------------------------------------------------ the four properties */

describe('properties', () => {
  it('is idempotent: merging a vault with itself changes nothing', () => {
    const vault = itemMap(
      folder('f'),
      bookmark('a', { parentId: 'f', tags: ['zebra', 'apple'], note: 'hello' }),
      deleted(bookmark('b')),
    );
    const result = run(vault, vault, vault);
    expect(result.changed).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(sortedEntries(result.merged)).toEqual(sortedEntries(vault));
  });

  it('is order-independent apart from which side is labelled "mine"', () => {
    const random = seededRandom(20_260_731);
    for (let iteration = 0; iteration < 200; iteration++) {
      const scenario = randomScenario(random);
      const forward = run(scenario.base, scenario.local, scenario.remote);
      const backward = run(scenario.base, scenario.remote, scenario.local);

      expect(conflictIds(backward)).toEqual(conflictIds(forward));
      for (const conflict of forward.conflicts) {
        const mirrored = backward.conflicts.find((other) => other.id === conflict.id);
        expect(mirrored?.mine).toEqual(conflict.theirs);
        expect(mirrored?.theirs).toEqual(conflict.mine);
      }

      // Everything that is *not* in conflict has to come out the same both ways round; the
      // conflicted items deliberately differ, because each run provisionally keeps its own side.
      // Their descendants go with them: if the two sides disagree about where a folder lives, its
      // children are reattached differently, and that is the disagreement showing through rather
      // than a second one.
      const contested = new Set([
        ...descendantsOfAny(forward.merged, conflictIds(forward)),
        ...descendantsOfAny(backward.merged, conflictIds(backward)),
      ]);
      for (const [id, merged] of forward.merged) {
        if (contested.has(id)) continue;
        expect(backward.merged.get(id)).toEqual(merged);
      }
      expect([...backward.merged.keys()].sort()).toEqual([...forward.merged.keys()].sort());
    }
  });

  it('never loses an item that exists and is not tombstoned on either side', () => {
    const random = seededRandom(4_242);
    for (let iteration = 0; iteration < 200; iteration++) {
      const { base, local, remote } = randomScenario(random);
      const result = run(base, local, remote);
      const rescued = new Set(result.conflicts.map((conflict) => conflict.id));

      for (const source of [local, remote]) {
        for (const candidate of source.values()) {
          if (candidate.deleted === true) continue;
          const survived =
            result.merged.has(candidate.id) ||
            rescued.has(candidate.id) ||
            removedElsewhere(base, local, remote, candidate.id);
          expect(survived, `lost ${candidate.id} on iteration ${iteration}`).toBe(true);
        }
      }
    }
  });

  it('is deterministic: the same inputs give byte-identical output', () => {
    const random = seededRandom(99);
    for (let iteration = 0; iteration < 50; iteration++) {
      const { base, local, remote } = randomScenario(random);
      expect(JSON.stringify([...run(base, local, remote).merged])).toBe(
        JSON.stringify([...run(base, local, remote).merged]),
      );
    }
  });
});

function conflictIds(result: MergeResult): string[] {
  return result.conflicts.map((conflict) => conflict.id).sort();
}

/** The given ids plus everything under them, in the tree the merge produced. */
function descendantsOfAny(items: ItemMap, ids: readonly string[]): Set<string> {
  const out = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of items.values()) {
      if (out.has(candidate.id) || !out.has(candidate.parentId)) continue;
      out.add(candidate.id);
      grew = true;
    }
  }
  return out;
}

function sortedEntries(items: ItemMap): [string, VaultItem][] {
  return [...items.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * The one way an item may legitimately vanish: it was in the base, and the other side either
 * tombstoned it (a delete propagating) or dropped it entirely (a tombstone purged past its TTL).
 * Both are the item leaving on purpose rather than being lost.
 */
function removedElsewhere(
  base: ItemMap | null,
  local: ItemMap,
  remote: ItemMap,
  id: string,
): boolean {
  if (base?.get(id) === undefined) return false;
  for (const side of [local, remote]) {
    const found = side.get(id);
    if (found === undefined || found.deleted === true) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ the generator */

const IDS = ['a', 'b', 'c', 'd', 'e'];
const TITLES = ['One', 'Two', 'Three'];
const TAG_POOL = ['red', 'green', 'blue'];

/**
 * A random base and two divergent descendants of it.
 *
 * Deliberately small and dense: five ids over three titles and three tags produces collisions —
 * two devices choosing the same new title, one deleting what the other renamed — far more often
 * than a realistic vault would, which is exactly where the interesting branches are.
 */
function randomScenario(random: () => number): {
  base: ItemMap | null;
  local: ItemMap;
  remote: ItemMap;
} {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;

  const baseItems: VaultItem[] = IDS.filter(() => random() < 0.8).map((id) =>
    random() < 0.25
      ? folder(id, { title: pick(TITLES) })
      : bookmark(id, { title: pick(TITLES), tags: TAG_POOL.filter(() => random() < 0.5) }),
  );
  const base = random() < 0.15 ? null : itemMap(...baseItems);

  const diverge = (): ItemMap => {
    const items = new Map(base?.entries() ?? []);
    for (const id of IDS) {
      const roll = random();
      const existing = items.get(id);
      if (existing === undefined) {
        if (roll < 0.3) items.set(id, bookmark(id, { title: pick(TITLES) }));
        continue;
      }
      if (roll < 0.15) items.delete(id);
      else if (roll < 0.35) items.set(id, deleted(existing, T0 + Math.floor(random() * 1_000)));
      else if (roll < 0.6) {
        items.set(id, {
          ...existing,
          title: pick(TITLES),
          updatedAt: T0 + Math.floor(random() * 1_000),
        });
      } else if (roll < 0.75 && existing.type === 'bookmark') {
        items.set(id, { ...existing, tags: TAG_POOL.filter(() => random() < 0.5) });
      } else if (roll < 0.85) {
        items.set(id, { ...existing, parentId: pick([ROOT_ID, ...IDS]) });
      }
    }
    return items;
  };

  return { base, local: diverge(), remote: diverge() };
}
