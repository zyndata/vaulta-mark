/**
 * The vault as a value: pure functions over an immutable `ItemMap` (ARCHITECTURE §3).
 *
 * Nothing here does I/O, touches `chrome.*`, or knows that encryption exists. Every mutation takes
 * the current items and returns new items plus the exact list of items that changed — which is what
 * lets the storage layer dirty one bucket instead of rewriting the vault (`storage/repo.ts`).
 *
 * Mutations validate **before** they write. A batch that would leave the tree inconsistent — an
 * unknown parent, a folder moved inside itself — is rejected whole, because a half-applied batch
 * produces a broken item tree behind a perfectly valid GCM tag, and nothing downstream detects that.
 */

import { InvalidMutationError, ItemNotFoundError } from './errors.js';
import { FIRST_ORDER, compareOrder, orderBetween } from './order.js';
import {
  MAX_NOTE_LENGTH,
  MAX_TAGS_PER_ITEM,
  MAX_TAG_LENGTH,
  ROOT_ID,
  TOMBSTONE_TTL_MS,
  isBookmark,
  isDeleted,
  tagsOf,
  type Bookmark,
  type Folder,
  type ItemMap,
  type ThumbMeta,
  type VaultItem,
} from './types.js';

/** Everything a mutation needs from the outside world, passed in so the functions stay pure. */
export interface MutationContext {
  /** Epoch ms stamped onto `createdAt`/`updatedAt`/`deletedAt`. */
  readonly now: number;
  /** The `vaultRev` this change commits at. Every item it touches records it. */
  readonly rev: number;
  /** Id source for new items. Injected so tests get deterministic ids. */
  readonly newId?: () => string;
}

/** What a mutation did: the new item set, and precisely which items moved. */
export interface MutationResult {
  readonly items: ItemMap;
  readonly changed: readonly VaultItem[];
}

export interface AddBookmarkInput {
  readonly type: 'bookmark';
  readonly url: string;
  readonly title?: string;
  readonly parentId?: string;
  readonly tags?: readonly string[];
  readonly note?: string;
  readonly og?: { readonly title?: string; readonly description?: string };
  /** Supply an id only when re-creating a known item (import, migration). Normally omitted. */
  readonly id?: string;
}

export interface AddFolderInput {
  readonly type: 'folder';
  readonly title: string;
  readonly parentId?: string;
  readonly id?: string;
}

export type AddItemInput = AddBookmarkInput | AddFolderInput;

/**
 * A field-level edit. `null` **clears** an optional field; omitting it leaves the field alone.
 *
 * The `| null` spelling exists because `exactOptionalPropertyTypes` is on: `{ note: undefined }` is
 * not assignable to `{ note?: string }`, so "remove this note" needs a value of its own rather than
 * an absence that TypeScript will not let us express.
 */
export interface ItemPatch {
  readonly title?: string;
  readonly url?: string;
  readonly note?: string | null;
  readonly tags?: readonly string[] | null;
  readonly og?: { readonly title?: string; readonly description?: string } | null;
  readonly thumb?: ThumbMeta | null;
  readonly openedAt?: number;
  readonly openCount?: number;
}

/** The mutation vocabulary `VaultRepository.apply()` speaks. */
export type Mutation =
  | { readonly kind: 'add'; readonly input: AddItemInput }
  | { readonly kind: 'update'; readonly id: string; readonly patch: ItemPatch }
  | { readonly kind: 'delete'; readonly id: string }
  | { readonly kind: 'restore'; readonly id: string }
  | {
      readonly kind: 'move';
      readonly id: string;
      readonly parentId: string;
      /** Insert after this sibling; `null` means "first". Omit to append. */
      readonly afterId?: string | null;
    };

/* ------------------------------------------------------------------ normalization (§3.5) */

/**
 * Tags, normalized: trimmed, NFC, internal whitespace collapsed, lowercased, deduped, capped.
 *
 * Normalizing at the model boundary rather than at each call site is what makes the set-union merge
 * in Phase 7 correct: `Reading` from one device and `reading ` from another have to be the same tag
 * or the union silently doubles them.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
    if (tag === '') continue;
    const capped = tag.slice(0, MAX_TAG_LENGTH);
    if (!out.includes(capped)) out.push(capped);
    if (out.length === MAX_TAGS_PER_ITEM) break;
  }
  return out;
}

/**
 * A URL as we store it: lowercase scheme and host, default port stripped, query and fragment kept
 * (people bookmark anchors, and dropping a query breaks half the web).
 *
 * Anything `URL` cannot parse is stored verbatim. This is a bookmark manager, not a validator; a
 * user who saved something odd should get it back exactly as they saved it.
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
}

/**
 * The key two bookmarks share when they are "the same page": scheme, host, path, sorted query.
 * Fragment dropped.
 *
 * Computed on demand for duplicate detection and **never stored** — a second normalization of the
 * same URL sitting in the ciphertext would be redundant bytes and a second thing to migrate.
 */
export function duplicateKeyOf(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.searchParams.sort();
    // A trailing slash on a bare origin and its absence name the same page to every server.
    if (parsed.pathname === '/') parsed.pathname = '';
    return parsed.href;
  } catch {
    return url.trim().toLowerCase();
  }
}

/* ------------------------------------------------------------------ mutations */

/** Add a bookmark or folder, appended after its last live sibling. */
export function addItem(items: ItemMap, input: AddItemInput, ctx: MutationContext): MutationResult {
  const parentId = input.parentId ?? ROOT_ID;
  assertUsableParent(items, parentId);

  const id = input.id ?? (ctx.newId ?? defaultNewId)();
  if (items.has(id)) {
    throw new InvalidMutationError(`An item with id ${id} already exists.`);
  }

  const siblings = listChildren(items, parentId);
  const last = siblings.at(-1);
  const order = orderBetween(last?.order ?? null, null);

  const base = {
    id,
    parentId,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    order,
    rev: ctx.rev,
  };

  const item: VaultItem =
    input.type === 'folder'
      ? { ...base, type: 'folder', title: input.title.trim() }
      : {
          ...base,
          type: 'bookmark',
          title: input.title?.trim() ?? '',
          url: normalizeUrl(input.url),
          ...optionalTags(input.tags),
          ...optionalNote(input.note),
          ...(input.og === undefined ? {} : { og: input.og }),
        };

  return { items: withItems(items, [item]), changed: [item] };
}

/** Edit an item's fields. Unmentioned fields are untouched; `null` clears an optional one. */
export function updateItem(
  items: ItemMap,
  id: string,
  patch: ItemPatch,
  ctx: MutationContext,
): MutationResult {
  const current = requireItem(items, id);
  if (isDeleted(current)) {
    throw new InvalidMutationError(`Item ${id} is deleted and cannot be edited.`);
  }

  const next = isBookmark(current)
    ? patchBookmark(current, patch, ctx)
    : patchFolder(current, patch, ctx);

  if (isUnchanged(current, next)) return { items, changed: [] };
  return { items: withItems(items, [next]), changed: [next] };
}

/**
 * Tombstone an item, and every descendant if it is a folder.
 *
 * Deletes are tombstones (D20) because a hard delete on device A is undone by a stale device B on
 * the next sync. Descendants are tombstoned with it rather than reparented: leaving them alive
 * under a deleted folder makes them unreachable in the UI and resurrects the folder on merge.
 */
export function deleteItem(items: ItemMap, id: string, ctx: MutationContext): MutationResult {
  const target = requireItem(items, id);
  if (isDeleted(target)) return { items, changed: [] };

  const doomed = [target, ...descendantsOf(items, id)].filter((item) => !isDeleted(item));
  const changed = doomed.map((item) => ({
    ...item,
    deleted: true as const,
    deletedAt: ctx.now,
    updatedAt: ctx.now,
    rev: ctx.rev,
  }));
  return { items: withItems(items, changed), changed };
}

/**
 * Lift a tombstone: the undo behind "deleted — undo" in the UI.
 *
 * A tombstone still holds the whole item, so undo is a field change rather than a re-creation, and
 * the id survives — which is what stops the undo from arriving on another device as a *second*
 * bookmark next to the delete.
 *
 * Two details the caller does not have to think about:
 *
 * - A folder is restored together with the descendants that went down **in the same delete**
 *   (`deletedAt` matches). Anything tombstoned earlier stays deleted, because it was deleted on its
 *   own and undoing that is not what the user asked for.
 * - An item whose parent is gone comes back at the top level. Restoring it under a tombstone would
 *   produce something that exists, is not deleted, and cannot be reached from anywhere.
 */
export function restoreItem(items: ItemMap, id: string, ctx: MutationContext): MutationResult {
  const target = requireItem(items, id);
  if (!isDeleted(target)) return { items, changed: [] };

  const batch = [
    target,
    ...descendantsOf(items, id).filter(
      (item) => isDeleted(item) && item.deletedAt === target.deletedAt,
    ),
  ];
  const restoredIds = new Set(batch.map((item) => item.id));

  const changed = batch.map((item) => {
    const parentAlive =
      item.parentId === ROOT_ID ||
      restoredIds.has(item.parentId) ||
      isRestorableParent(items.get(item.parentId));
    const next: Mutable<VaultItem> = { ...item, updatedAt: ctx.now, rev: ctx.rev };
    delete next.deleted;
    delete next.deletedAt;
    if (!parentAlive) next.parentId = ROOT_ID;
    return next;
  });
  return { items: withItems(items, changed), changed };
}

function isRestorableParent(parent: VaultItem | undefined): boolean {
  return parent !== undefined && !isBookmark(parent) && !isDeleted(parent);
}

/**
 * Move an item under `parentId`, positioned after `afterId` (or first when `afterId` is `null`,
 * or last when it is omitted).
 *
 * Only the moved item changes: that is the whole point of the fractional order keys.
 */
export function moveItem(
  items: ItemMap,
  id: string,
  parentId: string,
  afterId: string | null | undefined,
  ctx: MutationContext,
): MutationResult {
  const item = requireItem(items, id);
  if (isDeleted(item)) {
    throw new InvalidMutationError(`Item ${id} is deleted and cannot be moved.`);
  }
  assertUsableParent(items, parentId);
  if (parentId === id || descendantsOf(items, id).some((child) => child.id === parentId)) {
    throw new InvalidMutationError(`Cannot move item ${id} inside itself.`);
  }

  const siblings = listChildren(items, parentId).filter((sibling) => sibling.id !== id);
  let before: string | null;
  let after: string | null;
  if (afterId === undefined) {
    before = siblings.at(-1)?.order ?? null;
    after = null;
  } else if (afterId === null) {
    before = null;
    after = siblings[0]?.order ?? null;
  } else {
    const index = siblings.findIndex((sibling) => sibling.id === afterId);
    if (index === -1) {
      throw new InvalidMutationError(`Item ${afterId} is not a live child of ${parentId}.`);
    }
    before = siblings[index]?.order ?? null;
    after = siblings[index + 1]?.order ?? null;
  }

  const order = orderBetween(before, after);
  if (item.parentId === parentId && item.order === order) return { items, changed: [] };

  const moved: VaultItem = { ...item, parentId, order, updatedAt: ctx.now, rev: ctx.rev };
  return { items: withItems(items, [moved]), changed: [moved] };
}

/* ------------------------------------------------------------------ batch builders */

/**
 * The mutations that add and remove tags across a selection.
 *
 * A *builder* rather than a mutation of its own, because `VaultRepository.apply()` commits a batch
 * at one `vaultRev` and rolls the whole thing back if any part of it is invalid — so a bulk tag is
 * atomic for free, and stays one revision for the merge engine to reason about (Phase 7).
 *
 * Removals are applied after additions, so a tag named in both is removed: an explicit "take this
 * off" is a clearer instruction than an implicit "put this on". Items that would not change, and
 * folders (which have no tags at all), produce no mutation.
 */
export function tagMutations(
  items: ItemMap,
  ids: Iterable<string>,
  changes: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
): Mutation[] {
  const add = normalizeTags(changes.add ?? []);
  const remove = new Set(normalizeTags(changes.remove ?? []));
  if (add.length === 0 && remove.size === 0) return [];

  const mutations: Mutation[] = [];
  for (const id of new Set(ids)) {
    const item = items.get(id);
    if (item === undefined || isDeleted(item) || !isBookmark(item)) continue;
    const current = tagsOf(item);
    const next = normalizeTags([...current, ...add]).filter((tag) => !remove.has(tag));
    if (sameTags(current, next)) continue;
    mutations.push({ kind: 'update', id, patch: { tags: next.length === 0 ? null : next } });
  }
  return mutations;
}

/**
 * Rename a tag on every bookmark that carries it.
 *
 * The renamed tag keeps its position in each item's list, and folds into an existing occurrence of
 * the new name rather than appearing twice — renaming `read` to `reading` on an item already tagged
 * `reading` leaves one tag, not two.
 */
export function renameTagMutations(items: ItemMap, from: string, to: string): Mutation[] {
  const [oldTag] = normalizeTags([from]);
  const [newTag] = normalizeTags([to]);
  if (oldTag === undefined || newTag === undefined) {
    throw new InvalidMutationError('A tag rename needs a non-empty name on both sides.');
  }
  if (oldTag === newTag) return [];

  const mutations: Mutation[] = [];
  for (const item of items.values()) {
    if (isDeleted(item) || !isBookmark(item)) continue;
    const current = tagsOf(item);
    if (!current.includes(oldTag)) continue;
    const next = normalizeTags(current.map((tag) => (tag === oldTag ? newTag : tag)));
    mutations.push({ kind: 'update', id: item.id, patch: { tags: next } });
  }
  return mutations;
}

/** What "delete this folder" should do with what is inside it. */
export type FolderDeleteMode =
  /** Tombstone the folder and everything under it. */
  | 'recursive'
  /** Move the folder's direct children up to its parent, then tombstone the empty folder. */
  | 'reparent';

/**
 * The mutations behind deleting a folder.
 *
 * The choice is the user's and there is no safe default, so it is a required argument rather than
 * an option with a fallback: one of the two answers loses a subtree and the other rearranges the
 * tree, and picking either silently is a way to lose someone's bookmarks.
 *
 * `reparent` moves only the *direct* children — everything deeper travels with its own parent.
 * The moves come first so they still see a live folder to move out of.
 */
export function deleteFolderMutations(
  items: ItemMap,
  id: string,
  mode: FolderDeleteMode,
): Mutation[] {
  const folder = requireItem(items, id);
  if (isBookmark(folder)) {
    throw new InvalidMutationError(`Item ${id} is a bookmark, not a folder.`);
  }
  if (mode === 'recursive') return [{ kind: 'delete', id }];

  const moves: Mutation[] = listChildren(items, id).map((child) => ({
    kind: 'move',
    id: child.id,
    parentId: folder.parentId,
  }));
  return [...moves, { kind: 'delete', id }];
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/** Dispatch one mutation. `VaultRepository.apply()` is a fold of this over a batch. */
export function applyMutation(
  items: ItemMap,
  mutation: Mutation,
  ctx: MutationContext,
): MutationResult {
  switch (mutation.kind) {
    case 'add':
      return addItem(items, mutation.input, ctx);
    case 'update':
      return updateItem(items, mutation.id, mutation.patch, ctx);
    case 'delete':
      return deleteItem(items, mutation.id, ctx);
    case 'restore':
      return restoreItem(items, mutation.id, ctx);
    case 'move':
      return moveItem(items, mutation.id, mutation.parentId, mutation.afterId, ctx);
  }
}

/** Apply a batch, accumulating the changed set. Later mutations see earlier ones. */
export function applyMutations(
  items: ItemMap,
  mutations: readonly Mutation[],
  ctx: MutationContext,
): MutationResult {
  let current = items;
  const changed = new Map<string, VaultItem>();
  for (const mutation of mutations) {
    const result = applyMutation(current, mutation, ctx);
    current = result.items;
    for (const item of result.changed) changed.set(item.id, item);
  }
  return { items: current, changed: [...changed.values()] };
}

/**
 * Drop tombstones older than the TTL.
 *
 * Safe only once every peer has certainly seen the delete, which is what the 90-day window buys.
 * Purging early resurrects the item from whichever device was offline longest.
 */
export function purgeTombstones(
  items: ItemMap,
  now: number,
  ttlMs: number = TOMBSTONE_TTL_MS,
): { readonly items: ItemMap; readonly purged: readonly string[] } {
  const purged: string[] = [];
  for (const item of items.values()) {
    if (isDeleted(item) && now - (item.deletedAt ?? item.updatedAt) > ttlMs) purged.push(item.id);
  }
  if (purged.length === 0) return { items, purged };

  const next = new Map(items);
  for (const id of purged) next.delete(id);
  return { items: next, purged };
}

/* ------------------------------------------------------------------ queries */

/** Live children of `parentId`, in display order. Ties break on id so the order is total. */
export function listChildren(items: ItemMap, parentId: string): VaultItem[] {
  const children: VaultItem[] = [];
  for (const item of items.values()) {
    if (item.parentId === parentId && !isDeleted(item)) children.push(item);
  }
  return children.sort(
    (a, b) => compareOrder(a.order, b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * The chain of ancestors from the top level down to `id`, `id` included. The synthetic root is not
 * an item and does not appear.
 *
 * A parent chain that does not terminate at the root — which a merge of two divergent moves can
 * produce — is truncated rather than looped on.
 */
export function pathOf(items: ItemMap, id: string): VaultItem[] {
  const path: VaultItem[] = [];
  const seen = new Set<string>();
  let current: VaultItem | undefined = requireItem(items, id);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId === ROOT_ID ? undefined : items.get(current.parentId);
  }
  return path.reverse();
}

export interface FolderCounts {
  /** Live items directly under the folder, of either kind. */
  readonly direct: number;
  /** Live bookmarks anywhere in the subtree — the number a folder row shows. */
  readonly descendants: number;
}

/** Counts for every folder, plus the synthetic root. One pass, so a 10,000-item vault is cheap. */
export function countsByFolder(items: ItemMap): Map<string, FolderCounts> {
  const direct = new Map<string, number>();
  const bookmarksIn = new Map<string, number>();
  for (const item of items.values()) {
    if (isDeleted(item)) continue;
    direct.set(item.parentId, (direct.get(item.parentId) ?? 0) + 1);
    if (isBookmark(item)) bookmarksIn.set(item.parentId, (bookmarksIn.get(item.parentId) ?? 0) + 1);
  }

  const counts = new Map<string, FolderCounts>();
  const folderIds = [ROOT_ID];
  for (const item of items.values()) {
    if (!isDeleted(item) && !isBookmark(item)) folderIds.push(item.id);
  }

  for (const folderId of folderIds) {
    let descendants = 0;
    const stack = [folderId];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      descendants += bookmarksIn.get(current) ?? 0;
      for (const child of items.values()) {
        if (child.parentId === current && !isDeleted(child) && !isBookmark(child)) {
          stack.push(child.id);
        }
      }
    }
    counts.set(folderId, { direct: direct.get(folderId) ?? 0, descendants });
  }
  return counts;
}

/** Every live tag with its use count, most-used first, ties alphabetical. */
export function allTags(items: ItemMap): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items.values()) {
    if (isDeleted(item)) continue;
    for (const tag of tagsOf(item)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
}

/** Every descendant of `id`, tombstones included. */
export function descendantsOf(items: ItemMap, id: string): VaultItem[] {
  const out: VaultItem[] = [];
  const stack = [id];
  const seen = new Set<string>([id]);
  while (stack.length > 0) {
    const current = stack.pop();
    for (const item of items.values()) {
      if (item.parentId !== current || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      stack.push(item.id);
    }
  }
  return out;
}

/** Items keyed by id, for handing an array to the pure functions above. */
export function toItemMap(items: Iterable<VaultItem>): ItemMap {
  const map = new Map<string, VaultItem>();
  for (const item of items) map.set(item.id, item);
  return map;
}

/* ------------------------------------------------------------------ internals */

function requireItem(items: ItemMap, id: string): VaultItem {
  const item = items.get(id);
  if (item === undefined) throw new ItemNotFoundError(id);
  return item;
}

function assertUsableParent(items: ItemMap, parentId: string): void {
  if (parentId === ROOT_ID) return;
  const parent = items.get(parentId);
  if (parent === undefined) throw new ItemNotFoundError(parentId);
  if (isBookmark(parent)) {
    throw new InvalidMutationError(`Item ${parentId} is a bookmark and cannot hold children.`);
  }
  if (isDeleted(parent)) {
    throw new InvalidMutationError(`Folder ${parentId} is deleted and cannot hold children.`);
  }
}

function withItems(items: ItemMap, updated: readonly VaultItem[]): ItemMap {
  const next = new Map(items);
  for (const item of updated) next.set(item.id, item);
  return next;
}

function patchFolder(folder: Folder, patch: ItemPatch, ctx: MutationContext): Folder {
  for (const field of ['url', 'note', 'tags', 'og', 'thumb', 'openedAt', 'openCount'] as const) {
    if (patch[field] !== undefined) {
      throw new InvalidMutationError(`Folders have no "${field}" field.`);
    }
  }
  return {
    ...folder,
    ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
    updatedAt: ctx.now,
    rev: ctx.rev,
  };
}

function patchBookmark(bookmark: Bookmark, patch: ItemPatch, ctx: MutationContext): Bookmark {
  // Built as a mutable draft and narrowed on return: `exactOptionalPropertyTypes` makes "remove
  // this field" inexpressible as an assignment, so clearing has to be a `delete`, and a `delete`
  // needs a non-readonly local.
  const next: Mutable<Bookmark> = { ...bookmark, updatedAt: ctx.now, rev: ctx.rev };

  if (patch.title !== undefined) next.title = patch.title.trim();
  if (patch.url !== undefined) next.url = normalizeUrl(patch.url);
  if (patch.openedAt !== undefined) next.openedAt = patch.openedAt;
  if (patch.openCount !== undefined) next.openCount = patch.openCount;

  if (patch.note !== undefined) {
    const note = patch.note === null ? '' : patch.note.slice(0, MAX_NOTE_LENGTH);
    if (note === '') delete next.note;
    else next.note = note;
  }
  if (patch.tags !== undefined) {
    const tags = patch.tags === null ? [] : normalizeTags(patch.tags);
    if (tags.length === 0) delete next.tags;
    else next.tags = tags;
  }
  if (patch.og !== undefined) {
    if (patch.og === null) delete next.og;
    else next.og = patch.og;
  }
  if (patch.thumb !== undefined) {
    if (patch.thumb === null) delete next.thumb;
    else next.thumb = patch.thumb;
  }
  return next;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function optionalTags(tags: readonly string[] | undefined): { tags?: readonly string[] } {
  if (tags === undefined) return {};
  const normalized = normalizeTags(tags);
  return normalized.length === 0 ? {} : { tags: normalized };
}

function optionalNote(note: string | undefined): { note?: string } {
  if (note === undefined) return {};
  const trimmed = note.slice(0, MAX_NOTE_LENGTH);
  return trimmed === '' ? {} : { note: trimmed };
}

/**
 * Whether a patch actually changed anything.
 *
 * An edit that changes nothing must not bump `rev`: it would dirty a bucket, spend one of the 120
 * sync writes a minute buys, and manufacture a merge conflict out of a no-op. Compared through
 * canonical JSON with the stamps neutralised, since the shapes are plain data by construction.
 */
function isUnchanged(before: VaultItem, after: VaultItem): boolean {
  return (
    canonicalJson({ ...before, updatedAt: 0, rev: 0 }) ===
    canonicalJson({ ...after, updatedAt: 0, rev: 0 })
  );
}

/**
 * JSON with object keys sorted at every depth.
 *
 * Lives here, in the lowest layer that needs it, because the storage codec needs the same function:
 * the bucket integrity tag is an HMAC over the payload's JSON, and it can only mean "the contents
 * changed" if the same item set always serialises to the same bytes. Arrays keep their order —
 * reordering one would destroy information rather than canonicalise it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) return nested;
    const record = nested as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

/** `crypto.randomUUID` is available in every context this ships to (Chrome 116 floor, D4). */
function defaultNewId(): string {
  return crypto.randomUUID();
}

/** The order key a brand-new first child gets. Re-exported so callers need one import. */
export { FIRST_ORDER };
