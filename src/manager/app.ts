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
  type ConflictView,
  type ErrorCode,
  type FolderNode,
  type ItemDetail,
  type ListRow,
  type StateResponse,
  type SyncStatusResponse,
} from '../shared/messages.js';
import { applyTheme, h, msg, qs, render } from '../ui/dom.js';
import { errorText, syncErrorText } from '../ui/strings.js';
import { normalizeTags } from '../vault/model.js';
import { SORT_KEYS, isSortKey, type SortKey } from '../vault/sort.js';
import {
  DETAIL_WIDTH,
  ROOT_ID,
  SIDEBAR_WIDTH,
  clampPaneWidth,
  type VaultSettings,
} from '../vault/types.js';
import {
  chooseDialog,
  confirmDialog,
  dialogField,
  dialogText,
  openDialog,
  promptText,
} from '../ui/dialog.js';
import { qrPanel } from '../ui/qr.js';
import { ThumbPopover, type ThumbData } from '../ui/thumb.js';
import { detailPane } from './detail.js';
import { ioScreen, paintProgress } from './io.js';
import { BookmarkList } from './list.js';
import { settingsScreen } from './settings.js';
import { sidebar, tagQuery } from './sidebar.js';
import { conflictBanner, conflictScreen, syncStatusButton } from './sync.js';
import {
  canReorder,
  cursorRow,
  initialState,
  refreshAll,
  refreshDetail,
  refreshHistoryPresence,
  refreshView,
  reorderParent,
  rowsOf,
  soleSelection,
  type ManagerState,
  type Scope,
} from './state.js';

/** Keystrokes settle before the vault is searched again (PLAN §9 Phase 6). */
const SEARCH_DEBOUNCE_MS = 120;

/** How long the undo offer stays up after a delete, matching the popup. */
const UNDO_MS = 8_000;

/** How long a confirmation sits in the live region before it clears itself. */
const STATUS_MS = 6_000;

/** A dragged or arrowed column width settles before it is written to settings. */
const WIDTH_SAVE_MS = 300;

export interface ManagerOptions {
  /**
   * Which screen to open on, when something outside the manager asked for one.
   *
   * Only settings, and only from the popup: everything else about the manager starts on the list.
   */
  readonly screen?: 'settings';
}

export function mountManager(
  root: HTMLElement,
  initial: StateResponse,
  options: ManagerOptions = {},
): void {
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
  const syncSlot = h('div', { class: 'vm-sync-slot' });
  const bannerSlot = h('div', { class: 'vm-banner-slot' });
  const conflictSlot = h('div', { class: 'vm-conflict-slot', hidden: true });
  const ioSlot = h('div', { class: 'vm-io-slot', hidden: true });
  const settingsSlot = h('div', { class: 'vm-settings-slot', hidden: true });
  const status = qs(document, '#vm-status');

  /** The last status the worker reported. `null` until the first answer arrives. */
  let syncState: SyncStatusResponse | null = null;

  /**
   * A run this window asked for, from press to answer.
   *
   * The flag exists so the button can say it is working: the worker's only `SYNC_CHANGED` for a run
   * is the one at the end of it, so between the click and the answer there was nothing on screen to
   * distinguish "syncing" from "ignored the click". It also stops a second press starting a second
   * run — the engine guards itself, but a disabled button is the honest way to say so.
   *
   * Declared up here beside the status it qualifies, and not down with `runSync`, because
   * `paintSync()` runs while this function is still being evaluated: a `let` further down is in its
   * temporal dead zone at that point, and reading it throws before the manager has drawn anything.
   */
  let syncing = false;

  /**
   * The nudge left behind by "skip for now" on onboarding's incognito step.
   *
   * `null` unless the flow was skipped *and* the toggle is still off. Half the promise of the product
   * is that vaulted links open in incognito, and someone who skipped past that during setup has a
   * VaultaMark that silently refuses to open anything — with the explanation on a screen they only
   * reach by trying. This is the reminder that says so before they try.
   *
   * It clears itself: the moment `INCOGNITO_ACCESS` answers `true` there is nothing to nudge about,
   * and the skip flag stays set in storage without ever being rendered again.
   */
  let incognitoNudge: HTMLElement | null = null;

  async function refreshIncognitoNudge(): Promise<void> {
    const record = await send({ type: 'GET_ONBOARDING' });
    if (record.type === 'ERROR' || !record.incognitoSkipped) return;
    const access = await send({ type: 'INCOGNITO_ACCESS' });
    if (access.type === 'ERROR' || access.allowed) return;

    incognitoNudge = h(
      'div',
      { class: 'vm-banner vm-banner--warning', role: 'status' },
      h('span', null, msg('managerIncognitoNudge')),
      h(
        'button',
        {
          type: 'button',
          class: 'vm-button vm-button--quiet vm-button--inline',
          // The guided prompt with no item behind it: the instructions and the Re-check button,
          // without offering to open a bookmark in a normal window that nobody asked for.
          onclick: () => {
            location.hash = '#incognito';
            location.reload();
          },
        },
        msg('managerIncognitoNudgeFix'),
      ),
    );
    paintSync();
  }

  /**
   * Which of the four full-window screens is up.
   *
   * One variable rather than four `hidden` attributes read back off the DOM, because the four are
   * mutually exclusive and nothing was enforcing it: each screen only ever put the *layout* away and
   * brought itself out, so opening import/export from the conflict screen left both on the page, one
   * scrolled under the other. Worse, resolving the last conflict calls `paintSync`, which used to
   * bring the layout back unconditionally — so settling a disagreement while looking at
   * import/export put the bookmark list on screen above it. `showScreen` is now the only thing that
   * touches those attributes, and it always says what all four of them are.
   */
  type Screen = 'list' | 'conflicts' | 'io' | 'settings';
  let screen: Screen = 'list';

  function showScreen(next: Screen): void {
    // Coming back to the list from anywhere else: the screen being left may well be why the answer
    // changed — the settings screen holds the site-wide cleanup, and import/export adds bookmarks
    // for pages that have been visited. Cheaper and more reliable than every screen remembering to
    // report what it did.
    if (next === 'list' && screen !== 'list') void refreshHistory();
    screen = next;
    layout.hidden = next !== 'list';
    conflictSlot.hidden = next !== 'conflicts';
    ioSlot.hidden = next !== 'io';
    settingsSlot.hidden = next !== 'settings';
    // A screen that is not on the page holds nothing: its contents are a snapshot of the vault
    // taken when it opened, and one left parked in the DOM is stale data a screen reader in browse
    // mode can still walk into. For settings that snapshot includes three password fields.
    if (next !== 'conflicts') render(conflictSlot);
    if (next !== 'io') render(ioSlot);
    if (next !== 'settings') render(settingsSlot);
  }

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
    onDragStart: (index) => beginDrag(index),
    acceptsDrop: (folderId) => acceptsDrop(folderId),
    onDropInFolder: (folderId) => {
      void dropInFolder(folderId);
    },
    reorderable: () => canReorder(state),
    onDropAt: (index, placement) => {
      void dropAt(index, placement);
    },
    onPreview: (row, anchor) => {
      preview.toggle(anchor, row.id);
    },
    onHover: (row, anchor) => {
      preview.hover(anchor, row.id);
    },
    onHoverEnd: () => {
      preview.cancelHover();
    },
  });

  const listSlot = h('div', { class: 'vm-list-slot' }, list.element, emptySlot);

  /* ---------------------------------------------------------------- the columns */

  /**
   * The two resizable columns: where each one's width is kept, and what it may be.
   *
   * A width is a number about the window rather than about the vault, which is what makes it
   * storable in plaintext `vm.settings` at all (ARCHITECTURE §5.1) — and worth storing, because a
   * column dragged to a comfortable width and reset by the next window is a column nobody drags
   * twice.
   */
  const PANES = {
    sidebar: { bounds: SIDEBAR_WIDTH, property: '--vm-sidebar-width', label: 'paneResizeSidebar' },
    detail: { bounds: DETAIL_WIDTH, property: '--vm-detail-width', label: 'paneResizeDetail' },
  } as const;
  type Pane = keyof typeof PANES;
  const PANE_KEYS = ['sidebar', 'detail'] as const;

  const resizers = new Map<Pane, HTMLElement>();

  function widthOf(pane: Pane): number {
    const stored = pane === 'sidebar' ? settings.sidebarWidth : settings.detailWidth;
    return clampPaneWidth(stored, PANES[pane].bounds);
  }

  function setPaneWidth(pane: Pane, value: number): void {
    const width = clampPaneWidth(value, PANES[pane].bounds);
    settings =
      pane === 'sidebar' ? { ...settings, sidebarWidth: width } : { ...settings, detailWidth: width };
    applyPaneWidths();
  }

  /** Push the widths into the grid. The columns are two custom properties, not two rules. */
  function applyPaneWidths(): void {
    for (const pane of PANE_KEYS) {
      const width = widthOf(pane);
      layout.style.setProperty(PANES[pane].property, `${String(width)}px`);
      resizers.get(pane)?.setAttribute('aria-valuenow', String(width));
    }
  }

  /**
   * Persist the widths, once the dragging stops.
   *
   * Debounced because the events that change a width arrive by the dozen — a pointer move, a held
   * arrow key — and each write is a storage round trip the user is waiting on a repaint behind.
   */
  let widthTimer: ReturnType<typeof setTimeout> | null = null;

  function savePaneWidths(): void {
    if (widthTimer !== null) clearTimeout(widthTimer);
    widthTimer = setTimeout(() => {
      widthTimer = null;
      void send({
        type: 'SET_SETTINGS',
        settings: { sidebarWidth: settings.sidebarWidth, detailWidth: settings.detailWidth },
      });
    }, WIDTH_SAVE_MS);
  }

  /**
   * The grab handle between two columns.
   *
   * A focusable `separator` is the window-splitter pattern, so it carries `aria-valuenow` and moves
   * on the arrow keys: a three-column layout whose proportions can only be changed with a mouse is
   * one a keyboard user is stuck with. Double-click restores the default, which is the way out of a
   * column dragged to a width that hid something.
   */
  function paneResizer(pane: Pane): HTMLElement {
    const spec = PANES[pane];
    const handle = h('div', {
      class: 'vm-resizer',
      role: 'separator',
      tabindex: 0,
      'aria-orientation': 'vertical',
      'aria-label': msg(spec.label),
      'aria-valuemin': spec.bounds.min,
      'aria-valuemax': spec.bounds.max,
      'aria-valuenow': spec.bounds.initial,
    });
    resizers.set(pane, handle);

    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      // Pointer capture rather than listeners on the window: the pointer leaves a handle this
      // narrow on the first move, and the drag has to keep following it after it has.
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('is-dragging');
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event: PointerEvent) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const box = layout.getBoundingClientRect();
      setPaneWidth(pane, pane === 'sidebar' ? event.clientX - box.left : box.right - event.clientX);
    });

    const release = (event: PointerEvent): void => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      handle.releasePointerCapture(event.pointerId);
      handle.classList.remove('is-dragging');
      savePaneWidths();
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);

    handle.addEventListener('dblclick', () => {
      setPaneWidth(pane, spec.bounds.initial);
      savePaneWidths();
    });

    handle.addEventListener('keydown', (event: KeyboardEvent) => {
      // Right always means "the separator moves right", which grows the sidebar and shrinks the
      // detail pane. Anything else makes one of the two handles feel inverted.
      const step = (event.shiftKey ? 64 : 16) * (pane === 'sidebar' ? 1 : -1);
      switch (event.key) {
        case 'ArrowRight':
          setPaneWidth(pane, widthOf(pane) + step);
          break;
        case 'ArrowLeft':
          setPaneWidth(pane, widthOf(pane) - step);
          break;
        case 'Home':
          setPaneWidth(pane, spec.bounds.min);
          break;
        case 'End':
          setPaneWidth(pane, spec.bounds.max);
          break;
        default:
          return;
      }
      event.preventDefault();
      savePaneWidths();
    });

    return handle;
  }

  const layout = h(
    'div',
    { class: 'vm-layout' },
    sidebarSlot,
    paneResizer('sidebar'),
    h('section', { class: 'vm-main' }, crumbSlot, actionSlot, countSlot, listSlot),
    paneResizer('detail'),
    detailSlot,
  );

  /**
   * The floating preview card (§14.5).
   *
   * Hosted on the layout rather than on the list, because the card has to be able to sit outside the
   * list's own scrolling box — a preview anchored to the bottom row would otherwise be clipped by
   * the very element it is anchored to.
   */
  const preview = new ThumbPopover({
    host: layout,
    fetch: async (id) => toThumbData(await send({ type: 'GET_THUMB', id })),
  });

  /** A `THUMB` answer, or the shape "there is nothing here" when the worker refused. */
  function toThumbData(response: Awaited<ReturnType<typeof send>>): ThumbData {
    if (response.type !== 'THUMB')
      return { state: 'none', image: null, width: 0, height: 0, ogTitle: null, ogDescription: null };
    return {
      state: response.state,
      image: response.image,
      width: response.width,
      height: response.height,
      ogTitle: response.ogTitle,
      ogDescription: response.ogDescription,
    };
  }

  render(
    root,
    h(
      'header',
      { class: 'vm-topbar' },
      h('h1', { class: 'vm-wordmark' }, 'VaultaMark'),
      h('div', { class: 'vm-search-slot' }, search, h('span', { class: 'vm-small vm-muted' }, msg('managerSearchHint'))),
      sortSlot,
      syncSlot,
      h(
        'button',
        {
          type: 'button',
          class: 'vm-button vm-button--quiet vm-button--inline',
          onclick: openIo,
        },
        msg('managerIoButton'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'vm-button vm-button--quiet vm-button--inline',
          onclick: () => {
            void openSettings();
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
    bannerSlot,
    layout,
    conflictSlot,
    ioSlot,
    settingsSlot,
    toastSlot,
  );

  applyPaneWidths();
  paintSync();

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
          // A tag is a filter over the whole vault, not over wherever the user happens to be
          // standing. Leaving the scope alone would answer with a silent subset and light up two
          // sidebar entries at once — which is exactly what "Untagged" plus a tag used to do.
          state.scope = { kind: 'folder', folderId: ROOT_ID };
          state.selection.clear();
          state.cursor = -1;
          // `reloadAll`, not `reloadView`: the sidebar's own highlight is what just changed.
          void reloadAll();
        },
        newFolder: () => {
          void createFolder();
        },
        editTag: (tag) => {
          void editTag(tag);
        },
        editFolder: (folder) => {
          void editFolder(folder);
        },
        acceptsDrop: (folderId) => acceptsDrop(folderId),
        onDropInFolder: (folderId) => {
          void dropInFolder(folderId);
        },
        onDropBeside: (folderId, placement) => {
          void dropBesideFolder(folderId, placement);
        },
        nudgeFolder: (folderId, step) => {
          void nudgeFolder(folderId, step);
        },
        onDragFolder: (folderId) => beginFolderDrag(folderId),
        deleteFolder: (folder) => {
          void deleteFolder(folder);
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
        loadThumb: async (id) => toThumbData(await send({ type: 'GET_THUMB', id })),
        refreshPreview: (item) => {
          void refreshPreview(item);
        },
        open: (id) => {
          void openItem(id);
        },
        showQr: (item) => {
          void showQr(item);
        },
        renameFolder: (item) => {
          void renameFolder(item);
        },
        deleteFolder: (item) => {
          void deleteFolder(item);
        },
        inHistory: state.detail !== null && state.inHistory.has(state.detail.id),
        forgetHistory: (item) => {
          void forgetHistory(item);
        },
      }),
    );
  }

  function paintList(): void {
    // Every row element is about to be rebuilt, so a card anchored to one of them is a card pinned
    // to an element that is no longer in the document — and its object URL is ours to release.
    preview.close();
    const rows = rowsOf(state);
    list.setRows(rows, state.view?.terms ?? []);
    list.setInHistory(state.inHistory);
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

  /**
   * The page's live region: what just happened, or what just failed.
   *
   * It lives outside every pane on purpose. A confirmation shown inside the detail pane is written
   * to an element that the reload triggered by the very action being confirmed has already
   * replaced — so it never appears. This one survives, because nothing else rebuilds it.
   *
   * A confirmation clears itself; an error does not. "Renamed on 12 bookmarks" is worth a moment
   * and then noise, while "that change was refused" should still be there when the user looks up
   * from the thing that failed.
   */
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  function say(text: string, kind: 'info' | 'danger' = 'info'): void {
    if (statusTimer !== null) clearTimeout(statusTimer);
    render(
      status,
      h(
        'p',
        {
          class: `vm-notice${kind === 'danger' ? ' vm-notice--danger' : ''}`,
          role: kind === 'danger' ? 'alert' : 'status',
        },
        text,
      ),
    );
    if (kind === 'danger') return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      render(status);
    }, STATUS_MS);
  }

  function warn(code: ErrorCode): void {
    say(errorText(code), 'danger');
  }

  /* ---------------------------------------------------------------- sync */

  function paintSync(): void {
    render(
      syncSlot,
      syncStatusButton({
        status: syncState,
        busy: syncing,
        onSyncNow: () => {
          void runSync();
        },
      }),
    );
    const pending = syncState?.conflicts ?? 0;
    render(
      bannerSlot,
      pending === 0
        ? null
        : conflictBanner(pending, () => {
            void showConflicts();
          }),
      incognitoNudge,
    );
    // A banner that vanished because the last conflict was settled elsewhere must not leave the
    // conflict screen up in front of an empty list. Only the conflict screen, though: this runs on
    // every `SYNC_CHANGED`, and it used to bring the layout back from underneath import/export too.
    if (pending === 0 && screen === 'conflicts') showScreen('list');
  }

  async function refreshSync(): Promise<void> {
    const response = await send({ type: 'GET_SYNC_STATUS' });
    if (response.type === 'ERROR') return;
    syncState = response;
    paintSync();
  }

  async function runSync(): Promise<void> {
    if (syncing) return;
    syncing = true;
    paintSync();
    let response;
    try {
      response = await send({ type: 'SYNC_NOW' });
    } finally {
      syncing = false;
    }
    if (response.type === 'ERROR') {
      paintSync();
      warn(response.code);
      return;
    }
    syncState = response;
    paintSync();
    if (response.error !== null) {
      say(syncErrorText(response.error), 'danger');
      return;
    }
    // Said out loud rather than left to the label. Two syncs a few seconds apart both leave it
    // reading "Last synced just now", so the label alone cannot tell the second press from a
    // press that did nothing.
    say(msg('syncNowDone'));
  }

  /**
   * The conflict screen, in place of the three-column layout.
   *
   * A screen rather than a modal: settling a disagreement means reading two versions of a note and
   * possibly going to look at something else first, and a dialog that has to be dismissed to do
   * that is a dialog people dismiss without deciding.
   */
  async function showConflicts(): Promise<void> {
    const response = await send({ type: 'LIST_CONFLICTS' });
    if (response.type === 'ERROR') {
      warn(response.code);
      return;
    }
    showScreen('conflicts');
    paintConflicts(response.conflicts);
    conflictSlot.scrollTop = 0;
  }

  function paintConflicts(conflicts: readonly ConflictView[]): void {
    render(
      conflictSlot,
      conflictScreen({
        conflicts,
        resolve: (ids, resolution) => {
          void resolveConflicts(ids, resolution);
        },
        onBack: () => {
          showScreen('list');
        },
      }),
    );
  }

  async function resolveConflicts(
    ids: readonly string[],
    resolution: 'mine' | 'theirs' | 'both',
  ): Promise<void> {
    const response = await send({ type: 'RESOLVE_CONFLICTS', ids, resolution });
    if (response.type === 'ERROR') {
      warn(response.code);
      return;
    }
    say(
      response.count === 1
        ? msg('conflictResolvedOne')
        : msg('conflictResolvedCount', [String(response.count)]),
    );
    await refreshSync();
    await reloadAll();
    // `refreshSync` may already have taken us back to the list, if that was the last one.
    if (screen === 'conflicts') await showConflicts();
  }

  /* ---------------------------------------------------------------- import and export */

  /**
   * The import/export screen, in place of the three-column layout.
   *
   * A screen for the same reason the conflict view is one: every operation on it needs a paragraph
   * before its button makes sense, and the native-bookmark picker is a tree of checkboxes that no
   * dialog has room for.
   */
  function openIo(): void {
    showScreen('io');
    render(
      ioSlot,
      ioScreen({
        say,
        onBack: () => {
          showScreen('list');
        },
        onVaultChanged: () => {
          void reloadAll();
        },
        onConflicts: () => {
          // `refreshSync` first: the conflicts an import just produced are not in `syncState` yet,
          // and leaving it stale would let the next `SYNC_CHANGED` conclude there is nothing to
          // settle and close the screen the user was sent to.
          void (async () => {
            await refreshSync();
            await showConflicts();
          })();
        },
      }),
    );
    ioSlot.scrollTop = 0;
  }

  /* ---------------------------------------------------------------- settings */

  /**
   * The settings screen, in place of the three-column layout.
   *
   * A screen rather than the dialog it used to be: eight sections do not fit in 28rem by 60vh, and
   * reading the second half of them meant scrolling a box inside a page that was not scrolling.
   *
   * Built before it is shown, the way the conflict screen is: it asks the worker for the sync status
   * first, and a quota bar that arrives a moment after the page does is one that moves the destroy
   * button under the cursor.
   */
  async function openSettings(): Promise<void> {
    const view = await settingsScreen({
      settings,
      say,
      patch: async (patch) => {
        const response = await send({ type: 'SET_SETTINGS', settings: patch });
        // A refused write used to be swallowed here, which left the control showing a setting the
        // vault does not have. The screen puts the control back; this is where the reason is said.
        if (response.type === 'ERROR') {
          warn(response.code);
          return false;
        }
        settings = response.settings;
        applyTheme(settings.theme, document.documentElement);
        return true;
      },
      onBack: () => {
        showScreen('list');
      },
      reopen: () => {
        void openSettings();
      },
      onDestroyed: () => {
        render(root, h('p', { class: 'vm-placeholder' }, msg('managerNoVault')));
      },
    });
    showScreen('settings');
    render(settingsSlot, view);
    settingsSlot.scrollTop = 0;
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

  /**
   * Re-ask which bookmarks are still in Chrome's history, and repaint what shows it.
   *
   * Not awaited by anything that draws: the answer costs a history search per vaulted domain, and a
   * list that waited for it would stall behind a browser API on every reload. The warnings appear a
   * moment after the rows do, which is the right order — the rows are the vault's answer and this is
   * the browser's.
   *
   * Guarded against overlap rather than debounced. Two runs would give the same answer, and the
   * second would spend a second's worth of `history.search` arriving at it.
   */
  let askingHistory = false;

  async function refreshHistory(): Promise<void> {
    if (askingHistory) return;
    askingHistory = true;
    const before = state.inHistory;
    try {
      await refreshHistoryPresence(state);
    } finally {
      askingHistory = false;
    }
    // Nothing moved, nothing is repainted. Rebuilding the window costs a row's worth of DOM per
    // visible row, and doing it out of the blue is how a click in flight loses the element it
    // started on.
    if (sameIds(before, state.inHistory)) return;
    list.setInHistory(state.inHistory);
    paintDetail();
  }

  function goTo(scope: Scope): void {
    state.scope = scope;
    state.selection.clear();
    state.cursor = -1;
    // Navigating is not searching, wherever it is going. A filter left in the box outranks the
    // scope in `listView`, so clicking "Untagged" with `tag:dev` still in the search field used to
    // land on the same tagged bookmarks it was already showing — with both entries highlighted.
    cancelSearchTimer();
    search.value = '';
    state.query = '';
    void reloadAll();
  }

  /* ---------------------------------------------------------------- dragging */

  /**
   * The ids the drag in flight is carrying.
   *
   * Held here rather than read back off the `DataTransfer`, because a drop target has to decide
   * whether it can accept during `dragover`, and `dataTransfer.getData` is deliberately unreadable
   * until the drop (`dnd.ts`). One drag at a time, so one variable.
   */
  let dragging: readonly string[] = [];

  function beginDrag(index: number): readonly string[] {
    const row = rowsOf(state)[index];
    if (row === undefined) return [];
    // Dragging a row that was not selected selects it first: a gesture whose scope is invisible
    // until it lands is one people have to undo to find out what it did.
    if (!state.selection.has(row.id)) selectAt(index, { toggle: false, range: false });
    dragging = [...state.selection];
    return dragging;
  }

  /**
   * A folder dragged out of the sidebar.
   *
   * It carries that one folder and deliberately **not** the list's selection, unlike `beginDrag`.
   * The two panes hold two different things: the list's selection is what the user picked in the
   * list, and a grab on a sidebar row is about the row being grabbed. Folding the selection in would
   * move bookmarks nobody was pointing at.
   */
  function beginFolderDrag(folderId: string): readonly string[] {
    dragging = [folderId];
    return dragging;
  }

  /**
   * Whether the drag may land in this folder.
   *
   * Refused up front rather than left to the worker, because `repo.apply` is all-or-nothing: one
   * folder dropped into its own subtree would refuse the other thirty-nine moves in the same batch.
   */
  function acceptsDrop(folderId: string): boolean {
    if (dragging.length === 0 || dragging.includes(folderId)) return false;
    const parents = new Map(
      (state.tree?.folders ?? []).map((folder) => [folder.id, folder.parentId]),
    );
    let at = parents.get(folderId);
    for (let depth = 0; at !== undefined && at !== ROOT_ID && depth <= parents.size; depth++) {
      if (dragging.includes(at)) return false;
      at = parents.get(at);
    }
    return true;
  }

  async function dropInFolder(parentId: string): Promise<void> {
    const ids = dragging;
    dragging = [];
    if (ids.length === 0) return;
    const response = await send({ type: 'MOVE_ITEMS', ids, parentId });
    if (response.type === 'ERROR') {
      warn(response.code);
      return;
    }
    await reloadAll();
    say(response.count === 1 ? msg('movedOne') : msg('movedCount', [String(response.count)]));
  }

  /**
   * A drop between two rows: same folder or a different one, but to a *position*.
   *
   * The anchor is the row the drop landed on, and `before` has to become "after the row above it",
   * because the model positions by predecessor. Dropping above the first row therefore anchors on
   * `null`, which `moveItem` reads as "put it first" — a distinct answer from omitting it, which
   * appends.
   *
   * Rows that are themselves being dragged are skipped when looking upwards. Without that, dragging
   * a block of three onto its own second row would anchor on a row that is about to move, and the
   * batch would land in an order nobody asked for.
   */
  async function dropAt(index: number, placement: 'before' | 'after'): Promise<void> {
    const ids = dragging;
    dragging = [];
    const parentId = reorderParent(state);
    if (ids.length === 0 || parentId === null) return;

    const rows = rowsOf(state);
    const moving = new Set(ids);
    let at = placement === 'after' ? index : index - 1;
    while (at >= 0 && moving.has(rows[at]?.id ?? '')) at--;
    const afterId = at < 0 ? null : (rows[at]?.id ?? null);

    const response = await send({ type: 'MOVE_ITEMS', ids, parentId, afterId });
    if (response.type === 'ERROR') {
      warn(response.code);
      return;
    }
    await reloadAll();
    reselect(ids);
    say(
      response.count === 1
        ? msg('reorderMovedOne')
        : msg('reorderMovedCount', [String(response.count)]),
    );
  }

  /**
   * A drop beside a folder in the sidebar tree: reorder among siblings, or re-parent to that level.
   *
   * The anchor's *parent* is the destination, which is what makes this both operations at once —
   * dropping a top-level folder just below a nested one moves it into that nesting, at that
   * position, which is the thing the insertion line was drawn between. The tree is the one place
   * this is offered unconditionally: folders have always been in their own order, and there is no
   * sort selector over the tree to disagree with.
   */
  async function dropBesideFolder(anchorId: string, placement: 'before' | 'after'): Promise<void> {
    const ids = dragging;
    dragging = [];
    if (ids.length === 0) return;

    const folders = state.tree?.folders ?? [];
    const anchor = folders.find((folder) => folder.id === anchorId);
    if (anchor === undefined) return;
    // An anchor being dragged is no anchor: the position it names is about to stop existing.
    if (ids.includes(anchorId)) return;

    const siblings = folders.filter(
      (folder) => folder.parentId === anchor.parentId && !ids.includes(folder.id),
    );
    const at = siblings.findIndex((folder) => folder.id === anchorId);
    const target = placement === 'after' ? at : at - 1;
    const afterId = target < 0 ? null : (siblings[target]?.id ?? null);

    const response = await send({
      type: 'MOVE_ITEMS',
      ids,
      parentId: anchor.parentId,
      afterId,
    });
    if (response.type === 'ERROR') {
      warn(response.code);
      return;
    }
    await reloadAll();
    say(
      response.count === 1
        ? msg('reorderMovedOne')
        : msg('reorderMovedCount', [String(response.count)]),
    );
  }

  /**
   * Alt+Up / Alt+Down on a folder in the tree: one step among its siblings.
   *
   * Expressed as a drop beside its new neighbour rather than as a swap, so it goes through exactly
   * the code the drag does — one `MOVE_ITEMS`, one revision, one thing to get right.
   */
  async function nudgeFolder(folderId: string, step: -1 | 1): Promise<void> {
    const folders = state.tree?.folders ?? [];
    const self = folders.find((folder) => folder.id === folderId);
    if (self === undefined) return;
    const siblings = folders.filter((folder) => folder.parentId === self.parentId);
    const at = siblings.findIndex((folder) => folder.id === folderId);
    const neighbour = siblings[at + step];
    if (neighbour === undefined) return;

    dragging = [folderId];
    await dropBesideFolder(neighbour.id, step === -1 ? 'before' : 'after');
    // The tree is rebuilt by `reloadAll`, so the focus has to be put back on the folder that moved
    // or a second press goes nowhere — the same reason the list's nudge reselects.
    layout
      .querySelector<HTMLElement>(`[role="treeitem"][data-folder-id="${CSS.escape(folderId)}"]`)
      ?.focus();
  }

  /**
   * Nudge the selection one place up or down — the keyboard's whole answer to dragging.
   *
   * PLAN §9 asks for "full keyboard equivalents", and a one-step nudge is the equivalent rather
   * than a lesser version of it: repeated, it reaches every position, and it needs no notion of
   * "pick up" and "put down" that a screen reader would have to narrate. Re-parenting already has
   * its keyboard route in the toolbar's *Move to…*.
   *
   * `step` is applied to the *block* of selected rows, so a contiguous multi-selection travels
   * together and a scattered one closes up around its neighbours, which is what every list that
   * does this settles on.
   */
  async function nudgeSelection(step: -1 | 1): Promise<void> {
    const parentId = reorderParent(state);
    if (parentId === null) {
      say(msg('reorderUnavailable'));
      return;
    }
    const rows = rowsOf(state);
    const chosen = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => state.selection.has(row.id));
    if (chosen.length === 0) return;

    // The row the block would step over, which is also the one that has to be stepped *past*.
    const edge = step === -1 ? (chosen[0]?.index ?? 0) : (chosen.at(-1)?.index ?? 0);
    const target = edge + step;
    if (target < 0 || target >= rows.length) return;

    // Going up: land after whatever precedes the row we are stepping over (`null` at the top).
    // Going down: land after the row we are stepping over. Both are "the predecessor", counted
    // from where the block ends up rather than from where it started.
    const afterId = step === -1 ? (rows[target - 1]?.id ?? null) : (rows[target]?.id ?? null);
    const ids = chosen.map(({ row }) => row.id);

    const response = await send({ type: 'MOVE_ITEMS', ids, parentId, afterId });
    if (response.type === 'ERROR') {
      warn(response.code);
      return;
    }
    await reloadAll();
    reselect(ids);
    say(ids.length === 1 ? msg('reorderMovedOne') : msg('reorderMovedCount', [String(ids.length)]));
  }

  /**
   * Put the selection back on the items that just moved, and the cursor on the first of them.
   *
   * A reload rebuilds the view from the worker's answer, so without this a nudge would move the
   * rows and drop the selection — and the second press of the same key would do nothing, which is
   * the difference between a shortcut and a trick.
   */
  function reselect(ids: readonly string[]): void {
    state.selection = new Set(ids);
    const rows = rowsOf(state);
    const first = rows.findIndex((row) => state.selection.has(row.id));
    state.cursor = first;
    afterSelectionChange();
    if (first >= 0) list.focus();
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

  /**
   * "Refresh preview", from the detail pane.
   *
   * It opens the page and says what to do next, and that is the whole of it — re-capturing needs a
   * script in the page, `chrome.scripting` needs either a host permission or an `activeTab` grant,
   * and `activeTab` is only ever granted by a gesture *on that tab*. VaultaMark asks for no host
   * permission at install and adding one for a decoration would be the wrong trade (INV-9, D25), so
   * the manager cannot finish the job from here. The toolbar button on the page it just opened can,
   * and the popup offers exactly that when the page in front of it is already vaulted.
   */
  async function refreshPreview(item: ItemDetail): Promise<void> {
    await openItem(item.id);
    say(msg('thumbRefreshOpened'));
  }

  /**
   * "Delete this page from Chrome's history", from the detail pane (§12.6).
   *
   * Confirmed first, and the confirmation names the page rather than counting entries: the count is
   * a second history scan away, and a dialog that had to run one before it could open would be a
   * dialog that appears a second after the button was pressed. What it does say is the part that
   * cannot be undone.
   *
   * The warning is cleared from this one row on the way out rather than by re-scanning the whole
   * vault: the worker has just deleted those entries and said how many, which is a better answer
   * than a second search would give and does not cost another second.
   */
  async function forgetHistory(item: ItemDetail): Promise<void> {
    const confirmed = await confirmDialog({
      heading: msg('detailForgetHistoryHeading', [item.title]),
      body: [dialogText('detailForgetHistoryBody'), dialogText('detailForgetHistoryNoUndo')],
      confirmLabel: msg('detailForgetHistory'),
      danger: true,
    });
    if (!confirmed) return;

    const response = await send({ type: 'FORGET_ITEM_HISTORY', id: item.id });
    if (response.type === 'ERROR') {
      warn(response.code);
      return;
    }
    const remaining = new Set(state.inHistory);
    remaining.delete(item.id);
    state.inHistory = remaining;
    list.setInHistory(state.inHistory);
    paintDetail();
    say(
      response.count === 0
        ? msg('detailForgotNothing')
        : response.count === 1
          ? msg('detailForgotOne')
          : msg('detailForgot', [String(response.count)]),
    );
  }

  /**
   * The bookmark's address as a QR code, in a dialog (§17).
   *
   * Nothing is asked of the worker: the address is already in `ItemDetail`, which is what the pane
   * behind this dialog is showing. The dialog reports rather than asks, so it has one way out and
   * no confirming button — `openDialog` labels that one "Close".
   *
   * A folder has no address; the button that calls this is only built for a bookmark.
   */
  async function showQr(item: ItemDetail): Promise<void> {
    if (item.url === undefined) return;
    await openDialog<never>({
      heading: msg('qrHeading', [item.title]),
      body: [qrPanel({ url: item.url })],
    });
  }

  async function openItem(id: string): Promise<void> {
    const response = await send({ type: 'OPEN_ITEM', id });
    if (response.type === 'ERROR') {
      warn(response.code);
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
      warn(response.code);
      return;
    }
    await reloadAll();
    say(msg('detailSaved'));
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
    if (response.type === 'ERROR') warn(response.code);
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
    if (response.type === 'ERROR') warn(response.code);
    await reloadAll();
  }

  /**
   * Delete a folder, having asked what happens to what is inside it.
   *
   * The two choices are two buttons rather than a radio group and a confirm: there is no default,
   * and a dialog with a preselected destructive answer is a dialog people dismiss by pressing
   * Enter.
   *
   * Takes the three fields it reads rather than an `ItemDetail`, because the sidebar's Delete key
   * asks the same question about a `FolderNode` and one confirmation is the point: a folder deleted
   * with a question in one pane and without one in the other is two products (the same reasoning as
   * `confirmDialog` in `ui/dialog.ts`).
   */
  async function deleteFolder(item: {
    readonly id: string;
    readonly title: string;
    readonly descendants?: number | undefined;
  }): Promise<void> {
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
    if (response.type === 'ERROR') warn(response.code);
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
    if (response.type === 'ERROR') warn(response.code);
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
      invalidMessage: () => msg('tagBulkNothing'),
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
    if (response.type === 'ERROR') warn(response.code);
    await reloadAll();
  }

  /**
   * The panel behind the pencil beside a tag: rename it everywhere, or take it off everything.
   *
   * Both answers are about the same object, which is why they are in one panel rather than a pencil
   * and a second control somewhere else. Deleting is a *second* press — the extra button closes this
   * panel and the confirmation is asked on its own, because "how many bookmarks does this touch" is
   * the fact that decides it and it belongs beside the question, not behind it.
   */
  async function editTag(tag: string): Promise<void> {
    const answer = await promptText<{ kind: 'delete' }>({
      heading: msg('tagEditHeading', [tag]),
      labelKey: 'tagRenameLabel',
      confirmLabel: msg('folderRename'),
      value: tag,
      hint: msg('tagRenameEverywhere'),
      // Blank is refused by `promptText` itself. This catches the other answer that would look
      // like it worked and rename nothing: the same tag back, in different letters or spacing.
      validate: (value) => {
        const [normalized] = normalizeTags([value]);
        if (normalized === undefined) return msg('dialogNameRequired');
        return normalized === tag ? msg('tagRenameUnchanged') : null;
      },
      extraActions: [{ label: msg('tagDeleteAction'), value: { kind: 'delete' }, danger: true }],
    });
    if (answer === null) return;
    if (typeof answer !== 'string') {
      await deleteTag(tag);
      return;
    }

    const response = await send({ type: 'RENAME_TAG', from: tag, to: answer });
    if (response.type === 'ERROR') warn(response.code);
    else say(msg('tagRenamed', [String(response.count)]));
    await reloadAll();
  }

  /**
   * Take a tag off everything that carries it, having said how much that is.
   *
   * The count comes from the tree this window already has, so the question can name it; a tag whose
   * count is unknown (the tree has not loaded) still asks, without the number. Nothing is deleted
   * but the tag itself, and the sentence says so — a "delete" beside a list of bookmarks reads as
   * "delete these bookmarks" to anyone who does not stop to read it.
   */
  async function deleteTag(tag: string): Promise<void> {
    const count = state.tree?.tags.find((entry) => entry.tag === tag)?.count;
    const confirmed = await confirmDialog({
      heading: msg('tagDeleteHeading', [tag]),
      body: [
        dialogText(
          count === undefined ? 'tagDeleteBody' : count === 1 ? 'tagDeleteBodyOne' : 'tagDeleteBodyCount',
          count === undefined ? [tag] : [tag, String(count)],
        ),
      ],
      confirmLabel: msg('tagDeleteConfirm'),
      danger: true,
    });
    if (!confirmed) return;

    const response = await send({ type: 'DELETE_TAG', tag });
    if (response.type === 'ERROR') warn(response.code);
    else say(msg('tagDeleted', [String(response.count)]));
    // A tag filter that no longer matches anything would leave the list permanently empty, in the
    // same way standing inside a deleted folder does.
    if (state.query === tagQuery(tag)) {
      state.query = '';
      search.value = '';
    }
    await reloadAll();
  }

  /**
   * The same panel for a folder, from the pencil in the tree.
   *
   * Delete hands straight to `deleteFolder`, which asks what happens to the contents — so the
   * folder's two questions are asked in the two places they were already asked, and this only put a
   * door in front of them that is where people look for one.
   */
  async function editFolder(folder: FolderNode): Promise<void> {
    const answer = await promptText<{ kind: 'delete' }>({
      heading: msg('folderEditHeading', [folder.title]),
      labelKey: 'folderNameLabel',
      confirmLabel: msg('folderRename'),
      value: folder.title,
      extraActions: [{ label: msg('folderDeleteAction'), value: { kind: 'delete' }, danger: true }],
    });
    if (answer === null) return;
    if (typeof answer !== 'string') {
      await deleteFolder(folder);
      return;
    }

    const response = await send({ type: 'UPDATE_ITEM', id: folder.id, patch: { title: answer } });
    if (response.type === 'ERROR') warn(response.code);
    await reloadAll();
  }

  /** Delete the selection, having asked, and offer one undo for the whole batch. */
  async function deleteSelection(): Promise<void> {
    const ids = [...state.selection];
    if (ids.length === 0) return;

    // Asked before it happens *and* undoable for eight seconds after. The undo is the safety net
    // for the delete you meant; the question is for the Delete key pressed at a list that had the
    // focus without the user noticing — which no toast catches, because it is gone by the time
    // anyone looks up.
    const sole = soleSelection(state);
    const confirmed = await confirmDialog({
      heading:
        ids.length === 1 && sole !== undefined
          ? msg('deleteConfirmHeadingOne', [sole.title])
          : msg('deleteConfirmHeading', [String(ids.length)]),
      body: [dialogText('deleteConfirmBody')],
      confirmLabel: msg('deleteConfirmButton'),
      danger: true,
    });
    if (!confirmed) return;

    const response = await send({ type: 'DELETE_ITEMS', ids });
    if (response.type === 'ERROR') {
      warn(response.code);
      return;
    }
    state.selection.clear();
    await reloadAll();

    const toast = h(
      'div',
      // The filling bar is the deadline, drawn (`ui/styles.css`). Same constant as the timer.
      { class: 'vm-toast vm-toast--timed', role: 'status', style: `--vm-undo-ms: ${String(UNDO_MS)}ms` },
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
              if (undone.type === 'ERROR') warn(undone.code);
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
    /*
     * Alt+Up / Alt+Down move the *items*; unmodified, the same keys move the cursor. Checked before
     * the switch because the two share a key and the modifier is the whole difference.
     *
     * Alt rather than Ctrl or Shift: Ctrl+Up/Down is "extend the cursor without the selection" in
     * every list widget, Shift+Up/Down extends the selection and this list already does that, and
     * Alt+Up/Down is what every editor and file manager uses for exactly this. It is also the pair
     * the browser does not claim.
     */
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      void nudgeSelection(event.key === 'ArrowUp' ? -1 : 1);
      event.preventDefault();
      return;
    }

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
      case 'p': {
        // The keyboard's route to a picture. The eye on a row is a `span` and cannot be tabbed to —
        // a listbox may not hold interactive descendants — so the shortcut is not a convenience
        // here, it is the equivalent.
        const row = cursorRow(state);
        const anchor = list.rowElement(state.cursor);
        if (row?.hasPreview === true && anchor !== undefined) preview.toggle(anchor, row.id);
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

  // A drag dropped on nothing still has to end. Without this the last drag's ids would still be
  // there for the next drop target that asked.
  document.addEventListener('dragend', () => {
    dragging = [];
  });

  document.addEventListener('keydown', (event: KeyboardEvent) => {
    // `/` focuses the search box — unless the user is typing into something, where a slash is a
    // slash.
    if (event.key !== '/' || isTyping(event.target)) return;
    event.preventDefault();
    search.focus();
    search.select();
  });

  /*
   * Escape leaves a full-window screen, exactly as its *Back to bookmarks* button does.
   *
   * All three of them — settings, import/export, conflicts — are the same shape: they replace the
   * layout, they are left by one button in the top corner, and until now the only way back was to
   * find that button. Escape is what the platform's own modal already answers, and these read as
   * modes for the same reason.
   *
   * Two things it deliberately does not do. It does not fire while a `<dialog>` is open: that press
   * belongs to the modal on top, which closes on it, and closing the screen underneath at the same
   * time would answer one keystroke twice. And it is *not* guarded on whether the user is typing —
   * a half-typed password or a chosen file is not work worth trapping someone in a screen for, and
   * every one of these screens keeps its state in the vault rather than in the fields.
   */
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || screen === 'list') return;
    if (document.querySelector('dialog[open]') !== null) return;
    event.preventDefault();
    showScreen('list');
  });

  onBroadcast((message) => {
    if (message.type === 'SETTINGS_CHANGED') {
      settings = message.settings;
      applyTheme(settings.theme, document.documentElement);
      applyPaneWidths();
      return;
    }
    if (message.type === 'VAULT_CHANGED') {
      void reloadAll();
      // A bookmark that was just added is the likeliest thing in the vault to be in history — it is
      // usually the page the tab was sitting on — so this is exactly when the warning has to appear
      // without the window being reopened.
      void refreshHistory();
      return;
    }
    if (message.type === 'SYNC_CHANGED') {
      syncState = message.status;
      paintSync();
      return;
    }
    if (message.type === 'IO_PROGRESS') {
      // Only while the screen that owns the bar is up. A progress broadcast that arrived because
      // another window is exporting is not this window's to render.
      if (screen === 'io') paintProgress(ioSlot, message.done, message.total);
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
  void refreshSync();
  void refreshHistory();
  void refreshIncognitoNudge();

  // Last, and not awaited by any of the above: the settings screen is built from its own questions
  // to the worker and replaces the layout rather than depending on it, so the list can go on loading
  // underneath. Back leaves the manager on a list that is already there.
  if (options.screen === 'settings') void openSettings();
}

/** Spelled out rather than derived from the key, so a renamed sort key breaks the build. */
const SORT_LABEL_KEYS: Record<SortKey, string> = {
  added: 'sortAdded',
  modified: 'sortModified',
  title: 'sortTitle',
  opened: 'sortOpened',
  opens: 'sortOpens',
  manual: 'sortManual',
};

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

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
