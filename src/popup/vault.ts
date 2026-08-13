/**
 * The unlocked popup: add this page, find something, open it in incognito, delete it, undo that.
 *
 * Everything here is a message to the service worker. The popup holds no key, no repository and no
 * copy of the vault beyond the rows currently on screen — it asks for a list, renders it, and
 * throws it away when the window closes, which for a popup is a few seconds later.
 *
 * The two states worth designing rather than defaulting:
 *
 * - **A duplicate is not an error.** Adding a page that is already vaulted answers with the item
 *   that was already there and offers to open it, because that is what the user was going to do.
 * - **A delete is confirmed, and then undoable for eight seconds.** The confirmation is the
 *   project's one dialog (`ui/dialog.ts`), the same question the manager asks; the delete behind it
 *   is real and written through immediately — a popup that closes must not lose it — and undo
 *   restores the tombstone under the same id, so it stays one bookmark rather than becoming two on
 *   the next device.
 */

import {
  send,
  type ErrorCode,
  type ItemSummary,
  type StateResponse,
} from '../shared/messages.js';
import { confirmDialog, dialogText } from '../ui/dialog.js';
import { h, msg, render } from '../ui/dom.js';
import { displayHost, faviconImage } from '../ui/favicon.js';
import type { VaultSettings } from '../vault/types.js';

/** How long the undo toast stays up, per PLAN §9 Phase 5. */
const UNDO_MS = 8_000;

/** Keystrokes settle before the vault is searched again. Short enough to feel instant. */
const FILTER_DEBOUNCE_MS = 120;

export interface VaultScreenDeps {
  readonly state: StateResponse;
  /** Re-ask the worker for everything and re-render the popup. The lock button's path. */
  readonly refresh: () => Promise<void>;
  readonly errorText: (code: ErrorCode) => string;
  readonly patchSettings: (patch: Partial<VaultSettings>) => Promise<void>;
  /**
   * Where "Add this page" goes.
   *
   * The header, filled by this screen rather than by the shell: the button's whole behaviour —
   * duplicates, refusals, the notice it writes into — belongs to the vault screen, and only the
   * vault screen may show it. A lock screen with an add button on it is a lock screen that lies.
   */
  readonly headerSlot: HTMLElement;
  /** Swap the popup over to the settings screen. */
  readonly openSettings: () => void;
}

export function vaultScreen(deps: VaultScreenDeps): HTMLElement {
  const notice = h('p', { class: 'vm-notice', role: 'status', hidden: true });
  const listBox = h('ul', { class: 'vm-list' });
  const summary = h('p', { class: 'vm-small vm-muted vm-count', role: 'status' });
  const toastBox = h('div', { class: 'vm-toast-slot' });
  const filter = h('input', {
    type: 'search',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: msg('vaultFilterPlaceholder'),
    'aria-label': msg('vaultFilterLabel'),
  });

  const addButton = h(
    'button',
    {
      class: 'vm-button vm-button--inline vm-add-button',
      type: 'button',
      onclick: () => {
        void addCurrentPage();
      },
    },
    msg('vaultAddButton'),
  );
  render(deps.headerSlot, addButton);

  let filterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against a slower earlier query landing on top of a later one. */
  let latestList = 0;

  function showNotice(text: string | null, kind: 'info' | 'danger' = 'info'): void {
    render(notice, text);
    notice.hidden = text === null;
    notice.classList.toggle('vm-notice--danger', kind === 'danger');
  }

  /** A notice with actions next to it — "already vaulted, open it?". */
  function showNoticeWith(text: string, ...actions: HTMLElement[]): void {
    render(notice, h('span', null, text), ...actions);
    notice.hidden = false;
    notice.classList.remove('vm-notice--danger');
  }

  async function reload(): Promise<void> {
    const token = ++latestList;
    const query = filter.value.trim();
    const response = await send({
      type: 'LIST_ITEMS',
      ...(query === '' ? {} : { query }),
    });
    if (token !== latestList) return;

    if (response.type === 'ERROR') {
      // A locked vault here means the idle window expired while the popup was open; the shell
      // re-renders on the broadcast, so this only has to not show a stale list.
      render(listBox);
      summary.textContent = '';
      showNotice(deps.errorText(response.code), 'danger');
      return;
    }

    render(
      listBox,
      ...(response.items.length === 0
        ? [
            h(
              'li',
              { class: 'vm-empty' },
              // An empty vault and an empty result are different situations and read differently.
              query === '' ? msg('vaultEmpty') : msg('vaultNoMatches', [query]),
            ),
          ]
        : response.items.map((item) => row(item))),
    );
    summary.textContent =
      response.total > response.items.length
        ? msg('vaultShowingCount', [String(response.items.length), String(response.total)])
        : '';
  }

  /* ---------------------------------------------------------------- one row */

  function row(item: ItemSummary): HTMLElement {
    const open = h(
      'button',
      {
        class: 'vm-row-open',
        type: 'button',
        title: item.url,
        onclick: () => {
          void openItem(item);
        },
      },
      faviconImage(item.url),
      h(
        'span',
        { class: 'vm-row-text' },
        h('span', { class: 'vm-row-title' }, item.title),
        h('span', { class: 'vm-row-host vm-small vm-muted' }, displayHost(item.url)),
      ),
    );

    const remove = h(
      'button',
      {
        class: 'vm-row-delete',
        type: 'button',
        'aria-label': msg('vaultDeleteLabel', [item.title]),
        title: msg('vaultDeleteLabel', [item.title]),
        onclick: () => {
          void deleteItem(item);
        },
      },
      '×',
    );

    return h('li', { class: 'vm-row' }, open, remove);
  }

  /* ---------------------------------------------------------------- actions */

  async function openItem(item: ItemSummary): Promise<void> {
    const response = await send({ type: 'OPEN_ITEM', id: item.id });
    if (response.type === 'ERROR') {
      showNotice(deps.errorText(response.code), 'danger');
      return;
    }
    if (response.status === 'needs-incognito-access') {
      // The guided prompt lives on the manager page: the user has to click into the address bar to
      // paste `chrome://extensions/…`, and a popup closes the moment they do (§9).
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`manager.html#incognito=${encodeURIComponent(item.id)}`),
      });
    }
    window.close();
  }

  async function addCurrentPage(): Promise<void> {
    addButton.disabled = true;
    showNotice(null);
    const response = await send({ type: 'ADD_ACTIVE_TAB' });
    addButton.disabled = false;

    if (response.type === 'ERROR') {
      showNotice(deps.errorText(response.code), 'danger');
      return;
    }
    if (response.status === 'duplicate') {
      const item = response.item;
      // **This is where re-capturing a preview lives** (§14.5). The page is in the tab in front of
      // us and this click is a gesture on it, so `activeTab` covers the injection — which is the one
      // arrangement in the whole extension where a refresh is possible without a host permission.
      // The manager's button can only open the page and point here.
      showNoticeWith(
        msg('vaultAlreadySaved'),
        h(
          'button',
          {
            class: 'vm-button vm-button--quiet vm-button--inline',
            type: 'button',
            onclick: () => {
              void openItem(item);
            },
          },
          msg('vaultOpenItButton'),
        ),
        h(
          'button',
          {
            class: 'vm-button vm-button--quiet vm-button--inline',
            type: 'button',
            onclick: () => {
              void refreshPreview(item);
            },
          },
          msg('thumbRefresh'),
        ),
      );
      return;
    }
    showNotice(msg('vaultAdded', [response.item.title]));
    filter.value = '';
    await reload();
    if (response.offerThumbnails === true) await offerThumbnails();
  }

  /** Re-capture the preview for the page in front of us. */
  async function refreshPreview(item: ItemSummary): Promise<void> {
    showNotice(msg('thumbRefreshing'));
    const response = await send({ type: 'REFRESH_THUMB', id: item.id });
    if (response.type === 'ERROR') {
      showNotice(deps.errorText(response.code), 'danger');
      return;
    }
    showNotice(msg(response.state === 'ready' ? 'thumbRefreshed' : 'thumbRefreshFailed'));
  }

  /**
   * The one-time offer behind "keep thumbnails on this device only" (§14.4).
   *
   * Made after the first successful add on a backend that cannot store pictures, and marked as made
   * **whichever way it is answered** — including by dismissing the dialog. A question that comes back
   * because it was ignored is a question that trains people to ignore it, and the setting is in
   * Settings → Privacy from then on either way.
   */
  async function offerThumbnails(): Promise<void> {
    const accepted = await confirmDialog({
      heading: msg('thumbOfferHeading'),
      body: [dialogText('thumbOfferBody'), dialogText('thumbOfferCost')],
      confirmLabel: msg('thumbOfferConfirm'),
    });
    await deps.patchSettings({ thumbnailsOffered: true, localThumbnails: accepted });
  }

  async function deleteItem(item: ItemSummary): Promise<void> {
    // The same question, in the same words, as the manager's delete. A "×" beside every row is a
    // target the pointer finds by accident on its way to the row itself, and the undo toast below
    // only helps someone who was looking at the popup when it happened.
    const confirmed = await confirmDialog({
      heading: msg('deleteConfirmHeadingOne', [item.title]),
      body: [dialogText('deleteConfirmBody')],
      confirmLabel: msg('deleteConfirmButton'),
      danger: true,
    });
    if (!confirmed) return;

    const response = await send({ type: 'DELETE_ITEMS', ids: [item.id] });
    if (response.type === 'ERROR') {
      showNotice(deps.errorText(response.code), 'danger');
      return;
    }
    await reload();
    showUndoToast(item);
  }

  function showUndoToast(item: ItemSummary): void {
    const toast = h(
      'div',
      // The window the undo is open for is drawn rather than described: `--vm-undo-ms` drives the
      // filling bar in `ui/styles.css`, and it comes from the same constant as the timer below so
      // the bar cannot fill while the button still works, or the other way round.
      { class: 'vm-toast vm-toast--timed', role: 'status', style: `--vm-undo-ms: ${String(UNDO_MS)}ms` },
      h('span', null, msg('vaultDeleted', [item.title])),
      h(
        'button',
        {
          class: 'vm-button vm-button--quiet vm-button--inline',
          type: 'button',
          onclick: () => {
            void (async () => {
              render(toastBox);
              const response = await send({ type: 'RESTORE_ITEMS', ids: [item.id] });
              if (response.type === 'ERROR') showNotice(deps.errorText(response.code), 'danger');
              await reload();
            })();
          },
        },
        msg('vaultUndo'),
      ),
    );
    render(toastBox, toast);
    setTimeout(() => {
      if (toast.isConnected) render(toastBox);
    }, UNDO_MS);
  }

  /* ---------------------------------------------------------------- assembly */

  filter.addEventListener('input', () => {
    if (filterTimer !== null) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filterTimer = null;
      void reload();
    }, FILTER_DEBOUNCE_MS);
  });

  void reload();

  return h(
    'div',
    { class: 'vm-vault' },
    /*
     * A heading nobody sees, and the only thing that names this screen.
     *
     * The popup's three states — create, unlock, unlocked — differ visually by what is in them, and
     * for a screen reader they differed by nothing at all: `h1` is the wordmark on all three, and
     * below it the unlocked one is a search box and a list. So the answer to "where am I" was
     * "VaultaMark", which is also the answer on the locked screen. `vm-visually-hidden` rather than
     * `hidden`, because `hidden` takes it out of the accessibility tree along with the pixels.
     */
    h('h2', { class: 'vm-visually-hidden' }, msg('unlockedHeading')),
    notice,
    h('div', { class: 'vm-field vm-field--filter' }, filter),
    listBox,
    summary,
    toastBox,
    footer(deps),
  );
}

/* ------------------------------------------------------------------ footer */

/**
 * Lock, manager, settings — the three things that are not a bookmark.
 *
 * All three are words. A gear glyph is only obvious to people who have already learned it, and one
 * icon between two labelled buttons reads as a different *kind* of control rather than as the third
 * member of a row. Spread across the full width rather than centred as a group, so each one sits in
 * a fixed place the pointer can learn.
 *
 * The order is left-to-right by how far each one takes you: locking keeps you here, the manager is
 * the same vault in a bigger window, settings is somewhere else entirely.
 */
function footer(deps: VaultScreenDeps): HTMLElement {
  return h(
    'div',
    { class: 'vm-footer' },
    h(
      'button',
      {
        class: 'vm-button vm-button--danger vm-button--inline',
        type: 'button',
        onclick: () => {
          void (async () => {
            await send({ type: 'LOCK' });
            await deps.refresh();
          })();
        },
      },
      msg('unlockedLockButton'),
    ),
    h(
      'button',
      {
        class: 'vm-button vm-button--quiet vm-button--inline',
        type: 'button',
        onclick: () => {
          void (async () => {
            // A tab rather than the `<a target="_blank">` this used to be: the popup closes the
            // moment focus leaves it, and closing it ourselves afterwards is the difference
            // between one manager tab and one manager tab plus a popup that outlived its window.
            await chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
            window.close();
          })();
        },
      },
      msg('popupOpenManager'),
    ),
    h(
      'button',
      {
        class: 'vm-button vm-button--quiet vm-button--inline',
        type: 'button',
        onclick: deps.openSettings,
      },
      msg('settingsHeading'),
    ),
  );
}
