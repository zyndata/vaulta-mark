/**
 * A `chrome://` address the user has to open by hand, with a Copy button.
 *
 * Three separate screens need this exact widget — the incognito prompt, onboarding step 5, and
 * Settings → Privacy — because Chrome forbids an extension from navigating to a `chrome://` URL
 * and offers no API for either of the two settings behind them. What is left is: show the address,
 * make it one click to copy, and say plainly that we cannot do it for you.
 *
 * Rendered as text in a `<code>` rather than as a link: an `<a href="chrome://…">` is a link Chrome
 * refuses to follow from an extension page, and a dead link is a worse instruction than a string the
 * user can see and copy.
 */

import { h, msg } from './dom.js';

export interface AddressOptions {
  readonly address: string;
  /** Injected so a test needs no clipboard, and so a refusal has one place to be handled. */
  readonly copy?: (text: string) => Promise<void>;
}

export function copyableAddress(options: AddressOptions): HTMLElement {
  const feedback = h('span', { class: 'vm-small vm-muted', role: 'status' });
  const copy = options.copy ?? ((text: string) => navigator.clipboard.writeText(text));

  return h(
    'span',
    { class: 'vm-address' },
    h('code', null, options.address),
    h(
      'button',
      {
        class: 'vm-button vm-button--quiet vm-button--inline',
        type: 'button',
        onclick: () => {
          void (async () => {
            try {
              await copy(options.address);
              feedback.textContent = msg('incognitoCopied');
            } catch {
              // A clipboard write can be refused (an unfocused document, an enterprise policy). The
              // address is on screen either way, so this degrades to "select it yourself".
              feedback.textContent = msg('incognitoCopyFailed');
            }
          })();
        },
      },
      msg('incognitoCopyButton'),
    ),
    feedback,
  );
}

/**
 * Chrome's own settings page for "Autocomplete searches and URLs" (ARCHITECTURE §12.4).
 *
 * A constant rather than a string built at the call site, because it appears in two screens and a
 * typo in one of them produces a page that opens and shows nothing, which reads as our instructions
 * being wrong rather than the address being wrong.
 */
export const AUTOCOMPLETE_SETTINGS_URL = 'chrome://settings/?search=autocomplete';
