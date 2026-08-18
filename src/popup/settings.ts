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
 * **This screen is deliberately not the manager's.** It used to mirror it as far as it went, on the
 * grounds that "open the manager to turn off a toggle" is a trip nobody should have to make. That
 * held while the popup was the only door: it is where someone already is when they want to change
 * how the thing behaves. It stopped holding once the manager's screen grew to eight sections, and it
 * is what `settingsAllInManager` below now answers — the trip is one click, so the popup can keep
 * the one section that is genuinely *quick* and hand the rest over.
 *
 * What is quick, precisely: auto-lock is the setting people change in the moment they are thinking
 * about it — stepping away from the machine, or being locked out once too often. Everything else is
 * decided once. Opening and saving used to be here and is not any more for exactly that reason, and
 * because switching tracking-parameter stripping on offers to rewrite every bookmark in the vault,
 * which is a manager-sized question asked in a 26.4rem column.
 */

import type { StateResponse } from '../shared/messages.js';
import { h, msg } from '../ui/dom.js';
import {
  IDLE_TIMEOUT_CHOICES,
  IDLE_TIMEOUT_NEVER,
  type VaultSettings,
} from '../vault/types.js';

export interface SettingsScreenDeps {
  readonly state: StateResponse;
  readonly patchSettings: (patch: Partial<VaultSettings>) => Promise<void>;
  /** Back to the vault. The screen does not decide what it returns to. */
  readonly onBack: () => void;
  /** Everything this screen does not hold, in the manager. Opens a tab; the popup closes behind it. */
  readonly onAllSettings: () => void;
}

export function settingsScreen(deps: SettingsScreenDeps): HTMLElement {
  const settings = deps.state.settings;

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

    // The door to the rest, named rather than implied: the hint is what stops someone hunting this
    // screen for a setting that was never here. It reads as a section without being one — a heading
    // over a single button would claim there is a category of settings called "the other ones".
    h(
      'div',
      { class: 'vm-settings-more' },
      h(
        'button',
        {
          type: 'button',
          class: 'vm-button vm-button--quiet',
          onclick: deps.onAllSettings,
        },
        msg('settingsAllInManager'),
      ),
      h('p', { class: 'vm-hint vm-small vm-muted' }, msg('settingsAllInManagerHint')),
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
