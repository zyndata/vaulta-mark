/**
 * The manager page.
 *
 * Still the empty shell — the full vault UI is Phase 6 — with one exception: the guided prompt for
 * "Allow in Incognito is off" (ARCHITECTURE §9). It lives here rather than in the popup because it
 * asks the user to paste an address into the address bar, and a popup closes the moment they click
 * there.
 *
 * The hash carries the item that could not be opened (`#incognito=<id>`), so the fallback button
 * has something to fall back *to*. Reaching the page without one still shows the instructions,
 * without offering to open nothing.
 */

import '../ui/styles.css';
import './manager.css';

import { send } from '../shared/messages.js';
import { applyTheme, h, localize, msg, qs, render } from '../ui/dom.js';
import { incognitoPrompt } from '../ui/incognito-prompt.js';

const INCOGNITO_HASH = /^#incognito(?:=(.*))?$/u;

localize(document);

void (async () => {
  const state = await send({ type: 'GET_STATE' });
  if (state.type !== 'ERROR') applyTheme(state.settings.theme, document.documentElement);

  const match = INCOGNITO_HASH.exec(location.hash);
  if (match === null) return;

  const access = await send({ type: 'INCOGNITO_ACCESS' });
  if (access.type === 'ERROR') return;

  const status = qs(document, '#vm-status');
  const encoded = match[1];
  const itemId = encoded === undefined || encoded === '' ? null : decodeURIComponent(encoded);

  render(
    qs(document, '#vm-root'),
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
                  h(
                    'p',
                    { class: 'vm-notice vm-notice--danger', role: 'alert' },
                    msg('errorUnknown'),
                  ),
                );
              }
            },
          }),
    }),
  );
})();
