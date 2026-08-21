/**
 * Bookmarks that collapse to the same address (PLAN §9 Phase 16).
 *
 * Pure, like everything else in `src/vault/`: an item map in, groups out, no I/O and no `chrome.*`.
 * What it answers is a *proposal* — here are the addresses you saved more than once — and never a
 * decision. Which copy to keep is the user's, because copies differ in everything except the
 * address, and the one thing this module cannot see is why someone saved a page twice.
 *
 * ## The normal form, and why it is wider than the one at add time
 *
 * Two normalizations already existed before this file, and the phase's real work was choosing
 * between them and writing the choice down (ARCHITECTURE §3.5):
 *
 * - `duplicateKeyOf` — scheme, host, path, sorted query, fragment dropped. This is what
 *   `background/add.ts` checks a new bookmark against, and what the native-bookmark import counts
 *   with.
 * - the same, **preceded by the tracking-parameter strip**. This is what this file uses.
 *
 * So `example.com/a` and `example.com/a?utm_source=x` are one address here and two at add time,
 * while `watch?v=a` and `watch?v=b` stay two videos in both — the query is *kept*, only campaign
 * parameters come off.
 *
 * The asymmetry is deliberate and is the reason both exist. **At add time a match refuses a save**,
 * so it has to be conservative: collapsing two addresses that turn out to be different pages means
 * a bookmark the user asked for and did not get. **Here a match only draws two rows side by side**,
 * and nothing leaves the vault until a button is pressed. A false grouping costs a glance; a false
 * refusal costs a bookmark.
 *
 * The strip is applied whatever `stripTrackingParams` is set to. The setting governs what happens
 * to the *next* thing saved; a vault full of `?utm_source=` collected before it was turned on is
 * exactly the vault this screen is for.
 */

import { duplicateKeyOf, withoutTrackingParams } from './model.js';
import { isBookmark, isDeleted, type Bookmark, type ItemMap, type VaultItem } from './types.js';

/** One address, and every live bookmark that resolves to it. Always two or more. */
export interface DuplicateGroup {
  /** The normal form the copies share. Opaque to the UI — an identity, not something to display. */
  readonly key: string;
  /** Oldest first: the copy most likely to be the one with the history behind it. */
  readonly items: readonly Bookmark[];
}

/**
 * The address two bookmarks share when this screen calls them the same page.
 *
 * Unparseable input falls back to `duplicateKeyOf`'s own handling rather than throwing. A vault can
 * hold a URL that `URL` will not parse — `normalizeUrl` stores such a string verbatim by design,
 * and an import from elsewhere is the usual way one arrives — and a housekeeping screen has no
 * business being the thing that discovers it.
 */
export function duplicateKey(url: string): string {
  try {
    // The strip is skipped outright when there is no query to strip, which is most bookmarks. It
    // is the expensive half — `URLSearchParams.delete` re-serializes the URL on every call, and
    // there are twenty-three names to try — and this runs over the whole vault on every `GET_TREE`.
    return duplicateKeyOf(url.includes('?') ? withoutTrackingParams(url) : url);
  } catch {
    return duplicateKeyOf(url);
  }
}

/**
 * {@link duplicateKey}, remembered per item.
 *
 * `duplicateCount` rides on `GET_TREE`, and `GET_TREE` is re-asked by every open manager page on
 * every `VAULT_CHANGED` — so adding five thousand bookmarks one at a time with the manager open
 * re-keys the whole vault five thousand times. Measured: it more than doubled the seeding half of
 * `test/e2e/large-vault.spec.ts` and pushed the cold first paint past its budget.
 *
 * A `WeakMap` on the item is safe because **items are values**: every mutation in `model.ts` builds
 * a new object rather than writing to the old one, so an item that is still the same object still
 * has the same URL. Entries go when the item does, and the whole table goes when the vault locks
 * and the repository is dropped.
 */
const keyCache = new WeakMap<Bookmark, string>();

function keyOf(item: Bookmark): string {
  let key = keyCache.get(item);
  if (key === undefined) {
    key = duplicateKey(item.url);
    keyCache.set(item, key);
  }
  return key;
}

/**
 * Every address saved more than once, with its copies.
 *
 * **Live bookmarks only.** A tombstone is not a duplicate: it is a bookmark the user already
 * deleted, kept only so the merge engine can carry the deletion to another device (D20). Counting
 * one would offer to delete something already deleted, and — worse — would report a duplicate for a
 * single surviving bookmark whose earlier copy is gone. That is the trap `previewOf`'s `known`
 * count fell into in Phase 8, where a subset was counted against a superset and the preview
 * contradicted itself.
 *
 * Folders are skipped for a duller reason: they have no URL.
 *
 * Groups come back **largest first, then oldest first**, which puts the worst offender — the page
 * saved five times — at the top of the screen rather than wherever the item map happened to put it.
 * Within a group the copies are oldest first: nothing is pre-selected for the user, but the order
 * they are read in should still be the order they arrived in.
 */
export function duplicateGroups(items: ItemMap | Iterable<VaultItem>): DuplicateGroup[] {
  const byKey = new Map<string, Bookmark[]>();
  for (const item of liveBookmarks(items)) {
    const key = keyOf(item);
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [item]);
    else bucket.push(item);
  }

  const groups: { group: DuplicateGroup; oldest: Bookmark }[] = [];
  for (const [key, bucket] of byKey) {
    if (bucket.length < 2) continue;
    bucket.sort(byAge);
    // `bucket` has at least two entries and was just sorted, so index 0 is the oldest copy. Held
    // beside the group rather than re-indexed in the comparator, which `noUncheckedIndexedAccess`
    // would make an assertion, and an assertion is a promise a later edit can quietly break.
    const oldest = bucket[0];
    if (oldest === undefined) continue;
    groups.push({ group: { key, items: bucket }, oldest });
  }
  groups.sort((a, b) => b.group.items.length - a.group.items.length || byAge(a.oldest, b.oldest));
  return groups.map((entry) => entry.group);
}

/**
 * How many addresses are saved more than once.
 *
 * Groups, not copies: "7" means seven addresses to look at, which is the number of rows the screen
 * will show. Counting copies would say "18" for the same vault and mean something the sidebar has
 * no room to explain.
 *
 * Written out rather than `duplicateGroups(items).length`, because this one is asked for on every
 * `GET_TREE` — which is every reload of the sidebar — and a count needs neither the groups
 * assembled nor anything sorted.
 */
export function duplicateCount(items: ItemMap | Iterable<VaultItem>): number {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const item of liveBookmarks(items)) {
    const key = keyOf(item);
    if (seen.has(key)) repeated.add(key);
    else seen.add(key);
  }
  return repeated.size;
}

/**
 * Bookmarks that are still in the vault. The one filter every function here starts with.
 *
 * The guard is written out because `instanceof Map` does not narrow this union on its own: an
 * `ItemMap` is *also* an `Iterable`, of pairs rather than of items, so the false branch keeps both
 * arms and yields `[string, VaultItem]` where an item was expected.
 */
function* liveBookmarks(items: ItemMap | Iterable<VaultItem>): Iterable<Bookmark> {
  const source: Iterable<VaultItem> = isItemMap(items) ? items.values() : items;
  for (const item of source) {
    if (isDeleted(item) || !isBookmark(item)) continue;
    yield item;
  }
}

/**
 * Oldest first, `id` breaking the tie — because two bookmarks imported from the same file share a
 * timestamp to the millisecond, and a group that reshuffles between two renders is one nobody can
 * click.
 */
function byAge(a: Bookmark, b: Bookmark): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function isItemMap(items: ItemMap | Iterable<VaultItem>): items is ItemMap {
  return items instanceof Map;
}
