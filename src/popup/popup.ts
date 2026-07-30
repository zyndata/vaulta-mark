/**
 * The popup: create a vault, unlock it, lock it, and set the two settings that decide when it locks
 * itself.
 *
 * All three screens live here because they are one flow over one piece of state — "does a vault
 * exist, and is it open" — which the service worker answers in a single `GET_STATE`. The popup holds
 * no key and no vault content; every decision is the worker's.
 *
 * The create screen is the one that matters. There is no password recovery and no key escrow, so a
 * user who has not understood that before they click has lost their vault and will find out weeks
 * later. Hence the typed confirmation rather than a checkbox: a checkbox is a reflex, typing a
 * sentence is a decision.
 */

import '../ui/styles.css';
import './popup.css';

import {
  MIN_PASSWORD_LENGTH,
  estimateStrength,
  passwordLength,
  type PasswordWarning,
} from '../crypto/password.js';
import {
  onBroadcast,
  send,
  type ErrorCode,
  type LockReason,
  type StateResponse,
} from '../shared/messages.js';
import { applyTheme, h, msg, qs, render } from '../ui/dom.js';
import { IDLE_TIMEOUT_CHOICES, IDLE_TIMEOUT_NEVER, type VaultSettings } from '../vault/types.js';

const root = qs(document, '#vm-root');

/** Why the vault locked while the popup was open. Shown once on the unlock screen, then cleared. */
let lastLockReason: LockReason | null = null;

/* ------------------------------------------------------------------ strings */

const ERROR_KEYS: Record<ErrorCode, string> = {
  WRONG_PASSWORD: 'errorWrongPassword',
  PASSWORD_TOO_SHORT: 'errorPasswordTooShort',
  CORRUPT_VAULT: 'errorCorruptVault',
  UNSUPPORTED_SCHEMA: 'errorUnsupportedSchema',
  VAULT_LOCKED: 'errorVaultLocked',
  VAULT_STATE: 'errorVaultState',
  UNREACHABLE: 'errorUnreachable',
  UNKNOWN: 'errorUnknown',
};

const WARNING_KEYS: Record<PasswordWarning, string> = {
  'too-short': 'warnTooShort',
  'common-password': 'warnCommonPassword',
  'common-password-variant': 'warnCommonPasswordVariant',
  'single-character-class': 'warnSingleCharacterClass',
  'repeated-characters': 'warnRepeatedCharacters',
  'sequential-characters': 'warnSequentialCharacters',
  'keyboard-pattern': 'warnKeyboardPattern',
  'year-like': 'warnYearLike',
};

const LOCK_REASON_KEYS: Record<LockReason, string> = {
  manual: 'lockedManual',
  panic: 'lockedPanic',
  expired: 'lockedExpired',
  idle: 'lockedIdle',
  blur: 'lockedBlur',
};

function errorText(code: ErrorCode): string {
  return code === 'PASSWORD_TOO_SHORT'
    ? msg(ERROR_KEYS[code], [String(MIN_PASSWORD_LENGTH)])
    : msg(ERROR_KEYS[code]);
}

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

function createScreen(): HTMLElement {
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

  /** Set once the user has seen the weak-password warning and chosen to go ahead anyway. */
  let weakAcknowledged = false;
  let acceptable = false;
  /** Guards against a slower earlier `estimateStrength` landing on top of a later result. */
  let latest = 0;

  function refreshSubmit(): void {
    const typed = password.value;
    const matches = typed.length > 0 && typed === confirm.value;
    show(mismatch, confirm.value.length > 0 && !matches ? msg('createPasswordsDiffer') : null);
    const confirmed =
      phrase.value.trim().toLocaleLowerCase() === msg('createConfirmPhrase').toLocaleLowerCase();
    submit.disabled = !(matches && confirmed && passwordLength(typed) >= MIN_PASSWORD_LENGTH);
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
    h('p', { class: 'vm-small vm-muted' }, msg('createIntro')),
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

/* ------------------------------------------------------------------ unlocked screen */

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

function unlockedScreen(state: StateResponse): HTMLElement {
  const idleSelect = h(
    'select',
    {
      onchange: (event: Event) => {
        const value = Number((event.currentTarget as HTMLSelectElement).value);
        void patchSettings({ idleTimeoutMinutes: value });
      },
    },
    ...IDLE_TIMEOUT_CHOICES.map((minutes) =>
      h(
        'option',
        { value: String(minutes), selected: minutes === state.settings.idleTimeoutMinutes },
        idleChoiceLabel(minutes),
      ),
    ),
  );

  const blurToggle = h('input', {
    type: 'checkbox',
    id: 'vm-lock-on-blur',
    checked: state.settings.lockOnBrowserBlur,
    onchange: (event: Event) => {
      void patchSettings({ lockOnBrowserBlur: (event.currentTarget as HTMLInputElement).checked });
    },
  });

  return h(
    'div',
    null,
    h('p', { class: 'vm-unlocked', role: 'status' }, msg('unlockedHeading')),
    h('p', { class: 'vm-small vm-muted' }, autoLockText(state.unlockedUntil, state.settings)),
    h(
      'button',
      {
        class: 'vm-button vm-button--danger',
        type: 'button',
        onclick: () => {
          void lockNow();
        },
      },
      msg('unlockedLockButton'),
    ),
    h('hr', { class: 'vm-rule' }),
    field('settingsIdleTimeout', idleSelect),
    h(
      'div',
      { class: 'vm-checkbox' },
      blurToggle,
      h('label', { for: 'vm-lock-on-blur' }, msg('settingsLockOnBlur')),
    ),
    h('a', { class: 'vm-link', href: '/manager.html', target: '_blank' }, msg('popupOpenManager')),
  );
}

async function patchSettings(patch: Partial<VaultSettings>): Promise<void> {
  await send({ type: 'SET_SETTINGS', settings: patch });
  await refresh();
}

async function lockNow(): Promise<void> {
  await send({ type: 'LOCK' });
  await refresh();
}

/* ------------------------------------------------------------------ the shell */

async function refresh(): Promise<void> {
  const response = await send({ type: 'GET_STATE' });
  if (response.type === 'ERROR') {
    render(
      root,
      h('p', { class: 'vm-notice vm-notice--danger', role: 'alert' }, errorText(response.code)),
    );
    return;
  }

  applyTheme(response.settings.theme, document.documentElement);
  if (!response.exists) render(root, createScreen());
  else if (response.locked) render(root, unlockScreen());
  else render(root, unlockedScreen(response));
}

onBroadcast((message) => {
  if (message.type === 'SESSION_LOCKED') {
    // A panic-lock is meant to leave nothing on screen, this popup included. Chrome gives an
    // extension no way to close someone else's popup, so the popup closes itself.
    if (message.reason === 'panic') {
      window.close();
      return;
    }
    lastLockReason = message.reason;
  }
  void refresh();
});

qs(document, '#vm-version').textContent = msg('popupVersion', [
  chrome.runtime.getManifest().version,
]);

render(root, h('p', { class: 'vm-small vm-muted' }, msg('popupLoading')));
void refresh();
