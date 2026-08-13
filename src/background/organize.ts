/**
 * The vault operations the manager page asks for: folders, editing, tags, bulk moves and deletes.
 *
 * `items.ts` is the popup's vocabulary — add, list, open, delete, undo. This is the manager's, and
 * it exists as a separate file for one reason: everything here composes a **batch** and hands it to
 * `repo.apply()` in a single call, because that is what makes a bulk operation atomic. `apply()`
 * folds the batch over an immutable item map and only assigns the result if every mutation in it
 * succeeded, so "move forty bookmarks, one of which no longer exists" changes nothing at all rather
 * than moving thirty-nine and reporting an error. It is also one `vaultRev`, which is one thing for
 * the merge engine to reason about in Phase 7 instead of forty.
 *
 * Two rules carried over from `items.ts`, for the same reasons:
 *
 * - **Every operation goes through `session.currentRepository()`**, which enforces `unlockedUntil`
 *   before it hands anything back.
 * - **Every operation is a user action**, so each one touches the idle window.
 *
 * Nothing here logs. A title, a URL, a tag and a note are all vault content, and the failure paths
 * are exactly where they would end up in a console.
 */

import {
  broadcast,
  type Crumb,
  type FolderNode,
  type ItemDetail,
  type ItemEdit,
  type ListRow,
  type TagCount,
  type TreeResponse,
  type ViewResponse,
} from '../shared/messages.js';
import {
  allTags,
  countsByFolder,
  deleteFolderMutations,
  listChildren,
  pathOf,
  renameTagMutations,
  tagMutations,
  type FolderDeleteMode,
  type ItemPatch,
  type Mutation,
} from '../vault/model.js';
import { isEmptyQuery, parseQuery } from '../vault/search.js';
import { DEFAULT_SORT, sortItems, type SortKey } from '../vault/sort.js';
import {
  ROOT_ID,
  isBookmark,
  isDeleted,
  isFolder,
  noteOf,
  tagsOf,
  type ItemMap,
  type VaultItem,
} from '../vault/types.js';
import { scheduleSync } from '../sync/engine.js';
import type { VaultRepository } from '../storage/repo.js';
import { vaultableUrl } from './add.js';
import { requireVault } from './items.js';
import * as session from './session.js';

export interface ViewOptions {
  /** The folder to list. `ROOT_ID` (the default) is the top level. */
  readonly folderId?: string;
  readonly query?: string;
  readonly sort?: SortKey;
  /** Bookmarks carrying no tags, anywhere in the vault. Ignores `folderId`. */
  readonly untagged?: boolean;
}

/* ------------------------------------------------------------------ reading */

/** The sidebar: every folder with its counts, and every tag with its use count. */
export async function tree(): Promise<TreeResponse> {
  const repo = await requireVault();
  await session.touch();
  const items = repo.items();
  const counts = countsByFolder(items);

  const folders: FolderNode[] = [];
  let total = 0;
  let untagged = 0;
  for (const item of items.values()) {
    if (isDeleted(item)) continue;
    if (isFolder(item)) {
      const count = counts.get(item.id);
      folders.push({
        id: item.id,
        parentId: item.parentId,
        title: item.title,
        direct: count?.direct ?? 0,
        descendants: count?.descendants ?? 0,
      });
      continue;
    }
    total += 1;
    if (tagsOf(item).length === 0) untagged += 1;
  }

  const tags: TagCount[] = allTags(items);
  return { type: 'TREE', folders, tags, total, untagged };
}

/**
 * The main list: a folder's contents, a search, or the untagged filter.
 *
 * A search with free-text terms comes back ranked; anything else comes back in the requested sort
 * order. A filter-only query (`tag:dev` on its own) has no ranking to lose, so it is sorted like a
 * folder listing rather than left in whatever order the index happened to produce.
 */
export async function listView(options: ViewOptions = {}): Promise<ViewResponse> {
  const repo = await requireVault();
  await session.touch();
  const items = repo.items();
  const sort = options.sort ?? DEFAULT_SORT;
  const folderId = options.folderId ?? ROOT_ID;

  const query = options.query?.trim() ?? '';
  const parsed = parseQuery(query);
  const searching = query !== '' && !isEmptyQuery(parsed);
  const ranked = searching && parsed.terms.length > 0;

  let rows: VaultItem[];
  if (searching) {
    rows = repo
      .search(parsed, folderId === ROOT_ID ? {} : { folderId })
      .map((hit) => hit.item);
    if (!ranked) rows = sortItems(rows, sort);
  } else if (options.untagged === true) {
    rows = sortItems(
      [...items.values()].filter(
        (item) => !isDeleted(item) && isBookmark(item) && tagsOf(item).length === 0,
      ),
      sort,
    );
  } else {
    rows = sortItems(listChildren(items, folderId), sort, { foldersFirst: true });
  }

  const scoped = !searching && options.untagged !== true && folderId !== ROOT_ID;
  const toRow = rowBuilder(items);
  return {
    type: 'VIEW',
    items: rows.map(toRow),
    path: scoped ? crumbs(items, folderId) : [],
    terms: parsed.terms,
    ranked,
  };
}

/** One item in full, for the detail pane. `null` for an unknown or deleted id. */
export async function getItem(id: string): Promise<ItemDetail | null> {
  const repo = await requireVault();
  await session.touch();
  const items = repo.items();
  const item = items.get(id);
  if (item === undefined || isDeleted(item)) return null;
  return {
    ...rowBuilder(items)(item),
    note: noteOf(item),
    path: crumbs(items, item.parentId),
  };
}

/* ------------------------------------------------------------------ writing */

export async function createFolder(title: string, parentId?: string): Promise<string> {
  const repo = await requireVault();
  const changed = await commit(repo, [
    {
      kind: 'add',
      input: { type: 'folder', title, ...(parentId === undefined ? {} : { parentId }) },
    },
  ]);
  const folder = changed[0];
  if (folder === undefined) {
    // `apply` returns the items it changed, and an `add` always changes exactly one. Failing here
    // beats answering with an id that names nothing.
    throw new Error('Adding a folder produced no folder.');
  }
  return folder.id;
}

/**
 * Edit one item's user-owned fields.
 *
 * A URL typed into the detail pane goes through the same allowlist as a URL arriving from a tab.
 * The edit box is a second way into the vault, and a `javascript:` bookmark that the add pipeline
 * refuses must not be reachable by saving it here instead.
 */
export async function editItem(id: string, patch: ItemEdit): Promise<void> {
  const repo = await requireVault();
  const settings = await session.settings();
  const next: ItemPatch = {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.url === undefined
      ? {}
      : { url: vaultableUrl(patch.url, { stripTrackingParams: settings.stripTrackingParams }) }),
    ...(patch.note === undefined ? {} : { note: patch.note }),
    ...(patch.tags === undefined ? {} : { tags: patch.tags }),
  };
  await commit(repo, [{ kind: 'update', id, patch: next }]);
}

/**
 * Move a selection into a folder, optionally to a position. Rejected whole if any one of them
 * cannot go there.
 *
 * The chain is the subtle part. Each item lands after the one before it rather than all of them
 * after `afterId`, because `moveItem` inserts *immediately* after its anchor — so a shared anchor
 * would reverse the selection, and a five-bookmark drag would arrive upside down. Chaining keeps
 * the order they were displayed in, which is the order the person could see when they picked them up.
 */
export async function moveItems(
  ids: readonly string[],
  parentId: string,
  afterId?: string | null,
): Promise<number> {
  const repo = await requireVault();
  let anchor = afterId;
  const mutations: Mutation[] = ids.map((id) => {
    const mutation: Mutation =
      anchor === undefined ? { kind: 'move', id, parentId } : { kind: 'move', id, parentId, afterId: anchor };
    anchor = id;
    return mutation;
  });
  return (await commit(repo, mutations)).length;
}

/** Delete a folder, either with everything in it or after lifting its children to its parent. */
export async function deleteFolder(id: string, mode: FolderDeleteMode): Promise<void> {
  const repo = await requireVault();
  await commit(repo, deleteFolderMutations(repo.items(), id, mode));
}

export async function tagItems(
  ids: readonly string[],
  changes: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
): Promise<number> {
  const repo = await requireVault();
  return (await commit(repo, tagMutations(repo.items(), ids, changes))).length;
}

/** Rename a tag on every bookmark that carries it. Returns how many changed. */
export async function renameTag(from: string, to: string): Promise<number> {
  const repo = await requireVault();
  return (await commit(repo, renameTagMutations(repo.items(), from, to))).length;
}

/* ------------------------------------------------------------------ tracking parameters */

/**
 * Bookmarks already in the vault whose URL would change if the tracking strip were applied to it.
 *
 * Turning the setting on only changes what happens to the *next* thing saved, and a vault built
 * before it was on keeps every `utm_source` it collected. The manager and the popup therefore offer
 * to clean what is already there — but only when there is something to clean, which is what this
 * counts.
 *
 * A URL the add pipeline would refuse today (an import from somewhere else, a scheme since removed
 * from the allowlist) is skipped rather than rewritten: this is a tidy-up, and it has no business
 * being the thing that discovers a bookmark is unopenable.
 */
function trackedCandidates(items: ItemMap): { readonly id: string; readonly url: string }[] {
  const candidates: { id: string; url: string }[] = [];
  for (const item of items.values()) {
    if (isDeleted(item) || !isBookmark(item)) continue;
    let cleaned: string;
    try {
      cleaned = vaultableUrl(item.url, { stripTrackingParams: true });
    } catch {
      continue;
    }
    if (cleaned !== item.url) candidates.push({ id: item.id, url: cleaned });
  }
  return candidates;
}

/** How many saved bookmarks carry a tracking parameter. Read-only; changes nothing. */
export async function countTracked(): Promise<number> {
  const repo = await requireVault();
  await session.touch();
  return trackedCandidates(repo.items()).length;
}

/**
 * Strip tracking parameters from every bookmark already saved. Returns how many changed.
 *
 * One batch, so it is one revision and one thing for the merge engine to carry — and so a vault of
 * five thousand bookmarks is not five thousand writes.
 *
 * Two bookmarks that differ only in their campaign parameters become two bookmarks with the same
 * URL. Nothing here deletes one of them: this operation was asked for as a clean-up of addresses,
 * and quietly removing a bookmark someone saved twice is a different, unasked-for decision.
 */
export async function stripTracked(): Promise<number> {
  const repo = await requireVault();
  const mutations: Mutation[] = trackedCandidates(repo.items()).map(({ id, url }) => ({
    kind: 'update',
    id,
    patch: { url },
  }));
  return (await commit(repo, mutations)).length;
}

/* ------------------------------------------------------------------ internals */

/**
 * Apply a batch, write it through, and tell the open UIs.
 *
 * Written through rather than left to the 300 ms coalescer: an MV3 service worker can be torn down
 * before the timer fires, and a change the user watched happen must not evaporate. The coalescer
 * still earns its keep for the repository's own internal bursts.
 */
async function commit(
  repo: VaultRepository,
  mutations: readonly Mutation[],
): Promise<readonly VaultItem[]> {
  if (mutations.length === 0) {
    await session.touch();
    return [];
  }
  const changed = await repo.apply(mutations);
  await repo.flush();
  await session.touch();
  if (changed.length > 0) {
    await broadcast({ type: 'VAULT_CHANGED' });
    scheduleSync();
  }
  return changed;
}

/**
 * A projection function for one item set. The note is deliberately not on it — see {@link ListRow}.
 *
 * A builder rather than a plain function because a folder row carries its descendant count, and
 * `countsByFolder` walks the whole vault: calling it per row would make rendering a folder listing
 * quadratic in the size of the vault. It is computed at most once per view, and not at all for a
 * view with no folders in it.
 */
function rowBuilder(items: ItemMap): (item: VaultItem) => ListRow {
  let counts: ReturnType<typeof countsByFolder> | null = null;
  return (item) => {
    const base = {
      id: item.id,
      type: item.type,
      parentId: item.parentId,
      title: item.title,
      tags: tagsOf(item),
      hasNote: noteOf(item) !== '',
      // Metadata only: whether this device can reach the *bytes* is a separate question, and asking
      // it here would turn rendering a list into one storage read per row (§14.5).
      // A picture, or the text that stands in for one when the picture was refused.
      hasPreview:
        isBookmark(item) &&
        (item.thumb !== undefined || item.og?.title !== undefined || item.og?.description !== undefined),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
    if (!isBookmark(item)) {
      counts ??= countsByFolder(items);
      return { ...base, descendants: counts.get(item.id)?.descendants ?? 0 };
    }
    return {
      ...base,
      url: item.url,
      ...(item.openedAt === undefined ? {} : { openedAt: item.openedAt }),
      ...(item.openCount === undefined ? {} : { openCount: item.openCount }),
    };
  };
}

/** Ancestors from the top level down to and including `folderId`. Empty at the root. */
function crumbs(items: ItemMap, folderId: string): Crumb[] {
  if (folderId === ROOT_ID || !items.has(folderId)) return [];
  return pathOf(items, folderId).map((item) => ({ id: item.id, title: item.title }));
}
