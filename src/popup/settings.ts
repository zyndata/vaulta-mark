/**
 * The popup's settings, as a screen rather than a disclosure.
 *
 * Phase 5 folded them into a `<details>` under the bookmark list, which was the right call while
 * there were four toggles and the popup was mostly a list. It stopped being right once the list
 * became the thing people open the popup for: an expander at the bottom pushes the list up when it
 * opens, the popup grows past what Chrome will show, and the settings themselves are read in a
 * 384-pixel strip below everything else.
 *
 * So the cog in the footer swaps the whole popup over to this, and Back swaps it away again. The
 * list keeps its full height, the settings get the full width, and — the part that decided it —
 * there is now somewhere for the version number to live that is not stealing a line from the list.
 *
 * Everything here also exists in the manager's settings screen. That is deliberate: the popup is
 * where someone already is when they want to change how it behaves, and "open the manager to turn
 * off a toggle" is a trip nobody should have to make.
 */

import { send, type ErrorCode, type StateResponse } from '../shared/messages.js';
import { h, msg } from '../ui/dom.js';
import { offerTrackingCleanup } from '../ui/tracking.js';
import {
  IDLE_TIMEOUT_CHOICES,
  IDLE_TIMEOUT_NEVER,
  type VaultSettings,
} from '../vault/types.js';

export interface SettingsScreenDeps {
  readonly state: StateResponse;
  readonly patchSettings: (patch: Partial<VaultSettings>) => Promise<void>;
  readonly errorText: (code: ErrorCode) => string;
  /** Back to the vault. The screen does not decide what it returns to. */
  readonly onBack: () => void;
}

export function settingsScreen(deps: SettingsScreenDeps): HTMLElement {
  const settings = deps.state.settings;
  const notice = h('p', { class: 'vm-notice', role: 'status', hidden: true });

  function say(text: string): void {
    notice.textContent = text;
    notice.hidden = false;
  }

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
    'div',
    { class: 'vm-settings-screen' },
    h(
      'div',
      { class: 'vm-screen-head' },
      h(
        'button',
        {
          type: 'button',
          class: 'vm-button vm-button--quiet vm-button--inline',
          onclick: deps.onBack,
        },
        msg('settingsBack'),
      ),
      h('h2', { class: 'vm-screen-title' }, msg('settingsHeading')),
    ),
    notice,

    section(
      'settingsSectionLock',
      h('p', { class: 'vm-small vm-muted' }, autoLockText(deps.state.unlockedUntil, settings)),
      h('label', { class: 'vm-field' }, h('span', null, msg('settingsIdleTimeout')), idleSelect),
      toggle(
        'vm-lock-on-blur',
        'settingsLockOnBlur',
        'settingsLockOnBlurHint',
        settings.lockOnBrowserBlur,
        (checked) => deps.patchSettings({ lockOnBrowserBlur: checked }),
      ),
    ),

    section(
      'settingsSectionBrowsing',
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
        async (checked) => {
          await deps.patchSettings({ stripTrackingParams: checked });
          // Only on the way on. Switching it *off* leaves what is saved alone by definition —
          // there is nothing to put back, and the parameters it removed are gone.
          if (checked) await offerCleanup(deps, say);
        },
      ),
    ),

    // Last, quiet, and out of the list's way — which is the whole reason this screen exists.
    h(
      'p',
      { class: 'vm-small vm-muted vm-version-line' },
      msg('popupVersion', [chrome.runtime.getManifest().version]),
    ),
  );
}

/* ------------------------------------------------------------------ pieces */

function section(headingKey: string, ...children: HTMLElement[]): HTMLElement {
  return h(
    'section',
    { class: 'vm-settings-section' },
    h('h3', null, msg(headingKey)),
    ...children,
  );
}

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

/** Wire `ui/tracking.ts` to the two messages, and report a failure rather than swallowing it. */
async function offerCleanup(deps: SettingsScreenDeps, say: (text: string) => void): Promise<void> {
  await offerTrackingCleanup({
    count: async () => {
      const response = await send({ type: 'COUNT_TRACKING_PARAMS' });
      // A failed count is not worth a dialog of its own: nothing has been changed, and the offer is
      // made again the next time the setting is switched on.
      return response.type === 'ERROR' ? 0 : response.count;
    },
    strip: async () => {
      const response = await send({ type: 'STRIP_TRACKING_PARAMS' });
      if (response.type === 'ERROR') {
        say(deps.errorText(response.code));
        return 0;
      }
      return response.count;
    },
    say,
  });
}
