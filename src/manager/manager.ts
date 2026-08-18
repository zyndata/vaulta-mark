/**
 * The manager page's entry point: which of the three screens this tab is.
 *
 * Almost always it is the vault manager (`app.ts`). Two exceptions, both here because they ask the
 * user to paste an address into the address bar and a popup closes the moment they click there:
 * `#incognito=<itemId>` is the guided prompt for "Allow in Incognito is off" (ARCHITECTURE §9), and
 * `?onboarding=1` is the first-run flow, opened once by `chrome.runtime.onInstalled`.
 *
 * `#settings` is not a third screen but an instruction to the manager about which of its own screens
 * to open on — the popup's "All settings in the manager" button, which holds only the quick section
 * and hands the other seven over.
 *
 * Nothing expensive happens at import time. The page paints its loading line, asks the worker one
 * question, and builds whichever screen the answer calls for.
 */

import '../ui/styles.css';
import './manager.css';

import { send } from '../shared/messages.js';
import { applyTheme, h, localize, msg, qs, render } from '../ui/dom.js';
import { incognitoPrompt } from '../ui/incognito-prompt.js';
import { mountManager } from './app.js';
import { mountOnboarding } from './onboarding/screen.js';
import { resumeStep } from './onboarding/steps.js';

const INCOGNITO_HASH = /^#incognito(?:=(.*))?$/u;
const SETTINGS_HASH = '#settings';

localize(document);

const root = qs(document, '#vm-root');

void (async () => {
  const state = await send({ type: 'GET_STATE' });
  if (state.type === 'ERROR') {
    render(root, h('p', { class: 'vm-notice vm-notice--danger', role: 'alert' }, msg('errorUnreachable')));
    return;
  }
  applyTheme(state.settings.theme, document.documentElement);

  const match = INCOGNITO_HASH.exec(location.hash);
  if (match !== null) {
    await showIncognitoPrompt(match[1]);
    return;
  }

  if (new URLSearchParams(location.search).has('onboarding')) {
    if (await showOnboarding()) return;
    // A completed flow reached by URL falls through to the manager rather than showing a wizard
    // that has nothing left to say. "Replay onboarding" clears the stamp first, so it never lands
    // here.
  }

  // The manager reads and writes the vault, so it has nothing to show while the vault is shut. It
  // does not offer to unlock: the popup is the one surface that is always one click away, and two
  // unlock forms is two places to get the no-recovery warning wrong.
  if (!state.exists) {
    render(root, h('p', { class: 'vm-placeholder' }, msg('managerNoVault')));
    return;
  }
  if (state.locked) {
    render(root, h('p', { class: 'vm-placeholder' }, msg('managerLocked')));
    return;
  }

  /*
   * Consumed rather than kept.
   *
   * The manager's screens are not addressable — `showScreen` is a variable in `app.ts`, and Back
   * changes it without touching the URL — so a hash left in the address bar would be a location that
   * stops being true the moment someone presses "Back to bookmarks", and would come back on reload.
   * It is a one-shot instruction from the popup, so it is spent here.
   */
  const settingsFirst = location.hash === SETTINGS_HASH;
  if (settingsFirst) history.replaceState(null, '', location.pathname + location.search);

  mountManager(root, state, settingsFirst ? { screen: 'settings' } : {});
})();

/**
 * The first-run flow, if it still has somewhere to resume.
 *
 * Returns whether it took over the page. `resumeStep` answers `null` for a record that has already
 * been completed, which is the whole of "it never appears again" — the install tab opens this URL
 * once, and nothing else stamps the record.
 *
 * Finishing reloads onto the plain manager rather than mounting it in place: the flow has just
 * created a vault, and `mountManager` wants a `GET_STATE` taken *after* that, not the one this page
 * loaded with.
 */
async function showOnboarding(): Promise<boolean> {
  const record = await send({ type: 'GET_ONBOARDING' });
  if (record.type === 'ERROR') return false;

  const state = await send({ type: 'GET_STATE' });
  const exists = state.type !== 'ERROR' && state.exists;
  const step = resumeStep(record, exists);
  if (step === null) return false;

  mountOnboarding(root, {
    step,
    vaultExists: exists,
    incognitoSkipped: record.incognitoSkipped,
    onFinish: () => {
      location.href = chrome.runtime.getURL('manager.html');
    },
  });
  return true;
}

/**
 * The guided prompt, for a bookmark that could not be opened.
 *
 * The item id rides in the hash so the "open in a normal window this once" fallback has something
 * to fall back *to*. Reaching the page without one still shows the instructions, without offering
 * to open nothing.
 */
async function showIncognitoPrompt(encoded: string | undefined): Promise<void> {
  const access = await send({ type: 'INCOGNITO_ACCESS' });
  if (access.type === 'ERROR') return;

  const status = qs(document, '#vm-status');
  const itemId = encoded === undefined || encoded === '' ? null : decodeURIComponent(encoded);

  render(
    root,
    incognitoPrompt({
      settingsUrl: access.settingsUrl,
      onRecheck: async () => {
        const rechecked = await send({ type: 'INCOGNITO_ACCESS', recheck: true });
        return rechecked.type !== 'ERROR' && rechecked.allowed;
      },
      ...(itemId === null
        ? {}
        : {
            onFallback: async (clearHistoryAfter: boolean) => {
              const opened = await send({
                type: 'OPEN_ITEM',
                id: itemId,
                force: true,
                clearHistoryAfter,
              });
              if (opened.type === 'ERROR') {
                render(
                  status,
                  h('p', { class: 'vm-notice vm-notice--danger', role: 'alert' }, msg('errorUnknown')),
                );
              }
            },
          }),
    }),
  );
}
