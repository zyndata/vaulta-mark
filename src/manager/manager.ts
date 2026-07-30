/**
 * The manager page's entry point: which of the two screens this tab is.
 *
 * Almost always it is the vault manager (`app.ts`). The exception is `#incognito=<itemId>`, the
 * guided prompt for "Allow in Incognito is off" (ARCHITECTURE §9), which lives on this page rather
 * than in the popup because it asks the user to paste an address into the address bar — and a popup
 * closes the moment they click there.
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

const INCOGNITO_HASH = /^#incognito(?:=(.*))?$/u;

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

  mountManager(root, state);
})();

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
