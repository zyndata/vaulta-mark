/**
 * The settings screen: the local-only preferences, the master password, and destroying the vault.
 *
 * A screen rather than a dialog, for the same reason the conflict and import/export views are ones:
 * this is eight sections, several of them a paragraph before their control makes sense, and a
 * `<dialog>` gave them 28rem of width and 60vh of height to live in — so reading the second half of
 * it meant scrolling a box inside a page. Full window, one back button, and the sections laid out in
 * two columns when there is room for two.
 *
 * The popup has its own settings screen (`src/popup/settings.ts`) covering the subset that makes
 * sense where someone already is. Everything it offers is here too, plus the operations that need
 * more room than a popup has.
 *
 * **Destroying the vault is gated twice**, deliberately differently: a typed phrase, and then a
 * second press of the button. The typed phrase is there to make someone read (the same reasoning as
 * the no-recovery confirmation at vault creation — a checkbox is a reflex, a sentence is a
 * decision); the second press is there because the first one is the click that a mis-aimed cursor
 * makes. PLAN §9 asks for a typed *vault name*; vaults have no name, so the phrase is the sentence
 * that says what is about to happen.
 */

import { estimateStrength, MIN_PASSWORD_LENGTH, passwordLength } from '../crypto/password.js';
import { hasHistoryPermission, requestHistoryPermission } from '../history/cleanup.js';
import { send, type SyncStatusResponse } from '../shared/messages.js';
import { dialogField } from '../ui/dialog.js';
import { h, matchesPhrase, msg, render } from '../ui/dom.js';
import { historyCleanupPanel } from '../ui/history-cleanup.js';
import { errorText } from '../ui/strings.js';
import { offerTrackingCleanup } from '../ui/tracking.js';
import { historyDeps } from './history.js';
import {
  IDLE_TIMEOUT_CHOICES,
  IDLE_TIMEOUT_NEVER,
  type VaultSettings,
} from '../vault/types.js';
import { relativeTime, syncQuotaBar } from './sync.js';

export interface SettingsDeps {
  readonly settings: VaultSettings;
  readonly patch: (patch: Partial<VaultSettings>) => Promise<void>;
  /** The page's live region. Used for outcomes that outlive this screen, like a bulk clean-up. */
  readonly say: (text: string) => void;
  readonly onBack: () => void;
  /** Called after the vault has been erased, so the shell can repaint as "no vault". */
  readonly onDestroyed: () => void;
}

/**
 * Build the screen.
 *
 * Async because two answers have to be in hand before the first paint: a quota bar that appears a
 * moment after the page does is a quota bar that moves the destroy button under the cursor, and the
 * privacy section renders a different panel depending on whether `history` has been granted.
 */
export async function settingsScreen(deps: SettingsDeps): Promise<HTMLElement> {
  const status = await send({ type: 'GET_SYNC_STATUS' });
  const historyGranted = await hasHistoryPermission();

  return h(
    'section',
    { class: 'vm-settings-page', 'aria-label': msg('settingsHeading') },
    h(
      'div',
      { class: 'vm-settings-head' },
      h('h2', null, msg('settingsHeading')),
      h(
        'button',
        { type: 'button', class: 'vm-button vm-button--inline', onclick: deps.onBack },
        msg('settingsBackToBookmarks'),
      ),
    ),
    // Two explicit columns rather than auto-placement: the sections are wildly different heights, so
    // a grid that flows them would leave a row as tall as its tallest member, and the one section
    // that must not drift up beside something innocuous is the last one in the second column.
    h(
      'div',
      { class: 'vm-settings-columns' },
      h(
        'div',
        { class: 'vm-settings-col' },
        section('settingsSectionAppearance', [appearance(deps)]),
        section('settingsSectionLock', locking(deps)),
        section('settingsSectionBrowsing', browsing(deps)),
        section('settingsSectionPrivacy', privacy(deps, historyGranted)),
      ),
      h(
        'div',
        { class: 'vm-settings-col' },
        ...(status.type === 'ERROR' ? [] : [section('syncSectionHeading', sync(status))]),
        section('settingsSectionPassword', [changePassword()]),
        section('settingsSectionAbout', about()),
        section('settingsSectionDanger', [destroyVault(deps)], 'vm-settings-section--danger'),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ privacy */

/**
 * The history tools.
 *
 * Everything here is off until someone reads it: both controls delete real browsing history, not
 * merely "VaultaMark-related entries". Chrome's own URL prediction is explained during onboarding
 * (ARCHITECTURE §12.4) rather than repeated here — it is a one-time instruction to change a Chrome
 * setting, not something this screen can do or undo.
 */
function privacy(deps: SettingsDeps, historyGranted: boolean): HTMLElement[] {
  return [
    h('p', { class: 'vm-small vm-muted' }, msg('settingsHistoryIntro')),
    historyCleanupPanel({ ...historyDeps(deps.say), granted: historyGranted }),
    toggle(
      'vm-set-clear-on-lock',
      'settingsClearHistoryOnLock',
      'settingsClearHistoryOnLockHint',
      deps.settings.clearHistoryOnLock,
      async (checked) => {
        // The permission is asked for at the moment the switch goes on, from this click. A toggle
        // that stored `true` and then silently did nothing on every lock because nobody had granted
        // `history` is the worst kind of privacy setting.
        if (checked && !(await requestHistoryPermission())) {
          deps.say(msg('historyRefused'));
          return;
        }
        await deps.patch({ clearHistoryOnLock: checked });
      },
    ),
    toggle(
      'vm-set-quick-close',
      'settingsQuickClose',
      'settingsQuickCloseHint',
      deps.settings.quickClose,
      async (checked) => {
        if (checked && !(await requestHistoryPermission())) {
          deps.say(msg('historyRefused'));
          return;
        }
        await deps.patch({ quickClose: checked });
      },
    ),
  ];
}

/* ------------------------------------------------------------------ about */

/**
 * Version, licence, what the extension does with data, and the way back to the first-run flow.
 *
 * PLAN §9 asks for links to SECURITY.md and PRIVACY.md. They are not links, and cannot be: INV-3
 * forbids any absolute URL in the shipped package that is not on `build/url-allowlist.json`, and
 * putting `github.com` there to make an About box clickable would widen an invariant that exists to
 * keep exfiltration paths out of the build. So the substance travels instead of the link — the
 * policy in four sentences, and the repository named rather than addressed. The full documents ship
 * with the source and are what the Store listing points at.
 */
function about(): HTMLElement[] {
  return [
    h(
      'p',
      { class: 'vm-small vm-muted' },
      msg('settingsAboutVersion', [chrome.runtime.getManifest().version]),
    ),
    h('p', { class: 'vm-small vm-muted' }, msg('settingsAboutLicense')),
    h('p', null, msg('settingsAboutPrivacy')),
    h('p', { class: 'vm-small vm-muted' }, msg('settingsAboutSecurity')),
    h('p', { class: 'vm-small vm-muted' }, msg('settingsAboutProject')),
    h(
      'button',
      {
        type: 'button',
        class: 'vm-button vm-button--quiet',
        onclick: () => {
          void (async () => {
            // The stamp is cleared *before* navigating, or the page would open the flow, find a
            // completed record and fall straight through to the manager it came from.
            await send({ type: 'SET_ONBOARDING', patch: { completed: false, step: 0 } });
            location.href = chrome.runtime.getURL('manager.html?onboarding=1');
          })();
        },
      },
      msg('settingsReplayOnboarding'),
    ),
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg('settingsReplayOnboardingHint')),
  ];
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

function section(headingKey: string, children: HTMLElement[], extraClass?: string): HTMLElement {
  return h(
    'section',
    { class: `vm-settings-section${extraClass === undefined ? '' : ` ${extraClass}`}` },
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
    // PLAN §9 lists "require password after restart" among the security settings. It is not a
    // setting and cannot be one: the unlocked key lives in `chrome.storage.session`, which is
    // memory-backed and emptied when Chrome exits (D14), so the vault locks on restart whatever
    // anyone would have ticked. A toggle that could only ever be on and could never be turned off
    // is a lie about how much control the user has, so this states the fact instead.
    h(
      'div',
      { class: 'vm-settings-note' },
      h('p', null, msg('settingsRestartLock')),
      h('p', { class: 'vm-hint vm-small vm-muted' }, msg('settingsRestartLockHint')),
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
      async (checked) => {
        await deps.patch({ stripTrackingParams: checked });
        // Only on the way on: switching it off cannot put back parameters that are already gone,
        // so there is nothing to offer.
        if (checked) await offerCleanup(deps);
      },
    ),
  ];
}

/**
 * Wire `ui/tracking.ts` to its two messages.
 *
 * The result is announced through the page's live region rather than inside this screen, because
 * the clean-up outlives it: it rewrites addresses across the whole vault, the list behind is what
 * shows it, and a confirmation that disappears with the screen is one nobody reads.
 */
async function offerCleanup(deps: SettingsDeps): Promise<void> {
  await offerTrackingCleanup({
    count: async () => {
      const response = await send({ type: 'COUNT_TRACKING_PARAMS' });
      // Nothing has changed if the count failed, and the offer comes back the next time the
      // setting is switched on. Not worth a dialog.
      return response.type === 'ERROR' ? 0 : response.count;
    },
    strip: async () => {
      const response = await send({ type: 'STRIP_TRACKING_PARAMS' });
      if (response.type === 'ERROR') {
        deps.say(errorText(response.code));
        return 0;
      }
      return response.count;
    },
    say: deps.say,
  });
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
