/**
 * A value the user has to copy and carry somewhere this extension cannot reach, with a Copy button.
 *
 * Three screens need this exact widget, for the same underlying reason twice over:
 *
 * - the incognito prompt in the manager and the one in onboarding step 3, showing a `chrome://`
 *   address — Chrome forbids an extension from navigating to one and offers no API for the setting
 *   behind it;
 * - the Drive setup steps in Settings, showing this build's extension id and the OAuth scope, which
 *   have to be pasted into the Google Cloud console — a place no extension can reach either, and
 *   one INV-3 forbids us from even linking to.
 *
 * What is left in all three cases is the same: show the value, make it one click to copy, and say
 * plainly that we cannot do it for you.
 *
 * Rendered as text in a `<code>` rather than as a link. For a `chrome://` address an `<a href>` is
 * a link Chrome refuses to follow from an extension page, and a dead link is a worse instruction
 * than a string the user can see and copy; for the console, INV-3 settles it.
 */

import { h, msg } from './dom.js';

export interface CopyableValueOptions {
  readonly value: string;
  /** Injected so a test needs no clipboard, and so a refusal has one place to be handled. */
  readonly copy?: (text: string) => Promise<void>;
}

export function copyableValue(options: CopyableValueOptions): HTMLElement {
  const feedback = h('span', { class: 'vm-small vm-muted', role: 'status' });
  const copy = options.copy ?? ((text: string) => navigator.clipboard.writeText(text));

  return h(
    'span',
    { class: 'vm-address' },
    h('code', null, options.value),
    h(
      'button',
      {
        class: 'vm-button vm-button--quiet vm-button--inline',
        type: 'button',
        onclick: () => {
          void (async () => {
            try {
              await copy(options.value);
              feedback.textContent = msg('copied');
            } catch {
              // A clipboard write can be refused (an unfocused document, an enterprise policy). The
              // value is on screen either way, so this degrades to "select it yourself".
              feedback.textContent = msg('copyFailed');
            }
          })();
        },
      },
      msg('copyButton'),
    ),
    feedback,
  );
}
