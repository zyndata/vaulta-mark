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
} from '../shared/messages.js';
import { applyTheme, h, matchesPhrase, msg, qs, render } from '../ui/dom.js';
import type { VaultSettings } from '../vault/types.js';
import { vaultScreen } from './vault.js';

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
  ITEM_NOT_FOUND: 'errorItemNotFound',
  NO_ACTIVE_TAB: 'errorNoActiveTab',
  URL_INTERNAL_PAGE: 'errorUrlInternalPage',
  URL_LOCAL_FILE: 'errorUrlLocalFile',
  URL_UNSUPPORTED_SCHEME: 'errorUrlUnsupportedScheme',
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
    blocked,
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
  else render(root, vaultScreen({ state: response, refresh, errorText, patchSettings }));
}

onBroadcast((message) => {
  // `VAULT_CHANGED` is deliberately not handled: the popup is the only UI that can change the vault
  // while it is open, and it re-reads its own list at the point it made the change. Re-rendering
  // the whole shell here would throw away the filter the user is typing into.
  if (message.type === 'VAULT_CHANGED') return;
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
