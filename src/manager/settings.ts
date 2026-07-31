/**
 * The settings dialog: the local-only preferences, the master password, and destroying the vault.
 *
 * Everything the popup's fold-away settings offer is here too, plus the two operations that need
 * more room than a 384-pixel popup has.
 *
 * **Destroying the vault is gated twice**, deliberately differently: a typed phrase, and then a
 * second press of the button. The typed phrase is there to make someone read (the same reasoning as
 * the no-recovery confirmation at vault creation — a checkbox is a reflex, a sentence is a
 * decision); the second press is there because the first one is the click that a mis-aimed cursor
 * makes. PLAN §9 asks for a typed *vault name*; vaults have no name, so the phrase is the sentence
 * that says what is about to happen.
 */

import { estimateStrength, MIN_PASSWORD_LENGTH, passwordLength } from '../crypto/password.js';
import { send, type SyncStatusResponse } from '../shared/messages.js';
import { h, matchesPhrase, msg, render } from '../ui/dom.js';
import { errorText } from '../ui/strings.js';
import {
  IDLE_TIMEOUT_CHOICES,
  IDLE_TIMEOUT_NEVER,
  type VaultSettings,
} from '../vault/types.js';
import { dialogField, openDialog } from './dialog.js';
import { relativeTime, syncQuotaBar } from './sync.js';

export interface SettingsDeps {
  readonly settings: VaultSettings;
  readonly patch: (patch: Partial<VaultSettings>) => Promise<void>;
  /** Called after the vault has been erased, so the shell can repaint as "no vault". */
  readonly onDestroyed: () => void;
}

export async function openSettings(deps: SettingsDeps): Promise<void> {
  // Fetched before the dialog is built rather than filled in afterwards: a quota bar that appears a
  // moment after the dialog does is a quota bar that moves the destroy button under the cursor.
  const status = await send({ type: 'GET_SYNC_STATUS' });

  await openDialog<never>({
    heading: msg('settingsHeading'),
    body: [
      appearance(deps),
      section('settingsSectionLock', locking(deps)),
      section('settingsSectionBrowsing', browsing(deps)),
      ...(status.type === 'ERROR' ? [] : [section('syncSectionHeading', sync(status))]),
      section('settingsSectionPassword', [changePassword()]),
      section('settingsSectionDanger', [destroyVault(deps)]),
    ],
  });
}

/**
 * What sync is doing, and how much room is left.
 *
 * Read-only in Phase 7 on purpose: there is exactly one provider, so a picker would be a control
 * with one option. Phase 10 adds Drive and the choice that goes with it.
 */
function sync(status: SyncStatusResponse): HTMLElement[] {
  return [
    h(
      'p',
      { class: 'vm-small vm-muted' },
      msg(status.providerId === 'drive' ? 'syncProviderDrive' : 'syncProviderChrome'),
    ),
    h(
      'p',
      { class: 'vm-small vm-muted' },
      status.lastSyncedAt === null
        ? msg('syncNever')
        : msg('syncLastSynced', [relativeTime(status.lastSyncedAt)]),
    ),
    syncQuotaBar(status),
  ];
}

function section(headingKey: string, children: HTMLElement[]): HTMLElement {
  return h(
    'section',
    { class: 'vm-settings-section' },
    h('h3', null, msg(headingKey)),
    ...children,
  );
}

/* ------------------------------------------------------------------ preferences */

/** Spelled out rather than derived, so a new theme value breaks the build instead of the UI. */
const THEME_LABEL_KEYS: Record<VaultSettings['theme'], string> = {
  system: 'themeSystem',
  light: 'themeLight',
  dark: 'themeDark',
};

function appearance(deps: SettingsDeps): HTMLElement {
  const select = h(
    'select',
    {
      onchange: (event: Event) => {
        void deps.patch({
          theme: (event.currentTarget as HTMLSelectElement).value as VaultSettings['theme'],
        });
      },
    },
    ...(Object.entries(THEME_LABEL_KEYS) as [VaultSettings['theme'], string][]).map(
      ([theme, key]) =>
        h('option', { value: theme, selected: theme === deps.settings.theme }, msg(key)),
    ),
  );
  return dialogField('settingsTheme', select);
}

function locking(deps: SettingsDeps): HTMLElement[] {
  const idle = h(
    'select',
    {
      onchange: (event: Event) => {
        void deps.patch({
          idleTimeoutMinutes: Number((event.currentTarget as HTMLSelectElement).value),
        });
      },
    },
    ...IDLE_TIMEOUT_CHOICES.map((minutes) =>
      h(
        'option',
        { value: String(minutes), selected: minutes === deps.settings.idleTimeoutMinutes },
        minutes === IDLE_TIMEOUT_NEVER
          ? msg('settingsIdleNever')
          : msg('settingsIdleMinutes', [String(minutes)]),
      ),
    ),
  );
  return [
    dialogField('settingsIdleTimeout', idle),
    toggle('vm-set-blur', 'settingsLockOnBlur', 'settingsLockOnBlurHint', deps.settings.lockOnBrowserBlur, (checked) =>
      deps.patch({ lockOnBrowserBlur: checked }),
    ),
  ];
}

function browsing(deps: SettingsDeps): HTMLElement[] {
  return [
    toggle(
      'vm-set-reuse',
      'settingsReuseWindow',
      'settingsReuseWindowHint',
      deps.settings.reuseIncognitoWindow,
      (checked) => deps.patch({ reuseIncognitoWindow: checked }),
    ),
    toggle(
      'vm-set-strip',
      'settingsStripTracking',
      'settingsStripTrackingHint',
      deps.settings.stripTrackingParams,
      (checked) => deps.patch({ stripTrackingParams: checked }),
    ),
  ];
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

/* ------------------------------------------------------------------ master password */

function changePassword(): HTMLElement {
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password' });
  const meter = h(
    'div',
    { class: 'vm-meter', 'data-score': '0', 'aria-hidden': 'true' },
    ...Array.from({ length: 5 }, () => h('span')),
  );
  const status = h('p', { class: 'vm-small', role: 'status' });
  const submit = h('button', { class: 'vm-button', type: 'button' }, msg('settingsChangePassword'));

  let latest = 0;
  next.addEventListener('input', () => {
    const token = ++latest;
    const typed = next.value;
    if (typed === '') {
      meter.setAttribute('data-score', '0');
      return;
    }
    void estimateStrength(typed).then((estimate) => {
      if (token === latest) meter.setAttribute('data-score', String(estimate.score));
    });
  });

  submit.addEventListener('click', () => {
    void (async () => {
      status.classList.remove('vm-danger', 'vm-ok');
      if (passwordLength(next.value) < MIN_PASSWORD_LENGTH) {
        status.classList.add('vm-danger');
        status.textContent = errorText('PASSWORD_TOO_SHORT');
        return;
      }
      if (next.value !== confirm.value) {
        status.classList.add('vm-danger');
        status.textContent = msg('createPasswordsDiffer');
        return;
      }

      submit.disabled = true;
      const response = await send({
        type: 'CHANGE_PASSWORD',
        currentPassword: current.value,
        newPassword: next.value,
      });
      submit.disabled = false;

      if (response.type === 'ERROR') {
        status.classList.add('vm-danger');
        status.textContent = errorText(response.code);
        return;
      }
      current.value = '';
      next.value = '';
      confirm.value = '';
      meter.setAttribute('data-score', '0');
      status.classList.add('vm-ok');
      status.textContent = msg('settingsPasswordChanged');
    })();
  });

  return h(
    'div',
    null,
    dialogField('settingsCurrentPassword', current),
    dialogField('settingsNewPassword', next),
    meter,
    dialogField('settingsConfirmPassword', confirm),
    submit,
    status,
  );
}

/* ------------------------------------------------------------------ destroying it */

function destroyVault(deps: SettingsDeps): HTMLElement {
  const phrase = msg('settingsDestroyPhrase');
  const typed = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const status = h('p', { class: 'vm-small', role: 'status' });
  const button = h(
    'button',
    { class: 'vm-button vm-button--danger', type: 'button', disabled: true },
    msg('settingsDestroyButton'),
  );

  /** Set once the user has been asked a second time. The second press is the one that erases. */
  let armed = false;

  typed.addEventListener('input', () => {
    button.disabled = !matchesPhrase(typed.value, phrase);
    if (button.disabled && armed) {
      armed = false;
      status.textContent = '';
    }
  });

  button.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      status.classList.add('vm-danger');
      status.textContent = msg('settingsDestroyConfirm');
      return;
    }
    void (async () => {
      button.disabled = true;
      const response = await send({ type: 'DESTROY_VAULT' });
      if (response.type === 'ERROR') {
        status.textContent = errorText(response.code);
        button.disabled = false;
        return;
      }
      status.classList.remove('vm-danger');
      status.textContent = msg('settingsDestroyed');
      deps.onDestroyed();
    })();
  });

  const box = h('div', { class: 'vm-danger-zone' });
  render(
    box,
    h('p', { class: 'vm-notice vm-notice--danger' }, msg('settingsDestroyWarning')),
    dialogField('settingsDestroyLabel', typed, msg('settingsDestroyHint', [phrase])),
    button,
    status,
  );
  return box;
}
