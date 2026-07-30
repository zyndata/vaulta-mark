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
 * - **A delete is undoable for eight seconds.** The delete is real and written through immediately
 *   — a popup that closes must not lose it — and undo restores the tombstone under the same id, so
 *   it stays one bookmark rather than becoming two on the next device.
 */

import {
  send,
  type ErrorCode,
  type ItemSummary,
  type StateResponse,
} from '../shared/messages.js';
import { h, msg, render } from '../ui/dom.js';
import { displayHost, faviconImage } from '../ui/favicon.js';
import {
  IDLE_TIMEOUT_CHOICES,
  IDLE_TIMEOUT_NEVER,
  type VaultSettings,
} from '../vault/types.js';

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
      class: 'vm-button',
      type: 'button',
      onclick: () => {
        void addCurrentPage();
      },
    },
    msg('vaultAddButton'),
  );

  let filterTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against a slower earlier query landing on top of a later one. */
  let latestList = 0;

  function showNotice(text: string | null, kind: 'info' | 'danger' = 'info'): void {
    render(notice, text);
    notice.hidden = text === null;
    notice.classList.toggle('vm-notice--danger', kind === 'danger');
  }

  /** A notice with an action next to it — "already vaulted, open it?". */
  function showNoticeWith(text: string, action: HTMLElement): void {
    render(notice, h('span', null, text), action);
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

    render(listBox, ...response.items.map((item) => row(item)));
    if (response.items.length === 0) {
      render(
        listBox,
        h(
          'li',
          { class: 'vm-empty' },
          query === '' ? msg('vaultEmpty') : msg('vaultNoMatches', [query]),
        ),
      );
    }
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
      );
      return;
    }
    showNotice(msg('vaultAdded', [response.item.title]));
    filter.value = '';
    await reload();
  }

  async function deleteItem(item: ItemSummary): Promise<void> {
    const response = await send({ type: 'DELETE_ITEM', id: item.id });
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
      { class: 'vm-toast', role: 'status' },
      h('span', null, msg('vaultDeleted', [item.title])),
      h(
        'button',
        {
          class: 'vm-button vm-button--quiet vm-button--inline',
          type: 'button',
          onclick: () => {
            void (async () => {
              render(toastBox);
              const response = await send({ type: 'RESTORE_ITEM', id: item.id });
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
    addButton,
    notice,
    h('div', { class: 'vm-field vm-field--filter' }, filter),
    listBox,
    summary,
    toastBox,
    settingsPanel(deps),
    h(
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
      h('a', { class: 'vm-link', href: '/manager.html', target: '_blank' }, msg('popupOpenManager')),
    ),
  );
}

/* ------------------------------------------------------------------ settings */

function idleChoiceLabel(minutes: number): string {
  return minutes === IDLE_TIMEOUT_NEVER
    ? msg('settingsIdleNever')
    : msg('settingsIdleMinutes', [String(minutes)]);
}

function autoLockText(unlockedUntil: number | null, settings: VaultSettings): string {
  if (settings.idleTimeoutMinutes <= IDLE_TIMEOUT_NEVER || unlockedUntil === null) {
    return msg('unlockedAutoLockNever');
  }
  const minutes = Math.max(1, Math.round((unlockedUntil - Date.now()) / 60_000));
  return msg('unlockedAutoLockIn', [String(minutes)]);
}

/**
 * The settings, folded away.
 *
 * A disclosure rather than the flat list Phase 4 shipped: the popup's job is now the vault, and
 * four toggles above the bookmarks would make the common case the least prominent thing on screen.
 * Everything here also appears in the manager's settings page from Phase 6.
 */
function settingsPanel(deps: VaultScreenDeps): HTMLElement {
  const { state } = deps;
  const settings = state.settings;

  const idleSelect = h(
    'select',
    {
      onchange: (event: Event) => {
        void deps.patchSettings({
          idleTimeoutMinutes: Number((event.currentTarget as HTMLSelectElement).value),
        });
      },
    },
    ...IDLE_TIMEOUT_CHOICES.map((minutes) =>
      h(
        'option',
        { value: String(minutes), selected: minutes === settings.idleTimeoutMinutes },
        idleChoiceLabel(minutes),
      ),
    ),
  );

  return h(
    'details',
    { class: 'vm-settings' },
    h('summary', null, msg('vaultSettingsSummary')),
    h('p', { class: 'vm-small vm-muted' }, autoLockText(state.unlockedUntil, settings)),
    h('label', { class: 'vm-field' }, h('span', null, msg('settingsIdleTimeout')), idleSelect),
    toggle('vm-lock-on-blur', 'settingsLockOnBlur', 'settingsLockOnBlurHint', settings.lockOnBrowserBlur, (checked) =>
      deps.patchSettings({ lockOnBrowserBlur: checked }),
    ),
    toggle(
      'vm-reuse-incognito',
      'settingsReuseWindow',
      'settingsReuseWindowHint',
      settings.reuseIncognitoWindow,
      (checked) => deps.patchSettings({ reuseIncognitoWindow: checked }),
    ),
    toggle(
      'vm-strip-tracking',
      'settingsStripTracking',
      'settingsStripTrackingHint',
      settings.stripTrackingParams,
      (checked) => deps.patchSettings({ stripTrackingParams: checked }),
    ),
  );
}

function toggle(
  id: string,
  labelKey: string,
  hintKey: string,
  checked: boolean,
  onChange: (checked: boolean) => Promise<void>,
): HTMLElement {
  const input = h('input', {
    type: 'checkbox',
    id,
    checked,
    onchange: (event: Event) => {
      void onChange((event.currentTarget as HTMLInputElement).checked);
    },
  });
  return h(
    'div',
    null,
    h('div', { class: 'vm-checkbox' }, input, h('label', { for: id }, msg(labelKey))),
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg(hintKey)),
  );
}
