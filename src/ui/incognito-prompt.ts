/**
 * The guided prompt for "Allow in Incognito is off" (ARCHITECTURE §9).
 *
 * This screen exists because of a hole in the extension APIs: there is no way to *request* incognito
 * access, and no way to set it. What there **is** — corrected 2026-08-17, having been believed
 * otherwise since Phase 5 — is a way to take the user to the page that grants it:
 * `chrome.tabs.create` opens a `chrome://` address perfectly well. Only an `<a href="chrome://…">`
 * is refused, and `window.open` is dropped in silence, which is how the wrong conclusion survived.
 *
 * So step 1 is a button now, not an address to copy. Steps 2 and 3 are unchanged and are the part
 * that could never be automated: finding the toggle, and coming back.
 *
 * `onOpenSettings` is injected rather than called here for the reason every callback in this
 * directory is: `src/ui/**` renders, and the layer that owns `chrome.*` acts. It also means a test
 * asserts the *press*, without a browser to open a tab in.
 *
 * It lives on the manager page rather than in the popup because of what is below it — a fallback
 * with a consequence and a history checkbox is not a 422-pixel column's worth of screen — and
 * because opening a tab closes a popup anyway.
 *
 * The fallback — open in a normal window, this once — is an explicit, labelled choice with the
 * consequence written next to it, never a silent degradation. That is the whole difference between
 * a bookmark manager that keeps its promise and one that quietly stops keeping it.
 */

import { h, msg, render } from './dom.js';

export interface IncognitoPromptOptions {
  /** Re-read the toggle. Resolves to the new state, which this screen renders itself. */
  readonly onRecheck: () => Promise<boolean>;
  /** Open `chrome://extensions/?id=…` in a tab. The caller holds the URL and the tabs API. */
  readonly onOpenSettings: () => void;
  /**
   * Open the item in a normal window anyway. Absent when the prompt was reached without an item
   * to open — the guided text is still worth showing, but there is nothing to fall back *to*.
   */
  readonly onFallback?: (clearHistoryAfter: boolean) => Promise<void>;
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
    incognitoSteps(options.onOpenSettings),
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

/**
 * The three steps, exported because onboarding's step 3 asks the same thing.
 *
 * Shared rather than repeated: the two screens differ in what surrounds them (a fallback here, Skip
 * and a progress bar there) and not at all in the instruction, and an instruction that drifts
 * between two places is how one of them ends up describing a version of Chrome nobody is running.
 */
export function incognitoSteps(onOpenSettings: () => void): HTMLElement {
  return h(
    'ol',
    { class: 'vm-steps' },
    h(
      'li',
      null,
      msg('incognitoStep1'),
      ' ',
      h(
        'button',
        { type: 'button', class: 'vm-button vm-button--quiet vm-button--inline', onclick: onOpenSettings },
        msg('incognitoOpenSettings'),
      ),
    ),
    h('li', null, msg('incognitoStep2')),
    h('li', null, msg('incognitoStep3')),
  );
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
