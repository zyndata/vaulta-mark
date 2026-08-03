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

import { MIN_PASSWORD_LENGTH, estimateStrength, passwordLength } from '../crypto/password.js';
import { onBroadcast, send, type LockReason } from '../shared/messages.js';
import { applyTheme, h, matchesPhrase, msg, qs, render } from '../ui/dom.js';
import { LOCK_REASON_KEYS, WARNING_KEYS, errorText } from '../ui/strings.js';
import type { VaultSettings } from '../vault/types.js';
import { settingsScreen } from './settings.js';
import { vaultScreen } from './vault.js';

const root = qs(document, '#vm-root');
const headerAction = qs(document, '#vm-header-action');

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
 * Whether the create screen was reached from a profile that had a synced vault to join.
 *
 * It changes nothing mechanically and everything about what the screen means: the same form is
 * either "set up VaultaMark" or "deliberately keep a second, separate vault on this computer",
 * and the second needs saying out loud because it cannot sync with the first.
 */
function createScreen(options: { separate?: boolean; onBack?: () => void } = {}): HTMLElement {
  const password = h('input', { type: 'password', autocomplete: 'new-password' });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password' });
  const phrase = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });

  const meter = h(
    'div',
    { class: 'vm-meter', 'data-score': '0', 'aria-hidden': 'true' },
    ...Array.from({ length: 5 }, () => h('span')),
  );
  const strength = h('p', { class: 'vm-small vm-muted', role: 'status' });
  const warnings = h('ul', { class: 'vm-warnings vm-small vm-muted' });
  const mismatch = h('p', { class: 'vm-small vm-danger', hidden: true });
  const weak = h('p', { class: 'vm-notice vm-notice--warning', hidden: true });
  const error = alertBox();
  const submit = h('button', { class: 'vm-button', type: 'submit', disabled: true });
  // A disabled button that will not say why is a dead end: three separate conditions gate it, and
  // the one that is unmet is not always the one the user is looking at.
  const blocked = h('p', { class: 'vm-blocked vm-small vm-muted', role: 'status', hidden: true });

  /** Set once the user has seen the weak-password warning and chosen to go ahead anyway. */
  let weakAcknowledged = false;
  let acceptable = false;
  /** Guards against a slower earlier `estimateStrength` landing on top of a later result. */
  let latest = 0;

  /**
   * The first requirement the form is still waiting on, or `null` when it is ready.
   *
   * Ordered the way the fields are: naming the phrase while the password is too short would send
   * someone to fix the thing they already got right.
   */
  function unmetRequirement(): string | null {
    if (passwordLength(password.value) < MIN_PASSWORD_LENGTH) {
      return msg('createNeedsLength', [String(MIN_PASSWORD_LENGTH)]);
    }
    if (password.value !== confirm.value) return msg('createNeedsMatch');
    if (!matchesPhrase(phrase.value, msg('createConfirmPhrase'))) {
      return msg('createNeedsPhrase', [msg('createConfirmPhrase')]);
    }
    return null;
  }

  function refreshSubmit(): void {
    const matches = password.value.length > 0 && password.value === confirm.value;
    show(mismatch, confirm.value.length > 0 && !matches ? msg('createPasswordsDiffer') : null);

    const unmet = unmetRequirement();
    submit.disabled = unmet !== null;
    // Nothing to say before the user has typed anything: the form is not "blocked" yet, it is empty.
    show(blocked, password.value.length > 0 ? unmet : null);
    submit.textContent = msg(weakAcknowledged ? 'createButtonAnyway' : 'createButton');
  }

  async function refreshStrength(): Promise<void> {
    const token = ++latest;
    const typed = password.value;
    if (typed.length === 0) {
      meter.setAttribute('data-score', '0');
      strength.textContent = '';
      render(warnings);
      acceptable = false;
      return;
    }
    const estimate = await estimateStrength(typed);
    if (token !== latest) return;
    meter.setAttribute('data-score', String(estimate.score));
    strength.textContent = msg('createStrength', [msg(`strength${String(estimate.score)}`)]);
    render(warnings, ...estimate.warnings.map((code) => h('li', null, msg(WARNING_KEYS[code]))));
    acceptable = estimate.acceptable;
    // A password that has just become strong should not still sit behind an "are you sure".
    if (acceptable) {
      weakAcknowledged = false;
      weak.hidden = true;
    }
    refreshSubmit();
  }

  async function submitCreate(): Promise<void> {
    if (submit.disabled) return;
    // Below "good" the flow asks a second time; it never refuses. Nobody is blocked from their own
    // choice — we make sure it was one (ARCHITECTURE §4.6).
    if (!acceptable && !weakAcknowledged) {
      weakAcknowledged = true;
      show(weak, msg('createWeakConfirm'));
      refreshSubmit();
      return;
    }
    submit.disabled = true;
    show(error, null);
    const response = await send({ type: 'CREATE_VAULT', password: password.value });
    if (response.type === 'ERROR') {
      show(error, errorText(response.code));
      refreshSubmit();
      return;
    }
    password.value = '';
    confirm.value = '';
    await refresh();
  }

  password.addEventListener('input', () => {
    void refreshStrength();
    refreshSubmit();
  });
  confirm.addEventListener('input', refreshSubmit);
  phrase.addEventListener('input', refreshSubmit);

  refreshSubmit();

  return h(
    'form',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        void submitCreate();
      },
    },
    options.separate === true
      ? h(
          'div',
          { class: 'vm-notice vm-notice--warning' },
          h('p', null, h('strong', null, msg('adoptSeparateHeading'))),
          h('p', null, msg('adoptSeparateBody')),
          options.onBack === undefined
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  class: 'vm-button vm-button--quiet vm-button--inline',
                  onclick: options.onBack,
                },
                msg('adoptSeparateBack'),
              ),
        )
      : h('p', { class: 'vm-small vm-muted' }, msg('createIntro')),
    field('createFieldPassword', password),
    meter,
    strength,
    warnings,
    field('createFieldConfirm', confirm),
    mismatch,
    h(
      'div',
      { class: 'vm-notice vm-notice--warning' },
      h('p', null, h('strong', null, msg('createNoRecoveryHeading'))),
      h('p', null, msg('createNoRecoveryBody')),
    ),
    field('createFieldPhrase', phrase),
    h('p', { class: 'vm-small vm-muted' }, msg('createPhraseHint', [msg('createConfirmPhrase')])),
    weak,
    error,
    submit,
    blocked,
  );
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
          render(root, createScreen({ separate: true, onBack: () => { render(root, adoptScreen()); } }));
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
    reason !== null && h('p', { class: 'vm-notice', role: 'status' }, msg(LOCK_REASON_KEYS[reason])),
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
    render(root, unlockScreen());
  } else if (unlockedScreen === 'settings') {
    render(
      root,
      settingsScreen({
        state: response,
        patchSettings,
        errorText,
        onBack: () => {
          unlockedScreen = 'vault';
          void refresh();
        },
      }),
    );
  } else {
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
    case 'VAULT_CHANGED':
    case 'SYNC_CHANGED':
    case 'IO_PROGRESS':
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
