/**
 * Item builders for the merge and sync suites.
 *
 * Every field a `VaultItem` carries is filled in with something stable, so a test says only what it
 * is actually about: `bookmark('a', { title: 'Changed' })` reads as "the same bookmark with a
 * different title", which is exactly the input a 3-way merge is being asked about.
 */

import { ROOT_ID, type Bookmark, type Folder, type ItemMap, type VaultItem } from '../../src/vault/types.js';

/** A fixed epoch, so a test that cares about timestamps has to say so. */
export const T0 = 1_750_000_000_000;

export function bookmark(id: string, over: Partial<Bookmark> = {}): Bookmark {
  return {
    id,
    type: 'bookmark',
    parentId: ROOT_ID,
    title: `Bookmark ${id}`,
    url: `https://example.com/${id}`,
    createdAt: T0,
    updatedAt: T0,
    order: 'a0',
    rev: 1,
    ...over,
  };
}

export function folder(id: string, over: Partial<Folder> = {}): Folder {
  return {
    id,
    type: 'folder',
    parentId: ROOT_ID,
    title: `Folder ${id}`,
    createdAt: T0,
    updatedAt: T0,
    order: 'a0',
    rev: 1,
    ...over,
  };
}

/** A tombstone for an item, as `deleteItem` would leave it. */
export function deleted<T extends VaultItem>(item: T, at: number = T0 + 1): T {
  return { ...item, deleted: true, deletedAt: at, updatedAt: at };
}

export function itemMap(...items: readonly VaultItem[]): ItemMap {
  return new Map(items.map((item) => [item.id, item]));
}

/** Ids of the live (non-tombstoned) items, sorted — the shape most assertions want. */
export function liveIds(items: ItemMap): string[] {
  return [...items.values()]
    .filter((item) => item.deleted !== true)
    .map((item) => item.id)
    .sort();
}

/**
 * A small deterministic PRNG.
 *
 * `Math.random` in a fuzz test that has found a bug is a fuzz test that cannot show you the bug
 * again. This is seeded, so a failing iteration is reproducible from its seed alone.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}
