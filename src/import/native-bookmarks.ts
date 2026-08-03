/**
 * Importing from Chrome's own bookmarks — **the only module in the project that may read
 * `chrome.bookmarks`** (INV-5, and the ESLint exemption in `eslint.config.js` names this file).
 *
 * It exists because of the one thing VaultaMark cannot do for the user: copying a bookmark into the
 * vault does not take it out of the omnibox. The native copy is still there, still autocompleting,
 * still exactly as visible as it was. Deleting it is what actually achieves what someone installed
 * this extension for — and deleting someone's bookmarks is not something an importer gets to do on
 * its own initiative.
 *
 * So the two halves are two functions, and nothing calls the second on behalf of the first:
 *
 * - {@link importNative} reads the tree and writes into the vault. It touches nothing in Chrome.
 * - {@link deleteNative} removes native bookmarks, and is reached only from a second, separately
 *   confirmed press that says exactly what it will remove.
 *
 * Everything read here is hostile in the ordinary sense: a bookmark title can be anything, a URL can
 * be a `javascript:` payload someone saved in 2013, and the tree can be deeper than any tree a
 * person built by hand. Titles are taken as text and never as markup; URLs go through the same
 * allowlist as every other way into the vault (`background/add.ts`), so an import cannot put
 * something in the vault that the add button would have refused.
 */

import { vaultableUrl } from '../background/add.js';
import type { VaultRepository } from '../storage/repo.js';
import { duplicateKeyOf, type AddItemInput, type Mutation } from '../vault/model.js';
import { ROOT_ID, isBookmark, isDeleted, type ItemMap } from '../vault/types.js';

/** The optional permission this needs. Requested in context, never at install (D26). */
export const BOOKMARKS_PERMISSION = 'bookmarks';

/**
 * One node of Chrome's tree, reduced to what we use.
 *
 * A projection rather than `chrome.bookmarks.BookmarkTreeNode` so the rest of the code — and the
 * tests — never touch the live type, and so nothing downstream can accidentally depend on a field
 * we have not thought about.
 */
export interface NativeNode {
  readonly id: string;
  readonly title: string;
  /** Absent on folders. */
  readonly url?: string;
  readonly dateAdded?: number;
  readonly children?: readonly NativeNode[];
}

export interface NativeImportResult {
  readonly bookmarks: number;
  readonly folders: number;
  /** Selected bookmarks the vault already held, matched by `duplicateKeyOf`. */
  readonly duplicates: number;
  /** Selected bookmarks whose URL the vault will not store — `javascript:`, `file:`, `chrome:`. */
  readonly skipped: number;
}

/* ------------------------------------------------------------------ the permission */

/** Whether the profile has already granted `bookmarks`. Safe to call from anywhere. */
export async function hasBookmarksPermission(): Promise<boolean> {
  return await chrome.permissions.contains({ permissions: [BOOKMARKS_PERMISSION] });
}

/**
 * Ask for the `bookmarks` permission.
 *
 * **Must be called from a page, during a user gesture** — Chrome refuses `permissions.request` from
 * a service worker outright. That is why this lives here beside the reader but is called from the
 * manager: the grant is a click, and the reading is the worker's job.
 */
export async function requestBookmarksPermission(): Promise<boolean> {
  return await chrome.permissions.request({ permissions: [BOOKMARKS_PERMISSION] });
}

/**
 * Give the permission back.
 *
 * Offered after an import because there is no reason to keep read access to someone's bookmarks
 * once the thing that needed it is done, and a permission that is only ever added is a permission
 * list that only ever grows.
 */
export async function dropBookmarksPermission(): Promise<boolean> {
  return await chrome.permissions.remove({ permissions: [BOOKMARKS_PERMISSION] });
}

/* ------------------------------------------------------------------ reading the tree */

/**
 * Chrome's bookmark tree, normalized.
 *
 * The real root is an unnamed node whose children are "Bookmarks bar", "Other bookmarks" and
 * "Mobile bookmarks"; those are what a person recognises, so the root itself is dropped and its
 * children become the top level.
 */
export async function readNativeTree(): Promise<NativeNode[]> {
  if (!(await hasBookmarksPermission())) {
    throw new BookmarksPermissionError();
  }
  const roots = await chrome.bookmarks.getTree();
  return roots.flatMap((root) => (root.children ?? []).map(normalizeNode));
}

function normalizeNode(node: chrome.bookmarks.BookmarkTreeNode): NativeNode {
  return {
    id: node.id,
    // Chrome's own folders are localized and always titled; an untitled user folder is possible.
    title: typeof node.title === 'string' ? node.title : '',
    ...(typeof node.url === 'string' ? { url: node.url } : {}),
    ...(typeof node.dateAdded === 'number' ? { dateAdded: node.dateAdded } : {}),
    ...(node.children === undefined ? {} : { children: node.children.map(normalizeNode) }),
  };
}

/* ------------------------------------------------------------------ the selection */

/** Every node in a tree, flattened. Depth-first, parents before children. */
export function flattenTree(nodes: readonly NativeNode[]): NativeNode[] {
  const out: NativeNode[] = [];
  const walk = (list: readonly NativeNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Close a selection downward and upward: a checked folder brings its contents, and a checked
 * bookmark brings the folders it lives in.
 *
 * Both directions are needed and for different reasons. Downward is what "select this folder" means
 * to anyone who ticks it. Upward is structural: importing a bookmark without its ancestors would
 * flatten it to the top level and quietly discard the filing the user is trying to preserve.
 */
export function expandSelection(
  nodes: readonly NativeNode[],
  selected: Iterable<string>,
): Set<string> {
  const wanted = new Set(selected);
  const parents = new Map<string, string>();
  const byId = new Map<string, NativeNode>();
  const walk = (list: readonly NativeNode[], parentId: string | null): void => {
    for (const node of list) {
      byId.set(node.id, node);
      if (parentId !== null) parents.set(node.id, parentId);
      if (node.children !== undefined) walk(node.children, node.id);
    }
  };
  walk(nodes, null);

  const out = new Set<string>();
  const take = (node: NativeNode): void => {
    if (out.has(node.id)) return;
    out.add(node.id);
    for (const child of node.children ?? []) take(child);
  };
  for (const id of wanted) {
    const node = byId.get(id);
    if (node === undefined) continue;
    take(node);
    let parentId = parents.get(id);
    while (parentId !== undefined) {
      out.add(parentId);
      parentId = parents.get(parentId);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ importing */

export interface NativeImportOptions {
  readonly stripTrackingParams?: boolean;
  /** Where the imported tree is filed. The top level by default. */
  readonly parentId?: string;
  readonly onProgress?: (done: number, total: number) => void;
}

/**
 * Copy a selection of native bookmarks into the vault, preserving the folder structure.
 *
 * One batch, so the whole import is one revision and one thing for the merge engine to carry — and
 * so a failure anywhere in it leaves the vault untouched rather than half-imported. The batch uses
 * the `addMany` mutation, which lays each parent's new children out in a single pass; the same
 * import built out of individual adds is quadratic and a five-thousand-bookmark tree would block the
 * worker long enough for MV3 to kill it.
 *
 * A folder whose entire contents were skipped is still created. Guessing that an empty folder was
 * not wanted is a guess, and the user ticked it.
 */
export async function importNative(
  repo: VaultRepository,
  nodes: readonly NativeNode[],
  selection: Iterable<string>,
  options: NativeImportOptions = {},
): Promise<NativeImportResult> {
  const wanted = expandSelection(nodes, selection);
  const existing = duplicateKeys(repo.items());

  const inputs: AddItemInput[] = [];
  let bookmarks = 0;
  let folders = 0;
  let duplicates = 0;
  let skipped = 0;

  // Chrome ids are strings; vault ids are UUIDs. This maps one to the other for the nodes that
  // become folders, so a child can name the parent that was created a moment earlier in the batch.
  const vaultIdByNative = new Map<string, string>();
  const total = wanted.size;
  let done = 0;

  const walk = (list: readonly NativeNode[], parentId: string): void => {
    for (const node of list) {
      if (!wanted.has(node.id)) continue;
      done += 1;
      if (done % PROGRESS_EVERY === 0) options.onProgress?.(done, total);

      if (node.url === undefined) {
        const id = crypto.randomUUID();
        vaultIdByNative.set(node.id, id);
        inputs.push({ type: 'folder', id, title: node.title, parentId });
        folders += 1;
        walk(node.children ?? [], id);
        continue;
      }

      let url: string;
      try {
        url = vaultableUrl(node.url, {
          ...(options.stripTrackingParams === undefined
            ? {}
            : { stripTrackingParams: options.stripTrackingParams }),
        });
      } catch {
        // A scheme the vault will not store. Counted and reported, never silently dropped: the
        // number is how a user finds out that four of their bookmarks did not come across.
        skipped += 1;
        continue;
      }

      const key = duplicateKeyOf(url);
      if (existing.has(key)) {
        duplicates += 1;
        continue;
      }
      // Added to the set as we go, so a tree containing the same page twice imports it once.
      existing.add(key);
      inputs.push({ type: 'bookmark', url, title: node.title, parentId });
      bookmarks += 1;
    }
  };
  walk(nodes, options.parentId ?? ROOT_ID);
  options.onProgress?.(total, total);

  if (inputs.length > 0) {
    const mutations: Mutation[] = [{ kind: 'addMany', inputs }];
    await repo.apply(mutations);
    await repo.flush();
  }
  return { bookmarks, folders, duplicates, skipped };
}

/** How often the progress callback fires while walking the tree. */
const PROGRESS_EVERY = 100;

function duplicateKeys(items: ItemMap): Set<string> {
  const keys = new Set<string>();
  for (const item of items.values()) {
    if (isDeleted(item) || !isBookmark(item)) continue;
    keys.add(duplicateKeyOf(item.url));
  }
  return keys;
}

/* ------------------------------------------------------------------ deleting the originals */

/**
 * Remove native bookmarks — **the one write this project ever makes to `chrome.bookmarks`** (INV-5).
 *
 * Reached only from an explicit second step with its own confirmation and its own summary of what it
 * will remove. It is deliberately a separate call taking explicit ids rather than a flag on the
 * import: a boolean would put "and delete the originals" one mis-click away from an import, and
 * there is no undo for this one. Chrome's own trash is not ours to restore from.
 *
 * Failures are counted rather than thrown. Chrome refuses to remove its permanent folders
 * ("Bookmarks bar" and friends), and one refusal in the middle of four hundred deletions must not
 * abandon the other three hundred and ninety-nine.
 */
export async function deleteNative(
  ids: readonly string[],
): Promise<{ removed: number; failed: number }> {
  if (!(await hasBookmarksPermission())) throw new BookmarksPermissionError();

  let removed = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      // `removeTree` handles both: Chrome accepts it for a leaf bookmark as well as a folder, and
      // an import selection that included a folder means the folder is what the user is deleting.
      await chrome.bookmarks.removeTree(id);
      removed += 1;
    } catch {
      // Nothing is logged. A failure here names a bookmark id, and the title behind it is exactly
      // the sort of thing that must never reach a console.
      failed += 1;
    }
  }
  return { removed, failed };
}

/** The `bookmarks` permission is not granted, so there is nothing to read. */
export class BookmarksPermissionError extends Error {
  constructor() {
    super('Reading the browser bookmark tree needs the optional "bookmarks" permission.');
    this.name = 'BookmarksPermissionError';
  }
}
