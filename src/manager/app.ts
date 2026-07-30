/**
 * The manager, assembled: toolbar, sidebar, list, detail pane, and the keyboard that ties them.
 *
 * This file owns the mutable state and is the only thing allowed to call `refresh*`. Every other
 * module in `src/manager/` takes what it needs as arguments and calls back — which is what keeps
 * them testable in a browser and readable on their own.
 *
 * The rendering strategy is deliberately coarse. The sidebar, the toolbar and the detail pane are
 * rebuilt wholesale when they change, because they are tens of elements and rebuilding them is
 * cheaper than tracking what moved. The *list* is the exception: it is windowed, updated in place,
 * and never torn down while the user is scrolling it.
 */

import {
  onBroadcast,
  send,
  type ItemDetail,
  type ListRow,
  type StateResponse,
} from '../shared/messages.js';
import { applyTheme, h, msg, qs, render } from '../ui/dom.js';
import { errorText } from '../ui/strings.js';
import { SORT_KEYS, isSortKey, type SortKey } from '../vault/sort.js';
import { ROOT_ID, type VaultSettings } from '../vault/types.js';
import { chooseDialog, dialogField, openDialog, promptText } from './dialog.js';
import { detailPane } from './detail.js';
import { BookmarkList } from './list.js';
import { openSettings } from './settings.js';
import { sidebar } from './sidebar.js';
import {
  cursorRow,
  initialState,
  refreshAll,
  refreshDetail,
  refreshView,
  rowsOf,
  soleSelection,
  type ManagerState,
  type Scope,
} from './state.js';

/** Keystrokes settle before the vault is searched again (PLAN §9 Phase 6). */
const SEARCH_DEBOUNCE_MS = 120;

/** How long the undo offer stays up after a delete, matching the popup. */
const UNDO_MS = 8_000;

export function mountManager(root: HTMLElement, initial: StateResponse): void {
  const state: ManagerState = initialState();
  let settings: VaultSettings = initial.settings;
  // The sort order is a stored preference, so the manager opens the way it was left.
  state.sort = settings.sortBy;

  /* ---------------------------------------------------------------- chrome */

  const search = h('input', {
    type: 'search',
    class: 'vm-search',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: msg('managerSearchPlaceholder'),
    'aria-label': msg('managerSearchLabel'),
  });

  const sortSelect = h(
    'select',
    {
      'aria-label': msg('managerSortLabel'),
      onchange: (event: Event) => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        if (!isSortKey(value)) return;
        state.sort = value;
        void reloadView();
        // Persisted, so the next window and the next session open in the same order. Fire and
        // forget: a failed write costs a preference, and blocking the repaint on it would make
        // changing the sort feel like a round trip.
        void send({ type: 'SET_SETTINGS', settings: { sortBy: value } });
      },
    },
    ...SORT_KEYS.map((key) => h('option', { value: key }, msg(SORT_LABEL_KEYS[key]))),
  );

  const sortSlot = h('div', { class: 'vm-sort' }, sortSelect);
  const sidebarSlot = h('div', { class: 'vm-sidebar-slot' });
  const detailSlot = h('div', { class: 'vm-detail-slot' });
  const crumbSlot = h('nav', { class: 'vm-crumbs', 'aria-label': msg('navFolders') });
  const actionSlot = h('div', { class: 'vm-actions', role: 'toolbar', 'aria-label': msg('actionsLabel') });
  const countSlot = h('p', { class: 'vm-count-line vm-small vm-muted', role: 'status' });
  const emptySlot = h('p', { class: 'vm-list-empty vm-muted' });
  const toastSlot = h('div', { class: 'vm-toast-slot' });
  const status = qs(document, '#vm-status');

  const list = new BookmarkList({
    onSelect: (index, modifiers) => {
      selectAt(index, modifiers);
    },
    onActivate: (row) => {
      void activate(row);
    },
    onKey: (event) => {
      onListKey(event);
    },
  });

  const listSlot = h('div', { class: 'vm-list-slot' }, list.element, emptySlot);

  render(
    root,
    h(
      'header',
      { class: 'vm-topbar' },
      h('h1', { class: 'vm-wordmark' }, 'VaultaMark'),
      h('div', { class: 'vm-search-slot' }, search, h('span', { class: 'vm-small vm-muted' }, msg('managerSearchHint'))),
      sortSlot,
      h(
        'button',
        {
          type: 'button',
          class: 'vm-button vm-button--quiet vm-button--inline',
          onclick: () => {
            void openSettings({
              settings,
              patch: async (patch) => {
                const response = await send({ type: 'SET_SETTINGS', settings: patch });
                if (response.type !== 'ERROR') {
                  settings = response.settings;
                  applyTheme(settings.theme, document.documentElement);
                }
              },
              onDestroyed: () => {
                render(root, h('p', { class: 'vm-placeholder' }, msg('managerNoVault')));
              },
            });
          },
        },
        msg('managerSettingsButton'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'vm-button vm-button--danger vm-button--inline',
          onclick: () => {
            void send({ type: 'LOCK' });
          },
        },
        msg('managerLockButton'),
      ),
    ),
    h(
      'div',
      { class: 'vm-layout' },
      sidebarSlot,
      h('section', { class: 'vm-main' }, crumbSlot, actionSlot, countSlot, listSlot),
      detailSlot,
    ),
    toastSlot,
  );

  /* ---------------------------------------------------------------- painting */

  function paintSidebar(): void {
    render(
      sidebarSlot,
      sidebar({
        tree: state.tree,
        scope: state.scope,
        query: state.query,
        goTo: (scope) => {
          goTo(scope);
        },
        searchFor: (query) => {
          // The box is filled programmatically, so no `input` fires and no debounce is pending —
          // but one may be left over from typing a moment ago, and it must not overwrite this.
          cancelSearchTimer();
          search.value = query;
          state.query = query;
          state.selection.clear();
          state.cursor = -1;
          void reloadView();
        },
        newFolder: () => {
          void createFolder();
        },
        renameTag: (tag) => {
          void renameTag(tag);
        },
      }),
    );
  }

  function paintDetail(): void {
    render(
      detailSlot,
      detailPane({
        item: state.detail,
        selectionCount: state.selection.size,
        save: saveDetail,
        open: (id) => {
          void openItem(id);
        },
        renameFolder: (item) => {
          void renameFolder(item);
        },
        deleteFolder: (item) => {
          void deleteFolder(item);
        },
      }),
    );
  }

  function paintList(): void {
    const rows = rowsOf(state);
    list.setRows(rows, state.view?.terms ?? []);
    list.setSelection(state.selection, state.cursor);

    paintCount();
    emptySlot.textContent = rows.length > 0 ? '' : emptyMessage();
    emptySlot.hidden = rows.length > 0;
    list.element.hidden = rows.length === 0;

    // A ranked search has no sort order to choose, so the control says so rather than sitting there
    // doing nothing.
    const ranked = state.view?.ranked === true;
    render(
      sortSlot,
      ranked ? h('p', { class: 'vm-small vm-muted' }, msg('managerSortRanked')) : sortSelect,
    );
    sortSelect.value = state.sort;

    render(
      crumbSlot,
      ...(state.view?.path ?? []).flatMap((crumb, index) => [
        index === 0 ? null : h('span', { class: 'vm-crumb-sep', role: 'presentation' }, '/'),
        h(
          'button',
          {
            type: 'button',
            class: 'vm-crumb',
            onclick: () => {
              goTo({ kind: 'folder', folderId: crumb.id });
            },
          },
          crumb.title,
        ),
      ]),
    );

    paintActions();
  }

  /**
   * The line above the list: how many bookmarks are in view, or how many are selected.
   *
   * Separate from `paintList` because selecting a row changes it without changing the data — and
   * a count that only updated on a reload would sit there reading "143 bookmarks" while the user
   * had seven of them selected.
   */
  function paintCount(): void {
    const bookmarks = rowsOf(state).filter((row) => row.type === 'bookmark').length;
    countSlot.textContent =
      state.selection.size > 0
        ? msg('selectionCount', [String(state.selection.size)])
        : bookmarks === 1
          ? msg('listCountOneBookmark')
          : msg('listCountBookmarks', [String(bookmarks)]);
  }

  function paintActions(): void {
    const selected = state.selection.size;
    const sole = soleSelection(state);
    render(
      actionSlot,
      action('actionOpen', selected !== 1 || sole?.type !== 'bookmark', () => {
        if (sole !== undefined) void openItem(sole.id);
      }),
      action('actionMove', selected === 0, () => {
        void moveSelection();
      }),
      action('actionTag', selected === 0, () => {
        void tagSelection();
      }),
      action('actionDelete', selected === 0, () => {
        void deleteSelection();
      }),
      action('actionSelectAll', rowsOf(state).length === 0, () => {
        for (const row of rowsOf(state)) state.selection.add(row.id);
        afterSelectionChange();
      }),
      action('actionClearSelection', selected === 0, () => {
        state.selection.clear();
        afterSelectionChange();
      }),
    );
  }

  function action(labelKey: string, disabled: boolean, onClick: () => void): HTMLElement {
    return h(
      'button',
      { type: 'button', class: 'vm-button vm-button--quiet vm-button--inline', disabled, onclick: onClick },
      msg(labelKey),
    );
  }

  function emptyMessage(): string {
    if (state.error !== null) return errorText(state.error);
    if (state.query.trim() !== '') return msg('listEmptySearch');
    if (state.scope.kind === 'untagged') return msg('listEmptyUntagged');
    if (state.scope.folderId !== ROOT_ID) return msg('listEmptyFolder');
    return msg('listEmptyVault');
  }

  function say(text: string): void {
    render(status, h('p', { class: 'vm-notice', role: 'status' }, text));
  }

  /* ---------------------------------------------------------------- loading */

  async function reloadView(): Promise<void> {
    await refreshView(state);
    await refreshDetail(state);
    paintList();
    paintDetail();
  }

  async function reloadAll(): Promise<void> {
    await refreshAll(state);
    await refreshDetail(state);
    paintSidebar();
    paintList();
    paintDetail();
  }

  function goTo(scope: Scope): void {
    state.scope = scope;
    state.selection.clear();
    state.cursor = -1;
    // Navigating to a folder is not a search; leaving the box filled would show its results instead.
    if (scope.kind === 'folder') {
      cancelSearchTimer();
      search.value = '';
      state.query = '';
    }
    void reloadAll();
  }

  /* ---------------------------------------------------------------- selection */

  function selectAt(index: number, modifiers: { toggle: boolean; range: boolean }): void {
    const rows = rowsOf(state);
    const row = rows[index];
    if (row === undefined) return;

    if (modifiers.range && state.cursor >= 0) {
      const [from, to] = [Math.min(state.cursor, index), Math.max(state.cursor, index)];
      for (let at = from; at <= to; at++) {
        const inRange = rows[at];
        if (inRange !== undefined) state.selection.add(inRange.id);
      }
    } else if (modifiers.toggle) {
      if (state.selection.has(row.id)) state.selection.delete(row.id);
      else state.selection.add(row.id);
    } else {
      state.selection.clear();
      state.selection.add(row.id);
    }
    state.cursor = index;
    afterSelectionChange();
  }

  function afterSelectionChange(): void {
    list.setSelection(state.selection, state.cursor);
    paintCount();
    paintActions();
    void refreshDetail(state).then(paintDetail);
  }

  function moveCursor(delta: number): void {
    const rows = rowsOf(state);
    if (rows.length === 0) return;
    const next = Math.max(0, Math.min(rows.length - 1, (state.cursor < 0 ? -1 : state.cursor) + delta));
    selectAt(next, { toggle: false, range: false });
  }

  /* ---------------------------------------------------------------- actions */

  async function activate(row: ListRow): Promise<void> {
    if (row.type === 'folder') goTo({ kind: 'folder', folderId: row.id });
    else await openItem(row.id);
  }

  async function openItem(id: string): Promise<void> {
    const response = await send({ type: 'OPEN_ITEM', id });
    if (response.type === 'ERROR') {
      say(errorText(response.code));
      return;
    }
    if (response.status === 'needs-incognito-access') {
      // The guided prompt is a screen on this very page; navigating to the hash is enough, but the
      // page has to reload for the router at the top of manager.ts to pick it up.
      location.hash = `#incognito=${encodeURIComponent(id)}`;
      location.reload();
    }
  }

  async function saveDetail(patch: {
    title: string;
    url?: string;
    note: string | null;
    tags: string[] | null;
  }): Promise<void> {
    const item = state.detail;
    if (item === null) return;
    const response = await send({
      type: 'UPDATE_ITEM',
      id: item.id,
      patch: {
        title: patch.title,
        ...(patch.url === undefined ? {} : { url: patch.url }),
        ...(item.type === 'folder' ? {} : { note: patch.note, tags: patch.tags }),
      },
    });
    if (response.type === 'ERROR') {
      say(errorText(response.code));
      return;
    }
    await reloadAll();
  }

  async function createFolder(): Promise<void> {
    const title = await promptText({
      heading: msg('folderNewHeading'),
      labelKey: 'folderNameLabel',
      confirmLabel: msg('folderCreate'),
    });
    if (title === null) return;
    const parentId = state.scope.kind === 'folder' ? state.scope.folderId : ROOT_ID;
    const response = await send({
      type: 'CREATE_FOLDER',
      title,
      ...(parentId === ROOT_ID ? {} : { parentId }),
    });
    if (response.type === 'ERROR') say(errorText(response.code));
    await reloadAll();
  }

  async function renameFolder(item: ItemDetail): Promise<void> {
    const title = await promptText({
      heading: msg('folderRenameHeading'),
      labelKey: 'folderNameLabel',
      confirmLabel: msg('folderRename'),
      value: item.title,
    });
    if (title === null) return;
    const response = await send({ type: 'UPDATE_ITEM', id: item.id, patch: { title } });
    if (response.type === 'ERROR') say(errorText(response.code));
    await reloadAll();
  }

  /**
   * Delete a folder, having asked what happens to what is inside it.
   *
   * The two choices are two buttons rather than a radio group and a confirm: there is no default,
   * and a dialog with a preselected destructive answer is a dialog people dismiss by pressing
   * Enter.
   */
  async function deleteFolder(item: ItemDetail): Promise<void> {
    const mode = await chooseDialog<'reparent' | 'recursive'>({
      heading: msg('folderDeleteHeading', [item.title]),
      body: [h('p', null, msg('folderDeleteQuestion', [String(item.descendants ?? 0)]))],
      choices: [
        { label: msg('folderDeleteReparent'), value: 'reparent' },
        { label: msg('folderDeleteRecursive'), value: 'recursive', danger: true },
      ],
    });
    if (mode === null) return;

    const response = await send({ type: 'DELETE_FOLDER', id: item.id, mode });
    if (response.type === 'ERROR') say(errorText(response.code));
    // Standing inside a folder that no longer exists would leave the list permanently empty.
    if (state.scope.kind === 'folder' && state.scope.folderId === item.id) {
      state.scope = { kind: 'folder', folderId: ROOT_ID };
    }
    state.selection.clear();
    await reloadAll();
  }

  async function moveSelection(): Promise<void> {
    const folders = state.tree?.folders ?? [];
    const select = h(
      'select',
      { 'aria-label': msg('moveHeading') },
      h('option', { value: ROOT_ID }, msg('moveTopLevel')),
      ...folders.map((folder) => h('option', { value: folder.id }, folder.title)),
    );
    const parentId = await openDialog<string>({
      heading: msg('moveHeading'),
      body: [dialogField('navFolders', select)],
      confirmLabel: msg('moveConfirm'),
      focus: select,
      onConfirm: () => select.value,
    });
    if (parentId === null) return;

    const response = await send({
      type: 'MOVE_ITEMS',
      ids: [...state.selection],
      parentId,
    });
    if (response.type === 'ERROR') say(errorText(response.code));
    await reloadAll();
  }

  async function tagSelection(): Promise<void> {
    const add = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
    const remove = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
    const chosenTags = await openDialog<{ add: string[]; remove: string[] }>({
      heading: msg('tagBulkHeading'),
      body: [
        dialogField('tagBulkAdd', add),
        dialogField('tagBulkRemove', remove, msg('tagBulkHint')),
      ],
      confirmLabel: msg('tagBulkApply'),
      focus: add,
      onConfirm: () => {
        const value = { add: splitTags(add.value), remove: splitTags(remove.value) };
        return value.add.length === 0 && value.remove.length === 0 ? null : value;
      },
    });
    if (chosenTags === null) return;

    const response = await send({
      type: 'TAG_ITEMS',
      ids: [...state.selection],
      add: chosenTags.add,
      remove: chosenTags.remove,
    });
    if (response.type === 'ERROR') say(errorText(response.code));
    await reloadAll();
  }

  async function renameTag(tag: string): Promise<void> {
    const to = await promptText({
      heading: msg('tagRenameHeading', [tag]),
      labelKey: 'tagRenameLabel',
      confirmLabel: msg('folderRename'),
      value: tag,
      hint: msg('tagRenameEverywhere'),
    });
    if (to === null) return;
    const response = await send({ type: 'RENAME_TAG', from: tag, to });
    if (response.type === 'ERROR') say(errorText(response.code));
    else say(msg('tagRenamed', [String(response.count)]));
    await reloadAll();
  }

  /** Delete the selection, and offer one undo for the whole batch. */
  async function deleteSelection(): Promise<void> {
    const ids = [...state.selection];
    if (ids.length === 0) return;
    const response = await send({ type: 'DELETE_ITEMS', ids });
    if (response.type === 'ERROR') {
      say(errorText(response.code));
      return;
    }
    state.selection.clear();
    await reloadAll();

    const toast = h(
      'div',
      { class: 'vm-toast', role: 'status' },
      h('span', null, msg('deletedCount', [String(ids.length)])),
      h(
        'button',
        {
          type: 'button',
          class: 'vm-button vm-button--quiet vm-button--inline',
          onclick: () => {
            void (async () => {
              render(toastSlot);
              const undone = await send({ type: 'RESTORE_ITEMS', ids });
              if (undone.type === 'ERROR') say(errorText(undone.code));
              await reloadAll();
            })();
          },
        },
        msg('vaultUndo'),
      ),
    );
    render(toastSlot, toast);
    setTimeout(() => {
      if (toast.isConnected) render(toastSlot);
    }, UNDO_MS);
  }

  /* ---------------------------------------------------------------- keyboard */

  function onListKey(event: KeyboardEvent): void {
    switch (event.key) {
      case 'j':
      case 'ArrowDown':
        moveCursor(1);
        break;
      case 'k':
      case 'ArrowUp':
        moveCursor(-1);
        break;
      case 'Home':
        if (rowsOf(state).length > 0) selectAt(0, { toggle: false, range: false });
        break;
      case 'End':
        if (rowsOf(state).length > 0) {
          selectAt(rowsOf(state).length - 1, { toggle: false, range: false });
        }
        break;
      case 'Enter': {
        const row = cursorRow(state);
        if (row !== undefined) void activate(row);
        break;
      }
      case 'e': {
        // Move to the detail pane's first field rather than opening a second editor: there is one
        // place an item is edited, and this is the shortcut to it.
        const title = detailSlot.querySelector<HTMLElement>('input[type="text"]');
        title?.focus();
        break;
      }
      case 'Delete':
      case 'Backspace':
        void deleteSelection();
        break;
      case 'a':
        if (!event.ctrlKey && !event.metaKey) return;
        for (const row of rowsOf(state)) state.selection.add(row.id);
        afterSelectionChange();
        break;
      case 'Escape':
        state.selection.clear();
        afterSelectionChange();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /* ---------------------------------------------------------------- wiring */

  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelSearchTimer(): void {
    if (searchTimer === null) return;
    clearTimeout(searchTimer);
    searchTimer = null;
  }

  search.addEventListener('input', () => {
    cancelSearchTimer();
    searchTimer = setTimeout(() => {
      searchTimer = null;
      // **Only when the query actually changed.** A debounced handler fires a tenth of a second
      // after the last keystroke, by which time the user may already have clicked a row — and
      // clearing the selection then loses a selection nothing visible asked to lose. It is also
      // simply correct: a settled keystroke that leaves the query where it was has nothing to do.
      if (search.value === state.query) return;
      state.query = search.value;
      state.selection.clear();
      state.cursor = -1;
      void reloadView();
    }, SEARCH_DEBOUNCE_MS);
  });
  search.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    cancelSearchTimer();
    search.value = '';
    state.query = '';
    void reloadView();
  });

  document.addEventListener('keydown', (event: KeyboardEvent) => {
    // `/` focuses the search box — unless the user is typing into something, where a slash is a
    // slash.
    if (event.key !== '/' || isTyping(event.target)) return;
    event.preventDefault();
    search.focus();
    search.select();
  });

  onBroadcast((message) => {
    if (message.type === 'SETTINGS_CHANGED') {
      settings = message.settings;
      applyTheme(settings.theme, document.documentElement);
      return;
    }
    if (message.type === 'VAULT_CHANGED') {
      void reloadAll();
      return;
    }
    if (message.type === 'SESSION_LOCKED') {
      // Nothing decrypted may stay on screen, and the manager cannot unlock — that is the popup's
      // job, and it is one click away.
      render(root, h('p', { class: 'vm-placeholder' }, msg('managerLocked')));
    }
  });

  applyTheme(settings.theme, document.documentElement);
  void reloadAll();
}

/** Spelled out rather than derived from the key, so a renamed sort key breaks the build. */
const SORT_LABEL_KEYS: Record<SortKey, string> = {
  added: 'sortAdded',
  modified: 'sortModified',
  title: 'sortTitle',
  opened: 'sortOpened',
  opens: 'sortOpens',
};

function splitTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || element?.isContentEditable === true;
}
