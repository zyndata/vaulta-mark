/**
 * The "copy diagnostics" control (PLAN §9 Phase 12).
 *
 * Callback-injected rather than reaching for `chrome.*` itself, like `incognito-prompt.ts` and
 * `tracking.ts` before it: everything interesting about this panel — that a refusal is stated
 * rather than swallowed, and that the report is *shown* before it is copied — is testable without
 * a service worker or a clipboard.
 *
 * Showing it is the part that is not decoration. The promise made by the button is that this text
 * is safe to paste into a public issue, and a promise about text nobody can see is one the reader
 * has to take on trust from the same program they are filing a bug against. So the report opens in
 * a read-only textarea and the copy happens from there — and if the clipboard is refused, the text
 * is still on screen to select by hand, which is why the two are separate steps at all.
 */

import type { Diagnostics } from '../shared/diagnostics.js';
import { formatDiagnostics } from '../shared/diagnostics.js';
import { h, msg, render } from './dom.js';

export interface DiagnosticsPanelDeps {
  /** Ask the worker for the (already redacted) record. `null` when it could not be reached. */
  readonly collect: () => Promise<Diagnostics | null>;
  /** `navigator.clipboard.writeText`, which is refused in some contexts and rejects in others. */
  readonly copy: (text: string) => Promise<void>;
}

export function diagnosticsPanel(deps: DiagnosticsPanelDeps): HTMLElement {
  const slot = h('div', { class: 'vm-diagnostics' });

  const button = h(
    'button',
    { type: 'button', class: 'vm-button vm-button--quiet' },
    msg('diagnosticsButton'),
  );

  button.addEventListener('click', () => {
    void (async () => {
      button.disabled = true;
      const record = await deps.collect();
      button.disabled = false;
      if (record === null) {
        render(slot, h('p', { class: 'vm-small vm-danger', role: 'alert' }, msg('diagnosticsFailed')));
        return;
      }
      render(slot, ...report(formatDiagnostics(record), deps));
    })();
  });

  return h('div', null, h('p', { class: 'vm-small vm-muted' }, msg('diagnosticsHint')), button, slot);
}

function report(text: string, deps: DiagnosticsPanelDeps): HTMLElement[] {
  const status = h('p', { class: 'vm-small vm-muted', role: 'status' });

  const box = h('textarea', {
    class: 'vm-diagnostics-text',
    rows: 12,
    readonly: true,
    spellcheck: 'false',
    'aria-label': msg('diagnosticsReportLabel'),
  });
  // `.value`, not a text child: a textarea's *content* is its default value, so re-rendering the
  // panel would show the first report forever.
  box.value = text;

  const copy = h(
    'button',
    { type: 'button', class: 'vm-button vm-button--quiet' },
    msg('diagnosticsCopy'),
  );
  copy.addEventListener('click', () => {
    void (async () => {
      try {
        await deps.copy(text);
        status.classList.remove('vm-danger');
        status.textContent = msg('diagnosticsCopied');
      } catch {
        // The text is on screen either way, and saying so is more use than saying "failed".
        status.classList.add('vm-danger');
        status.textContent = msg('diagnosticsCopyFailed');
      }
    })();
  });

  return [box, copy, status];
}
