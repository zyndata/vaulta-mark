/**
 * A value the user has to copy and carry somewhere this extension cannot reach, with a Copy button.
 *
 * Its remaining callers are the Drive setup steps in Settings — this build's extension id and the
 * OAuth scope, both of which have to be pasted into the Google Cloud console. That is a place no
 * extension can reach and one INV-3 forbids us from even linking to, so showing the value and making
 * it one click to copy is the whole of what can be offered.
 *
 * **It used to carry `chrome://` addresses too, and no longer does** (2026-08-17). The incognito
 * prompt and onboarding step 3 showed `chrome://extensions/?id=…` to paste, on the belief that an
 * extension cannot navigate there. `chrome.tabs.create` can; only an `<a href>` is refused and
 * `window.open` fails silently. Both screens are buttons now — see `ui/incognito-prompt.ts`. The
 * widget stays because the console values are a genuinely different case: there is no API that opens
 * somebody's Google Cloud project.
 *
 * Rendered as text in a `<code>` rather than as a link, which for those values is INV-3's doing.
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
