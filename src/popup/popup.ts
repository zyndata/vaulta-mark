/**
 * The popup shell: which of the three screens to show, and the two that are about the password.
 *
 * Create, unlock and "unlocked" are one flow over one piece of state — "does a vault exist, and is
 * it open" — which the service worker answers in a single `GET_STATE`. The unlocked screen is large
 * enough to live next door in `vault.ts`; these two are not. The popup holds no key, and no vault
 * content beyond the rows currently on screen.
 *
 * The create screen is the one that matters. There is no password recovery and no key escrow, so a
 * user who has not understood that before they click has lost their vault and will find out weeks
 * later. Hence the typed confirmation rather than a checkbox: a checkbox is a reflex, typing a
 * sentence is a decision.
 */

import '../ui/styles.css';
import './popup.css';

import { startFocusBeacon } from '../shared/focus-beacon.js';
import { onBroadcast, send, type LockReason } from '../shared/messages.js';
import { createVaultForm } from '../ui/create-form.js';
import { applyTheme, h, msg, qs, render } from '../ui/dom.js';
import { forgetStoredIcons, useStoredIcons, type StoredIconLookup } from '../ui/favicon.js';
import { LOCK_REASON_KEYS, errorText } from '../ui/strings.js';
import type { VaultSettings } from '../vault/types.js';
import { settingsScreen } from './settings.js';
import { vaultScreen } from './vault.js';

const root = qs(document, '#vm-root');
const headerAction = qs(document, '#vm-header-action');

/*
 * Tell the worker that this popup, and not another application, has the user (§7.3).
 *
 * The popup is the reason the beacon exists. Chrome's window model has no entry for it, so an open
 * popup reports exactly what a browser the user has walked away from reports — no focused window at
 * all — and "lock when this window loses focus" used to lock the vault the moment its own quick
 * menu opened. Started before the first render, because the lock it prevents can arrive
 * before the first paint.
 */
startFocusBeacon();

/** Why the vault locked while the popup was open. Shown once on the unlock screen, then cleared. */
let lastLockReason: LockReason | null = null;

/**
 * Which of the two unlocked screens is up.
 *
 * Held here rather than inside the vault screen because a broadcast re-renders the whole shell, and
 * a settings screen that fell back to the list every time the worker touched the vault would be one
 * nobody could finish reading. It resets on lock: the settings are not what someone wants to see
 * after typing their password.
 */
let unlockedScreen: 'vault' | 'settings' = 'vault';

/** Whether the stored-icon lookup is in place for this unlocked session (§10.1). */
let iconsInstalled = false;

/* ------------------------------------------------------------------ shared pieces */

function field(labelKey: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'vm-field' }, h('span', null, msg(labelKey)), input);
}

function alertBox(): HTMLParagraphElement {
  return h('p', { class: 'vm-notice vm-notice--danger', role: 'alert', hidden: true });
}

function show(box: HTMLElement, text: string | null): void {
  box.textContent = text ?? '';
  box.hidden = text === null;
}

/* ------------------------------------------------------------------ create screen */

/**
 * The vault-creation form, wired to this window.
 *
 * The form itself lives in `ui/create-form.ts`, because onboarding's step 2 creates a vault too and
 * the no-recovery acknowledgement must be the same question in both places.
 */
function createScreen(options: { separate?: boolean; onBack?: () => void } = {}): HTMLElement {
  return createVaultForm({
    create: async (password) => {
      const response = await send({ type: 'CREATE_VAULT', password });
      return response.type === 'ERROR' ? response.code : null;
    },
    onCreated: () => {
      void refresh();
    },
    ...(options.separate === undefined ? {} : { separate: options.separate }),
    ...(options.onBack === undefined ? {} : { onBack: options.onBack }),
  });
}

/* ------------------------------------------------------------------ adopt screen */

/**
 * This profile has no vault, but the sync area does.
 *
 * The screen a second computer gets. Everything needed to open the vault is already in the header
 * the first device pushed — the KDF salt and the wrapped data key — so the master password is the
 * whole of the setup: nothing to export, copy, scan or type in beyond what the user already knows.
 *
 * It sends the same `UNLOCK` the ordinary unlock screen sends. The service worker decides whether
 * that means opening a local vault or joining a synced one, because from where the person is
 * standing there is no difference.
 */
function adoptScreen(): HTMLElement {
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  const error = alertBox();
  const submit = h('button', { class: 'vm-button', type: 'submit' }, msg('adoptButton'));

  async function submitAdopt(): Promise<void> {
    submit.disabled = true;
    show(error, null);
    // Joining derives the key and decrypts the whole vault, which is a moment of PBKDF2 and a few
    // hundred bookmarks — long enough that a button which just goes quiet looks broken.
    submit.textContent = msg('adoptWorking');
    const response = await send({ type: 'UNLOCK', password: password.value });
    submit.disabled = false;
    submit.textContent = msg('adoptButton');
    if (response.type === 'ERROR') {
      show(error, errorText(response.code));
      password.select();
      return;
    }
    password.value = '';
    await refresh();
  }

  queueMicrotask(() => {
    password.focus();
  });

  return h(
    'form',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        void submitAdopt();
      },
    },
    h(
      'div',
      { class: 'vm-notice' },
      h('p', null, h('strong', null, msg('adoptHeading'))),
      h('p', null, msg('adoptBody')),
    ),
    field('adoptFieldPassword', password),
    error,
    submit,
    h(
      'button',
      {
        type: 'button',
        class: 'vm-button vm-button--quiet vm-button--inline',
        onclick: () => {
          render(
            root,
            createScreen({
              separate: true,
              onBack: () => {
                render(root, adoptScreen());
              },
            }),
          );
        },
      },
      msg('adoptCreateInstead'),
    ),
  );
}

/* ------------------------------------------------------------------ unlock screen */

function unlockScreen(): HTMLElement {
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  const error = alertBox();
  const submit = h('button', { class: 'vm-button', type: 'submit' }, msg('unlockButton'));

  const reason = lastLockReason;
  lastLockReason = null;

  async function submitUnlock(): Promise<void> {
    submit.disabled = true;
    show(error, null);
    const response = await send({ type: 'UNLOCK', password: password.value });
    submit.disabled = false;
    if (response.type === 'ERROR') {
      show(error, errorText(response.code));
      password.select();
      return;
    }
    password.value = '';
    await refresh();
  }

  // The password field is the only thing on this screen; focusing it saves a click every time.
  queueMicrotask(() => {
    password.focus();
  });

  return h(
    'form',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        void submitUnlock();
      },
    },
    reason !== null &&
      h('p', { class: 'vm-notice', role: 'status' }, msg(LOCK_REASON_KEYS[reason])),
    field('unlockFieldPassword', password),
    error,
    submit,
  );
}

/* ------------------------------------------------------------------ the shell */

async function patchSettings(patch: Partial<VaultSettings>): Promise<void> {
  await send({ type: 'SET_SETTINGS', settings: patch });
  await refresh();
}

async function refresh(): Promise<void> {
  const response = await send({ type: 'GET_STATE' });
  // Cleared on every repaint. Only the unlocked vault screen fills it, and it does so on its way
  // in; anything left over from the screen before would be a button acting on a vault that is no
  // longer open.
  render(headerAction);
  if (response.type === 'ERROR') {
    render(
      root,
      h('p', { class: 'vm-notice vm-notice--danger', role: 'alert' }, errorText(response.code)),
    );
    return;
  }

  applyTheme(response.settings.theme, document.documentElement);
  if (!response.exists) {
    unlockedScreen = 'vault';
    render(root, response.adoptable ? adoptScreen() : createScreen());
  } else if (response.locked) {
    unlockedScreen = 'vault';
    forgetStoredIcons();
    iconsInstalled = false;
    render(root, unlockScreen());
  } else if (unlockedScreen === 'settings') {
    render(
      root,
      settingsScreen({
        state: response,
        patchSettings,
        onBack: () => {
          unlockedScreen = 'vault';
          void refresh();
        },
        onAllSettings: () => {
          void (async () => {
            // Same shape as the footer's "Open the manager", and for the same reason: a popup that
            // opened a tab and stayed behind would be a window nobody comes back to. The hash is the
            // instruction to land on the settings screen rather than the bookmark list.
            await chrome.tabs.create({ url: chrome.runtime.getURL('manager.html#settings') });
            window.close();
          })();
        },
      }),
    );
  } else {
    // Installed once per unlock, not once per repaint: installing again clears the per-host cache,
    // and the popup repaints itself on every add, delete and undo.
    if (!iconsInstalled) {
      useStoredIcons(storedIconLookup());
      iconsInstalled = true;
    }
    render(
      root,
      vaultScreen({
        state: response,
        refresh,
        errorText,
        patchSettings,
        headerSlot: headerAction,
        openSettings: () => {
          unlockedScreen = 'settings';
          void refresh();
        },
      }),
    );
  }
}

/**
 * What the popup repaints for, spelled out one message at a time.
 *
 * It used to repaint for everything except `VAULT_CHANGED`, and that "except" was the bug: a delete
 * schedules a sync, the sync settles three seconds later, the worker broadcasts `SYNC_CHANGED`, and
 * the popup rebuilt its whole shell — taking the eight-second undo offer with it after three. The
 * popup shows nothing about sync, so there was never anything to repaint for.
 *
 * A `switch` rather than a list of early returns because the union is closed: a broadcast added
 * later stops compiling here until someone has decided whether this window cares about it.
 */
onBroadcast((message) => {
  switch (message.type) {
    // Neither repaints. The popup is the only UI that can change the vault while it is open and it
    // re-reads its own list where it made the change, and it shows nothing at all about sync — so
    // rebuilding the shell for either would only throw away the filter being typed into and the
    // undo toast, which is the one thing on screen with a clock running.
    // `IO_PROGRESS` joins them for the same reason: import and export live in the manager, and a
    // popup rebuilding itself on every tick of somebody else's progress bar would be the same bug
    // again, with a faster clock.
    // `MIGRATION_PROGRESS` is the same case once more: connecting Drive is done in settings, in the
    // manager, and its progress line is drawn there.
    case 'VAULT_CHANGED':
    case 'SYNC_CHANGED':
    case 'IO_PROGRESS':
    case 'MIGRATION_PROGRESS':
      return;
    case 'SESSION_LOCKED':
      // A panic-lock is meant to leave nothing on screen, this popup included. Chrome gives an
      // extension no way to close someone else's popup, so the popup closes itself.
      if (message.reason === 'panic') {
        window.close();
        return;
      }
      lastLockReason = message.reason;
      break;
    case 'SESSION_UNLOCKED':
    case 'SETTINGS_CHANGED':
      break;
  }
  void refresh();
});

render(root, h('p', { class: 'vm-small vm-muted' }, msg('popupLoading')));
void refresh();

/**
 * Ask the worker for one host's stored icon (ARCHITECTURE §10.1).
 *
 * Installed once, here, because `src/ui/` stays free of the message protocol. It is asked at most
 * once per host per page, and on a profile that keeps no icons the first answer retires it.
 */
function storedIconLookup(): StoredIconLookup {
  return async (url) => {
    const response = await send({ type: 'GET_ICON', url });
    return response.type === 'ICON'
      ? { image: response.image, available: response.available }
      : { image: null, available: false };
  };
}
