/**
 * The sidebar: where you are in the vault, and the two ways of getting somewhere else.
 *
 * It is **navigation only**. Renaming and deleting a folder happen in the detail pane, where a
 * folder lands once it is selected in the main list, for two reasons: a `tree` whose items each
 * contain a row of buttons is a shape assistive technology handles badly, and there is exactly one
 * place in this UI where an item's properties live, which is easier to learn than two.
 *
 * The folder tree is a real ARIA tree — `aria-expanded`, `aria-level`, `aria-selected`, and a
 * roving tabindex so it is one tab stop rather than one per folder. The tag list is a plain list of
 * buttons, because a tag is a saved search rather than a place.
 *
 * **There are no user-defined saved filters.** PLAN §9 lists them, and the honest reason they are
 * not here is INV-6: a saved filter is a query string, a query string is a phrase the user chose
 * out of their own bookmarks, and the only place to persist one is `vm.settings`, which is
 * plaintext by design. The two built-in filters below need nothing persisted.
 */

import { h, msg, render } from '../ui/dom.js';
import type { FolderNode, TagCount, TreeResponse } from '../shared/messages.js';
import { ROOT_ID } from '../vault/types.js';
import { dropZone, startItemDrag } from './dnd.js';
import type { Scope } from './state.js';

export interface SidebarDeps {
  readonly tree: TreeResponse | null;
  readonly scope: Scope;
  readonly query: string;
  readonly goTo: (scope: Scope) => void;
  readonly searchFor: (query: string) => void;
  readonly newFolder: () => void;
  readonly renameTag: (tag: string) => void;
  /** Whether the drag in flight may land in this folder. `ROOT_ID` is the top level. */
  readonly acceptsDrop: (folderId: string) => boolean;
  readonly onDropInFolder: (folderId: string) => void;
  /** A folder has started being dragged. Returns the ids the drag carries, or none to refuse it. */
  readonly onDragFolder: (folderId: string) => readonly string[];
  /** Delete the folder, having asked what happens to what is inside it. */
  readonly deleteFolder: (folder: FolderNode) => void;
}

interface TreeNode extends FolderNode {
  readonly children: TreeNode[];
}

/** Folders that are open. Module scope so a re-render does not collapse the tree under the user. */
const expanded = new Set<string>();

export function sidebar(deps: SidebarDeps): HTMLElement {
  const nav = h('nav', { class: 'vm-sidebar', 'aria-label': msg('navSidebarLabel') });
  const tree = deps.tree;

  const scopeIsAll = deps.scope.kind === 'folder' && deps.scope.folderId === ROOT_ID;

  // The top level is a drop target too: without it, a bookmark that went into a folder by drag
  // could only come back out through the *Move to…* dialog.
  const allBookmarks = navButton(
    msg('navAllBookmarks'),
    tree?.total,
    scopeIsAll && deps.query === '',
    () => {
      deps.goTo({ kind: 'folder', folderId: ROOT_ID });
    },
  );
  dropZone(allBookmarks, {
    accepts: () => deps.acceptsDrop(ROOT_ID),
    onDrop: () => {
      deps.onDropInFolder(ROOT_ID);
    },
  });

  render(
    nav,
    h(
      'ul',
      { class: 'vm-nav-list' },
      h('li', null, allBookmarks),
      h(
        'li',
        null,
        navButton(msg('navUntagged'), tree?.untagged, deps.scope.kind === 'untagged', () => {
          deps.goTo({ kind: 'untagged' });
        }),
      ),
    ),

    h(
      'div',
      { class: 'vm-nav-section' },
      h('h2', { class: 'vm-nav-heading' }, msg('navFolders')),
      h(
        'button',
        {
          type: 'button',
          class: 'vm-button vm-button--quiet vm-button--inline',
          onclick: deps.newFolder,
        },
        msg('navNewFolder'),
      ),
    ),
    folderTree(deps, tree?.folders ?? []),

    h(
      'div',
      { class: 'vm-nav-section' },
      h('h2', { class: 'vm-nav-heading' }, msg('navTags')),
    ),
    tagList(deps, tree?.tags ?? []),
  );

  return nav;
}

/* ------------------------------------------------------------------ folders */

function folderTree(deps: SidebarDeps, folders: readonly FolderNode[]): HTMLElement {
  if (folders.length === 0) {
    return h('p', { class: 'vm-nav-empty vm-small vm-muted' }, msg('navNoFolders'));
  }

  const roots = buildTree(folders);
  const selectedId = deps.scope.kind === 'folder' ? deps.scope.folderId : null;

  // The tree's keyboard handler is delegated to the root — a listener per folder would be one per
  // row of a tree that is rebuilt on every navigation — so the row it fires on is a DOM element, and
  // Delete needs the folder behind it. This is that lookup.
  const byId = new Map(folders.map((folder) => [folder.id, folder]));

  const build = (nodes: readonly TreeNode[], level: number): HTMLElement =>
    h(
      'ul',
      level === 1 ? { class: 'vm-tree', role: 'tree' } : { role: 'group' },
      ...nodes.map((node) => treeItem(deps, node, level, selectedId, build)),
    );

  const root = build(roots, 1);

  // Roving tabindex: the tree is one tab stop, not one per folder. The open folder owns the stop —
  // but it may be inside a collapsed ancestor and so not rendered at all, in which case the first
  // folder on screen takes it. Decided from the DOM because that is what "on screen" means here.
  const rendered = [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  if (!rendered.some((item) => item.tabIndex === 0)) rendered[0]?.setAttribute('tabindex', '0');

  root.addEventListener('keydown', (event: KeyboardEvent) => {
    onTreeKeydown(event, deps, byId);
  });
  return root;
}

function treeItem(
  deps: SidebarDeps,
  node: TreeNode,
  level: number,
  selectedId: string | null,
  build: (nodes: readonly TreeNode[], level: number) => HTMLElement,
): HTMLElement {
  const hasChildren = node.children.length > 0;
  const open = expanded.has(node.id);
  const selected = node.id === selectedId;

  const twisty = hasChildren
    ? h(
        'span',
        {
          class: 'vm-twisty',
          role: 'presentation',
          onclick: (event: Event) => {
            // The row navigates; the twisty only opens. Without this the two fight over one click.
            event.stopPropagation();
            toggle(node.id);
            deps.goTo(deps.scope);
          },
        },
        open ? '▾' : '▸',
      )
    : h('span', { class: 'vm-twisty vm-twisty--leaf', role: 'presentation' });

  // The row is the draggable thing, not the `li`: an `li` that has been opened contains the `ul` of
  // its children, so a draggable `li` would let a grab anywhere in an expanded subtree start a drag
  // of the ancestor — including on a child row, which has its own drag to start.
  const row = h(
    'span',
    // The string, not `true`: `h` renders a boolean attribute as `draggable=""`, which is not one of
    // the enumerated attribute's two valid values and leaves a `span` at its default of not
    // draggable at all. The list's rows spell it the same way, for the same reason.
    { class: 'vm-tree-row', draggable: 'true' },
    twisty,
    h('span', { class: 'vm-tree-title' }, node.title),
    h('span', { class: 'vm-count vm-small vm-muted' }, String(node.descendants)),
  );

  row.addEventListener('dragstart', (event: DragEvent) => {
    // `preventDefault` on a refusal, because the default action of `dragstart` is to *start* the
    // drag: returning without it would begin a drag carrying no payload, which every drop target
    // would then decline for the wrong reason.
    if (!startItemDrag(event, deps.onDragFolder(node.id))) event.preventDefault();
  });

  const item = h(
    'li',
    {
      class: `vm-tree-item${selected ? ' is-current' : ''}`,
      role: 'treeitem',
      'aria-level': level,
      'aria-selected': selected ? 'true' : 'false',
      tabindex: selected ? 0 : -1,
      ...(hasChildren ? { 'aria-expanded': open ? 'true' : 'false' } : {}),
      onclick: (event: Event) => {
        event.stopPropagation();
        deps.goTo({ kind: 'folder', folderId: node.id });
      },
    },
    row,
  );
  item.dataset['folderId'] = node.id;

  dropZone(item, {
    accepts: () => deps.acceptsDrop(node.id),
    onDrop: () => {
      deps.onDropInFolder(node.id);
    },
  });

  if (hasChildren && open) item.append(build(node.children, level + 1));
  return item;
}

function toggle(id: string): void {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
}

/**
 * Arrow-key navigation, as the tree pattern prescribes — plus Delete.
 *
 * Right opens a closed folder and steps into an open one; Left closes an open folder and steps out
 * of a closed one. Up and Down walk the items that are actually visible, which is what
 * `querySelectorAll` over the rendered tree gives us for free — a collapsed subtree is not in the
 * DOM, so it cannot be stepped onto.
 *
 * **Delete acts on the focused folder, not on the current one.** They are usually the same, because
 * arrowing onto a folder does not navigate into it and clicking one does both — but "the folder the
 * keyboard is on" is the only reading that is true in every case, and a Delete key that acted on
 * something other than the row under the focus ring would be the worst possible kind of wrong. It
 * goes through the same question as the detail pane's button (`app.ts`), so what happens to the
 * contents is still asked rather than assumed.
 */
function onTreeKeydown(
  event: KeyboardEvent,
  deps: SidebarDeps,
  byId: ReadonlyMap<string, FolderNode>,
): void {
  const current = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]');
  const root = event.currentTarget as HTMLElement;
  if (current === null || current === undefined) return;

  const visible = [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const index = visible.indexOf(current);
  const isOpen = current.getAttribute('aria-expanded') === 'true';
  const hasChildren = current.hasAttribute('aria-expanded');
  const id = current.dataset['folderId'];

  const focusAt = (next: number): void => {
    const target = visible[Math.max(0, Math.min(visible.length - 1, next))];
    if (target === undefined) return;
    for (const item of visible) item.tabIndex = -1;
    target.tabIndex = 0;
    target.focus();
  };

  switch (event.key) {
    case 'ArrowDown':
      focusAt(index + 1);
      break;
    case 'ArrowUp':
      focusAt(index - 1);
      break;
    case 'Home':
      focusAt(0);
      break;
    case 'End':
      focusAt(visible.length - 1);
      break;
    case 'ArrowRight':
      if (hasChildren && !isOpen && id !== undefined) {
        toggle(id);
        current.click();
      } else if (isOpen) focusAt(index + 1);
      break;
    case 'ArrowLeft':
      if (isOpen && id !== undefined) {
        toggle(id);
        current.click();
      } else {
        const level = Number(current.getAttribute('aria-level'));
        for (let back = index - 1; back >= 0; back--) {
          if (Number(visible[back]?.getAttribute('aria-level')) < level) {
            focusAt(back);
            break;
          }
        }
      }
      break;
    case 'Enter':
    case ' ':
      current.click();
      break;
    case 'Delete':
    case 'Backspace': {
      const folder = id === undefined ? undefined : byId.get(id);
      if (folder === undefined) return;
      deps.deleteFolder(folder);
      break;
    }
    default:
      return;
  }
  event.preventDefault();
}

/** Flat list → nesting. A folder whose parent is missing is shown at the top rather than lost. */
function buildTree(folders: readonly FolderNode[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const folder of folders) nodes.set(folder.id, { ...folder, children: [] });

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parentId);
    if (parent === undefined || parent === node) roots.push(node);
    else parent.children.push(node);
  }

  const byTitle = (a: TreeNode, b: TreeNode): number =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }) ||
    (a.id < b.id ? -1 : 1);
  const sortDeep = (list: TreeNode[]): void => {
    list.sort(byTitle);
    for (const node of list) sortDeep(node.children);
  };
  sortDeep(roots);
  return roots;
}

/* ------------------------------------------------------------------ tags */

function tagList(deps: SidebarDeps, tags: readonly TagCount[]): HTMLElement {
  if (tags.length === 0) {
    return h('p', { class: 'vm-nav-empty vm-small vm-muted' }, msg('navNoTags'));
  }
  return h(
    'ul',
    { class: 'vm-tag-list' },
    ...tags.map((entry) =>
      h(
        'li',
        { class: 'vm-tag-row' },
        h(
          'button',
          {
            type: 'button',
            class: `vm-tag${deps.query === tagQuery(entry.tag) ? ' is-current' : ''}`,
            'aria-label': msg('tagFilterBy', [entry.tag]),
            onclick: () => {
              deps.searchFor(tagQuery(entry.tag));
            },
          },
          h('span', { class: 'vm-tag-name' }, entry.tag),
          h('span', { class: 'vm-count vm-small vm-muted' }, String(entry.count)),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'vm-icon-button',
            'aria-label': msg('tagRenameAction', [entry.tag]),
            title: msg('tagRenameAction', [entry.tag]),
            onclick: () => {
              deps.renameTag(entry.tag);
            },
          },
          '✎',
        ),
      ),
    ),
  );
}

/**
 * A tag filter, quoted the way the query grammar needs it.
 *
 * `parseQuery` splits on whitespace, so a tag with a space in it cannot be expressed as a `tag:`
 * filter at all. Rather than produce a query that silently means something else, a multi-word tag
 * is searched for as free text — which finds it, because tags are an indexed field.
 */
function tagQuery(tag: string): string {
  return tag.includes(' ') ? tag : `tag:${tag}`;
}

function navButton(
  label: string,
  count: number | undefined,
  current: boolean,
  onClick: () => void,
): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: `vm-nav-button${current ? ' is-current' : ''}`,
      'aria-current': current ? 'true' : false,
      onclick: onClick,
    },
    h('span', null, label),
    count === undefined
      ? null
      : h('span', { class: 'vm-count vm-small vm-muted' }, String(count)),
  );
}
