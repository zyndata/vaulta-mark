/**
 * The 3-way merge engine (ARCHITECTURE §6.4) — pure, provider-agnostic, and the one place in the
 * project where two divergent vaults become one.
 *
 * `merge(base, local, remote, ctx)` is a function of three item maps and nothing else. It does no
 * I/O, holds no key, and knows neither which backend the remote came from nor what a bucket is.
 * That is deliberate: this is the code that can lose someone's bookmarks, so it has to be testable
 * exhaustively, and every input it could depend on has to be an argument.
 *
 * Four rules shape everything below.
 *
 * - **Nothing is decided from a wall clock.** `updatedAt` breaks a tie in the UI ("which looks
 *   newer") and is merged as a `max`, but no branch here reads it to choose a winner. Every decision
 *   comes from comparing the two sides against the base. Two devices whose clocks disagree by an
 *   hour still converge.
 * - **Nothing is discarded silently.** A field both sides changed to different values is a
 *   {@link Conflict}, not a race. The merged vault provisionally shows the **local** side so the
 *   user keeps working, and both versions are carried in the conflict record until someone chooses
 *   (§6.5).
 * - **`tags` merge as a set union, minus removals.** A deliberate, documented bias toward keeping
 *   data: a tag added on one device and untouched on the other survives, and never produces a
 *   prompt. Removing a tag still removes it, because the removal is measured against the base.
 * - **Derived fields never conflict.** A thumbnail and the OG metadata are things VaultaMark
 *   computed from a page, not things a person typed. Asking a user to adjudicate two versions of a
 *   preview image would be noise.
 *
 * The result is deterministic and order-independent: `merge(b, l, r)` and `merge(b, r, l)` agree on
 * every item that is not conflicted, and produce the same conflicts with `mine` and `theirs`
 * swapped. It is also idempotent — `merge(m, m, m)` returns `m`, changes nothing, and therefore
 * costs no bucket write.
 */

import { canonicalJson } from '../vault/model.js';
import {
  ROOT_ID,
  isBookmark,
  isDeleted,
  noteOf,
  tagsOf,
  type Bookmark,
  type Folder,
  type ItemMap,
  type ThumbMeta,
  type VaultItem,
} from '../vault/types.js';

/** The scalar fields a person edits, and therefore the ones that can disagree irreconcilably. */
export type ScalarField = 'title' | 'url' | 'note' | 'parentId' | 'order';

/**
 * What a conflict is about.
 *
 * `type` is in here for completeness rather than because it is expected: an id that is a bookmark
 * on one device and a folder on the other can only come from an import that reused an id, and there
 * is no field-wise merge of the two that means anything.
 */
export type ConflictField = ScalarField | 'type';

export type ConflictKind =
  /** Both sides edited the same field to different values. */
  | 'field'
  /** One side edited the item, the other deleted it. Never resolved by discarding the edit. */
  | 'edit-delete'
  /** The same id was created on both sides with different contents. Only possible after an import. */
  | 'add-add';

/**
 * One unresolved disagreement, carrying both versions in full.
 *
 * Both sides are whole items rather than field pairs, because "keep theirs" has to be able to
 * reconstruct their version exactly, and because a conflict may outlive several further edits to
 * the rest of the vault before anyone looks at it.
 */
export interface Conflict {
  readonly id: string;
  readonly kind: ConflictKind;
  /** The fields that disagree. Empty for `edit-delete`, where the whole item is the disagreement. */
  readonly fields: readonly ConflictField[];
  /** This device's version — the one the merged vault provisionally holds. */
  readonly mine: VaultItem;
  /** The other device's version. Left untouched on the remote until this is resolved. */
  readonly theirs: VaultItem;
  /** The last version both sides agreed on, or `null` for an `add-add`. */
  readonly base: VaultItem | null;
  readonly detectedAt: number;
  /** `deviceId` from the remote header. A label for the UI; never an input to a merge decision. */
  readonly remoteDevice?: string;
  /**
   * Where the other side came from. Absent means a sync peer; `'import'` means a `.vmv` file.
   *
   * It changes nothing about how the conflict is merged or shown, and exactly one thing about what
   * is pushed — see {@link outboundView}.
   */
  readonly origin?: 'import';
}

export interface MergeContext {
  /** Epoch ms, stamped on conflict records. Deliberately not consulted by any merge rule. */
  readonly now: number;
  readonly remoteDevice?: string;
  /** Stamped onto every conflict this merge produces. See {@link Conflict.origin}. */
  readonly origin?: 'import';
}

export interface MergeResult {
  readonly merged: ItemMap;
  /** Sorted by id, so two devices that reached the same state show the same list. */
  readonly conflicts: readonly Conflict[];
  /** Items whose merged form differs from `local`'s — the buckets a commit has to rewrite. */
  readonly changed: readonly VaultItem[];
}

/**
 * Merge `remote` into `local` against their last common ancestor.
 *
 * `base` is `null` on a first sync, where there is no common ancestor: every id that exists on only
 * one side is an add, and every id that exists on both is an `add-add` unless the two agree.
 */
export function merge(
  base: ItemMap | null,
  local: ItemMap,
  remote: ItemMap,
  ctx: MergeContext,
): MergeResult {
  const ids = [...new Set([...(base?.keys() ?? []), ...local.keys(), ...remote.keys()])].sort();

  const merged = new Map<string, VaultItem>();
  const conflicts: Conflict[] = [];

  for (const id of ids) {
    const outcome = mergeOne(base?.get(id), local.get(id), remote.get(id), ctx);
    if (outcome.item !== null) merged.set(id, outcome.item);
    if (outcome.conflict !== null) conflicts.push(outcome.conflict);
  }

  reattachOrphans(merged);

  const changed: VaultItem[] = [];
  for (const [id, item] of merged) {
    if (canonicalJson(local.get(id) ?? null) !== canonicalJson(item)) changed.push(item);
  }
  // An id that vanished (purged on both sides, or purged on one and untouched on the other) is a
  // change to the local vault too, and the buckets that held it have to be rewritten.
  for (const [id, item] of local) {
    if (!merged.has(id)) changed.push(item);
  }

  return { merged, conflicts, changed };
}

/* ------------------------------------------------------------------ one id at a time */

interface Outcome {
  /** `null` drops the id from the vault entirely — the tombstone was purged on both sides. */
  readonly item: VaultItem | null;
  readonly conflict: Conflict | null;
}

function mergeOne(
  base: VaultItem | undefined,
  local: VaultItem | undefined,
  remote: VaultItem | undefined,
  ctx: MergeContext,
): Outcome {
  if (local === undefined && remote === undefined) return { item: null, conflict: null };

  if (base === undefined) {
    // No common ancestor: whichever side has it, added it.
    if (local === undefined) return { item: remote ?? null, conflict: null };
    if (remote === undefined) return { item: local, conflict: null };
    return bothPresent(undefined, local, remote, ctx);
  }

  // An id present in the base and absent from a side was **purged** there: the tombstone aged past
  // its 90-day TTL and was dropped. Propagating the purge is right when the other side agrees the
  // item is gone, and wrong when the other side has since done something to it — a restore, or an
  // edit from a device that was offline for three months. A change outranks a purge.
  if (local === undefined) return { item: edited(base, remote) ? (remote ?? null) : null, conflict: null };
  if (remote === undefined) return { item: edited(base, local) ? local : null, conflict: null };

  return bothPresent(base, local, remote, ctx);
}

function bothPresent(
  base: VaultItem | undefined,
  local: VaultItem,
  remote: VaultItem,
  ctx: MergeContext,
): Outcome {
  const localDeleted = isDeleted(local);
  const remoteDeleted = isDeleted(remote);

  if (localDeleted !== remoteDeleted) {
    const live = localDeleted ? remote : local;
    // A delete propagates when the other side left the item alone. When it did not, discarding
    // either answer is a decision only the user gets to make (§6.4).
    if (base !== undefined && !edited(base, live)) {
      return { item: tombstoned(mergeFields(base, local, remote).item, local, remote), conflict: null };
    }
    return {
      item: local,
      conflict: conflictOf('edit-delete', [], base ?? null, local, remote, ctx),
    };
  }

  const { item, fields } = mergeFields(base, local, remote);
  const settled = localDeleted ? tombstoned(item, local, remote) : item;
  if (fields.length === 0) return { item: settled, conflict: null };
  return {
    item: settled,
    conflict: conflictOf(
      base === undefined ? 'add-add' : 'field',
      fields,
      base ?? null,
      local,
      remote,
      ctx,
    ),
  };
}

function conflictOf(
  kind: ConflictKind,
  fields: readonly ConflictField[],
  base: VaultItem | null,
  mine: VaultItem,
  theirs: VaultItem,
  ctx: MergeContext,
): Conflict {
  return {
    id: mine.id,
    kind,
    fields,
    mine,
    theirs,
    base,
    detectedAt: ctx.now,
    ...(ctx.remoteDevice === undefined ? {} : { remoteDevice: ctx.remoteDevice }),
    ...(ctx.origin === undefined ? {} : { origin: ctx.origin }),
  };
}

/* ------------------------------------------------------------------ field-wise merge */

interface FieldMerge {
  readonly item: VaultItem;
  readonly fields: readonly ConflictField[];
}

function mergeFields(
  base: VaultItem | undefined,
  local: VaultItem,
  remote: VaultItem,
): FieldMerge {
  if (local.type !== remote.type) return { item: local, fields: ['type'] };

  const conflicted: ConflictField[] = [];
  const common = {
    id: local.id,
    // The earlier creation time is the true one: an item cannot have been created twice, and the
    // later stamp belongs to whichever device learned about it second.
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    // **Not the new `vaultRev`**, which §6.4 originally specified and which turns out to be
    // incompatible with the convergence property in the same section. The new `vaultRev` is
    // `max(local, remote) + 1` *computed on the device doing the merge*, so two devices merging the
    // same pair of vaults minutes apart would stamp different numbers, `rev` is inside the
    // ciphertext, and their buckets would therefore never become byte-identical — each would see
    // the other as changed forever. `max` of the two sides is symmetric, deterministic, and equally
    // truthful about which revision the item last moved at.
    rev: Math.max(local.rev, remote.rev),
  };

  const scalar = (field: ScalarField, read: (item: VaultItem) => string): string => {
    const lv = read(local);
    const rv = read(remote);
    if (lv === rv) return lv;
    const bv = base?.type === local.type ? read(base) : undefined;
    if (bv !== undefined && lv === bv) return rv;
    if (bv !== undefined && rv === bv) return lv;
    conflicted.push(field);
    // Provisionally this device's answer, so the vault stays usable while the banner is up (§6.5).
    return lv;
  };

  const title = scalar('title', (item) => item.title);
  const parentId = scalar('parentId', (item) => item.parentId);
  const order = scalar('order', (item) => item.order);

  if (!isBookmark(local) || !isBookmark(remote)) {
    const folder: Folder = { ...common, type: 'folder', title, parentId, order };
    return { item: folder, fields: conflicted };
  }

  const url = scalar('url', (item) => (isBookmark(item) ? item.url : ''));
  const note = scalar('note', (item) => noteOf(item));
  const baseBookmark = base !== undefined && isBookmark(base) ? base : undefined;

  const bookmark: Bookmark = {
    ...common,
    type: 'bookmark',
    title,
    parentId,
    order,
    url,
    ...(note === '' ? {} : { note }),
    ...mergedTags(baseBookmark, local, remote),
    ...mergedCounters(local, remote),
    ...mergedOg(baseBookmark, local, remote),
    ...mergedThumb(baseBookmark, local, remote),
  };
  return { item: bookmark, fields: conflicted };
}

/**
 * Tags: the union of both sides, minus anything removed on either side relative to the base
 * (§6.4). Never a conflict, by design.
 *
 * The *order* of the result is chosen so the function stays symmetric under swapping the two sides
 * without becoming unstable when nothing changed: identical lists come back untouched, a result
 * that matches exactly one side keeps that side's order, and anything else is sorted. Without the
 * first rule a merge of two identical vaults would reorder every tag list and dirty every bucket.
 */
function mergedTags(
  base: Bookmark | undefined,
  local: Bookmark,
  remote: Bookmark,
): { tags?: readonly string[] } {
  const localTags = tagsOf(local);
  const remoteTags = tagsOf(remote);
  if (sameList(localTags, remoteTags)) {
    return localTags.length === 0 ? {} : { tags: localTags };
  }

  const baseTags = new Set(base === undefined ? [] : tagsOf(base));
  const localSet = new Set(localTags);
  const remoteSet = new Set(remoteTags);
  const removed = new Set<string>();
  for (const tag of baseTags) {
    if (!localSet.has(tag) || !remoteSet.has(tag)) removed.add(tag);
  }

  const union = [...new Set([...localTags, ...remoteTags])].filter((tag) => !removed.has(tag));
  const kept = new Set(union);
  const order = sameSet(kept, localSet)
    ? localTags.filter((tag) => kept.has(tag))
    : sameSet(kept, remoteSet)
      ? remoteTags.filter((tag) => kept.has(tag))
      : [...union].sort();

  return order.length === 0 ? {} : { tags: order };
}

/** Opens and open counts are `max` on both sides and never conflict (§6.4). */
function mergedCounters(
  local: Bookmark,
  remote: Bookmark,
): { openedAt?: number; openCount?: number } {
  const openedAt = maxOf(local.openedAt, remote.openedAt);
  const openCount = maxOf(local.openCount, remote.openCount);
  return {
    ...(openedAt === undefined ? {} : { openedAt }),
    ...(openCount === undefined ? {} : { openCount }),
  };
}

/**
 * OG metadata and thumbnails are **derived**: VaultaMark read them off a page, nobody typed them.
 * A side that changed one wins over a side that did not; when both changed, the thumbnail with the
 * newer capture time wins and the OG record is settled by canonical byte order.
 *
 * Neither ever becomes a conflict. A prompt asking someone to choose between two versions of a
 * preview image they never chose in the first place is noise, and losing the answer costs a
 * re-capture rather than data.
 */
type OgMeta = NonNullable<Bookmark['og']>;

function mergedOg(
  base: Bookmark | undefined,
  local: Bookmark,
  remote: Bookmark,
): { og?: OgMeta } {
  const chosen = derived(base?.og, local.og, remote.og, (a, b) =>
    canonicalJson(a) <= canonicalJson(b) ? a : b,
  );
  return chosen === undefined ? {} : { og: chosen };
}

function mergedThumb(
  base: Bookmark | undefined,
  local: Bookmark,
  remote: Bookmark,
): { thumb?: ThumbMeta } {
  const chosen = derived(base?.thumb, local.thumb, remote.thumb, (a, b) => {
    if (a.at !== b.at) return a.at > b.at ? a : b;
    return canonicalJson(a) <= canonicalJson(b) ? a : b;
  });
  return chosen === undefined ? {} : { thumb: chosen };
}

function derived<T>(
  base: T | undefined,
  local: T | undefined,
  remote: T | undefined,
  tiebreak: (a: T, b: T) => T,
): T | undefined {
  const lk = canonicalJson(local ?? null);
  const rk = canonicalJson(remote ?? null);
  if (lk === rk) return local;
  const bk = canonicalJson(base ?? null);
  if (lk === bk) return remote;
  if (rk === bk) return local;
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  return tiebreak(local, remote);
}

/* ------------------------------------------------------------------ tombstones */

/**
 * The merged fields, tombstoned.
 *
 * `deletedAt` is the **earlier** of the two deletions rather than the later: the item died when the
 * first device deleted it, and the second stamp only records when the news arrived. Taking the
 * earlier one also makes the choice symmetric, and it is what decides when the 90-day purge fires.
 */
function tombstoned(item: VaultItem, local: VaultItem, remote: VaultItem): VaultItem {
  const stamps = [local, remote]
    .filter((side) => isDeleted(side))
    .map((side) => side.deletedAt ?? side.updatedAt);
  const deletedAt =
    stamps.length === 0 ? Math.max(local.updatedAt, remote.updatedAt) : Math.min(...stamps);
  return { ...item, deleted: true, deletedAt };
}

/* ------------------------------------------------------------------ the tree, afterwards */

/**
 * Reattach anything the merge left unreachable.
 *
 * Two independently legal edits can produce an illegal tree: a folder deleted here while a bookmark
 * was added to it there, or `A` moved into `B` on one device while `B` moved into `A` on the other.
 * Neither is a conflict — nobody disagreed about anything — but both leave live items that no
 * folder listing can reach, and an item nobody can find is lost as surely as one that was dropped.
 * They come back to the top level, where they are visible and can be filed again.
 */
function reattachOrphans(merged: Map<string, VaultItem>): void {
  for (const [id, item] of merged) {
    if (isDeleted(item) || item.parentId === ROOT_ID) continue;
    if (reachesRoot(merged, item)) continue;
    merged.set(id, { ...item, parentId: ROOT_ID });
  }
}

function reachesRoot(merged: ReadonlyMap<string, VaultItem>, item: VaultItem): boolean {
  const seen = new Set<string>([item.id]);
  let parentId = item.parentId;
  while (parentId !== ROOT_ID) {
    const parent = merged.get(parentId);
    if (parent === undefined || isBookmark(parent) || isDeleted(parent)) return false;
    if (seen.has(parent.id)) return false;
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return true;
}

/* ------------------------------------------------------------------ the view we push */

/**
 * The item set to send to the provider, given what is still unresolved.
 *
 * A pending conflict means the two devices genuinely disagree, and the rule from §6.5 is that
 * nothing is pushed for a conflicted item while the rest of the vault keeps syncing. That is what
 * this is: the local vault with the *remote* side put back for every conflicted id, so a push
 * cannot overwrite the other device's answer, and the merge base records exactly what the remote
 * holds. Resolving a conflict removes its record, and the item rejoins the outbound view with
 * whatever the user chose.
 *
 * A conflict whose other side came from an **imported file** is deliberately left out of that rule.
 * There is no device holding the imported version and nothing to protect it from: substituting it
 * would push a backup's copy of a bookmark to every device, overwriting what the user actually has
 * with a version they have not chosen. Those items go out exactly as the merged vault holds them —
 * which is this device's side, the one on screen.
 */
export function outboundView(items: ItemMap, conflicts: readonly Conflict[]): ItemMap {
  const remoteSided = conflicts.filter((conflict) => conflict.origin === undefined);
  if (remoteSided.length === 0) return items;
  const out = new Map(items);
  for (const conflict of remoteSided) out.set(conflict.id, conflict.theirs);
  return out;
}

/* ------------------------------------------------------------------ comparisons */

/**
 * Whether a side changed anything a person owns, relative to the base.
 *
 * `openedAt`, `openCount` and `rev` are deliberately excluded: opening a bookmark on one device
 * while another deletes it is not an edit, and treating it as one would put a conflict prompt in
 * front of someone who did nothing but click a link.
 */
export function edited(base: VaultItem, side: VaultItem | undefined): boolean {
  return side !== undefined && editKey(base) !== editKey(side);
}

/** Whether two item sets hold exactly the same items, byte for byte. */
export function sameItems(a: ItemMap, b: ItemMap): boolean {
  if (a.size !== b.size) return false;
  for (const [id, item] of a) {
    const other = b.get(id);
    if (other === undefined || canonicalJson(item) !== canonicalJson(other)) return false;
  }
  return true;
}

function editKey(item: VaultItem): string {
  return canonicalJson({
    type: item.type,
    title: item.title,
    parentId: item.parentId,
    order: item.order,
    deleted: item.deleted === true,
    url: isBookmark(item) ? item.url : null,
    note: noteOf(item),
    tags: tagsOf(item),
    og: (isBookmark(item) ? item.og : undefined) ?? null,
    thumb: (isBookmark(item) ? item.thumb : undefined) ?? null,
  });
}

function maxOf(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
