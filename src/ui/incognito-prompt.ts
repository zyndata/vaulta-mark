/**
 * The guided prompt for "Allow in Incognito is off" (ARCHITECTURE §9).
 *
 * This screen exists because of a hole in the extension APIs: there is no way to *request*
 * incognito access, and no way to navigate the user to the page that grants it — Chrome forbids an
 * extension from opening a `chrome://` URL programmatically. What is left is to explain the
 * setting, hand over the address to paste, and offer a button that re-checks.
 *
 * It lives on the manager page rather than in the popup for a practical reason: the user has to
 * click into the address bar to paste the link, and a popup closes the moment they do.
 *
 * The fallback — open in a normal window, this once — is an explicit, labelled choice with the
 * consequence written next to it, never a silent degradation. That is the whole difference between
 * a bookmark manager that keeps its promise and one that quietly stops keeping it.
 */

import { copyableValue } from './address.js';
import { h, msg, render } from './dom.js';

export interface IncognitoPromptOptions {
  /** `chrome://extensions/?id=…`, from the service worker — only it knows the extension id. */
  readonly settingsUrl: string;
  /** Re-read the toggle. Resolves to the new state, which this screen renders itself. */
  readonly onRecheck: () => Promise<boolean>;
  /**
   * Open the item in a normal window anyway. Absent when the prompt was reached without an item
   * to open — the guided text is still worth showing, but there is nothing to fall back *to*.
   */
  readonly onFallback?: (clearHistoryAfter: boolean) => Promise<void>;
  /** Injected so a test does not need a clipboard, and so a failure has one place to be handled. */
  readonly copy?: (text: string) => Promise<void>;
}

/**
 * Build the prompt.
 *
 * Returns a container that re-renders itself on Re-check: the state it shows is "is the toggle on",
 * and that is a question only Chrome can answer, asynchronously, at a moment the user chooses.
 */
export function incognitoPrompt(options: IncognitoPromptOptions): HTMLElement {
  const root = h('section', { class: 'vm-guide' });
  renderPrompt(root, options, null);
  return root;
}

/** `null` = not re-checked yet; `true`/`false` = the answer to the last Re-check. */
type RecheckState = boolean | null;

function renderPrompt(
  root: HTMLElement,
  options: IncognitoPromptOptions,
  recheck: RecheckState,
): void {
  const status = h('p', { class: 'vm-notice', role: 'status', hidden: recheck === null });
  if (recheck !== null) {
    status.textContent = msg(recheck ? 'incognitoNowOn' : 'incognitoStillOff');
    status.classList.toggle('vm-notice--warning', !recheck);
  }

  render(
    root,
    h('h2', null, msg('incognitoHeading')),
    h('p', null, msg('incognitoWhy')),
    h(
      'ol',
      { class: 'vm-steps' },
      h('li', null, msg('incognitoStep1'), ' ', addressBlock(options)),
      h('li', null, msg('incognitoStep2')),
      h('li', null, msg('incognitoStep3')),
    ),
    status,
    h(
      'button',
      {
        class: 'vm-button',
        type: 'button',
        onclick: () => {
          void (async () => {
            renderPrompt(root, options, await options.onRecheck());
          })();
        },
      },
      msg('incognitoRecheck'),
    ),
    ...fallbackSection(options),
  );
}

/** The address to paste, with a Copy button. Shared with onboarding and Settings → Privacy. */
function addressBlock(options: IncognitoPromptOptions): HTMLElement {
  return copyableValue({
    value: options.settingsUrl,
    ...(options.copy === undefined ? {} : { copy: options.copy }),
  });
}

/** The explicit fallback. Present only when there is an item it could open. */
function fallbackSection(options: IncognitoPromptOptions): HTMLElement[] {
  const fallback = options.onFallback;
  if (fallback === undefined) return [];

  const clearHistory = h('input', { type: 'checkbox', id: 'vm-clear-history' });
  const button = h(
    'button',
    {
      class: 'vm-button vm-button--quiet',
      type: 'button',
      onclick: () => {
        button.disabled = true;
        void fallback(clearHistory.checked).finally(() => {
          button.disabled = false;
        });
      },
    },
    msg('incognitoFallbackButton'),
  );

  return [
    h('hr', { class: 'vm-rule' }),
    h('h3', null, msg('incognitoFallbackHeading')),
    h('p', { class: 'vm-notice vm-notice--warning' }, msg('incognitoFallbackWarning')),
    h(
      'div',
      { class: 'vm-checkbox' },
      clearHistory,
      h('label', { for: 'vm-clear-history' }, msg('incognitoFallbackClearHistory')),
    ),
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg('incognitoFallbackClearHistoryHint')),
    button,
  ];
}
