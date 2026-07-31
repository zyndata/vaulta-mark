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
import { dropZone } from './dnd.js';
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

  root.addEventListener('keydown', onTreeKeydown);
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
    h(
      'span',
      { class: 'vm-tree-row' },
      twisty,
      h('span', { class: 'vm-tree-title' }, node.title),
      h('span', { class: 'vm-count vm-small vm-muted' }, String(node.descendants)),
    ),
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
 * Arrow-key navigation, as the tree pattern prescribes.
 *
 * Right opens a closed folder and steps into an open one; Left closes an open folder and steps out
 * of a closed one. Up and Down walk the items that are actually visible, which is what
 * `querySelectorAll` over the rendered tree gives us for free — a collapsed subtree is not in the
 * DOM, so it cannot be stepped onto.
 */
function onTreeKeydown(event: KeyboardEvent): void {
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
