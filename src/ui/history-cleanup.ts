/**
 * "Clear history for the domains in my vault" — the widget (ARCHITECTURE §12.2).
 *
 * The same panel appears in onboarding step 5 and in Settings → Privacy, which is why it is here
 * rather than in either of them: this is a tool that deletes browsing history, and a version of it
 * that showed the dry run in one place and not the other would be a different tool wearing the same
 * name.
 *
 * Three properties it exists to guarantee:
 *
 * - **The permission is asked for in context, with the reason on screen first.** `history` is an
 *   optional permission (D26) precisely so it is never part of an install prompt nobody reads.
 * - **Nothing is deleted before a dry run has been shown.** The count *and* the domain list, because
 *   §12.2 asks for "review the list" and a number on its own is not reviewable — it is something you
 *   accept or abandon, while a list is something you can disagree with.
 * - **It never claims to have done more than it did.** The confirm sends a fresh request and reports
 *   the number that came back, not the number the preview promised.
 *
 * Callbacks rather than `send` calls, like `tracking.ts` and `incognito-prompt.ts`: no service
 * worker is needed to test it, and two screens wire the same three messages to it.
 */

import { confirmDialog, dialogText } from './dialog.js';
import { h, msg, render } from './dom.js';

/** One vaulted domain and how many history entries it has. Mirrors the wire shape. */
export interface CleanupDomain {
  readonly domain: string;
  readonly entries: number;
}

export interface CleanupPreview {
  readonly granted: boolean;
  readonly domains: readonly CleanupDomain[];
  readonly searched: number;
  readonly entries: number;
}

export interface HistoryCleanupDeps {
  /** Ask Chrome for the `history` permission. Must be called during a click, from a page. */
  readonly request: () => Promise<boolean>;
  /** `PREVIEW_HISTORY_CLEANUP`. `null` when the request failed. */
  readonly preview: () => Promise<CleanupPreview | null>;
  /** `CLEAR_VAULTED_HISTORY`, answering with how many entries went. `null` on failure. */
  readonly clear: () => Promise<number | null>;
  /** Whether the permission is already granted, as of mount. */
  readonly granted: boolean;
}

/**
 * Build the panel.
 *
 * Returns a container that re-renders itself: the state it shows moves from "not allowed" through
 * "allowed, nothing checked yet" to "here is what would go", and each transition is something the
 * user just did rather than something a parent screen can predict.
 */
export function historyCleanupPanel(deps: HistoryCleanupDeps): HTMLElement {
  const root = h('div', { class: 'vm-cleanup' });
  paintPermission(root, deps);
  return root;
}

function paintPermission(root: HTMLElement, deps: HistoryCleanupDeps): void {
  if (deps.granted) {
    paintIdle(root, deps, null);
    return;
  }
  render(
    root,
    h('p', { class: 'vm-small vm-muted' }, msg('historyPermissionExplained')),
    button('historyGrantButton', () => {
      void (async () => {
        // Requested here, in the page, during the click: `chrome.permissions.request` needs a user
        // gesture and refuses to run in a service worker at all.
        if (await deps.request()) paintIdle(root, { ...deps, granted: true }, null);
        else render(root, h('p', { class: 'vm-notice vm-notice--warning' }, msg('historyRefused')));
      })();
    }),
  );
}

/** Granted, and nothing checked yet — or checked and then acted on, which lands back here. */
function paintIdle(root: HTMLElement, deps: HistoryCleanupDeps, done: string | null): void {
  render(
    root,
    done === null ? null : h('p', { class: 'vm-notice vm-notice--ok', role: 'status' }, done),
    h('p', { class: 'vm-small vm-muted' }, msg('historyCheckHint')),
    button('historyCheckButton', () => {
      void (async () => {
        const preview = await deps.preview();
        if (preview === null) {
          render(root, h('p', { class: 'vm-notice vm-notice--danger', role: 'alert' }, msg('historyCheckFailed')));
          return;
        }
        // The permission can have been revoked between mount and this click, from
        // `chrome://extensions`. The worker's answer is the authority, not what we were told at
        // mount.
        if (!preview.granted) {
          paintPermission(root, { ...deps, granted: false });
          return;
        }
        paintPreview(root, deps, preview);
      })();
    }),
  );
}

function paintPreview(root: HTMLElement, deps: HistoryCleanupDeps, preview: CleanupPreview): void {
  if (preview.entries === 0) {
    render(
      root,
      h(
        'p',
        { class: 'vm-notice', role: 'status' },
        msg('historyDryRunNothing', [String(preview.searched)]),
      ),
      button('historyCheckAgainButton', () => {
        paintIdle(root, deps, null);
      }),
    );
    return;
  }

  render(
    root,
    h(
      'p',
      { class: 'vm-notice vm-notice--warning', role: 'status' },
      preview.domains.length === 1
        ? msg('historyDryRunOneDomain', [String(preview.entries)])
        : msg('historyDryRun', [String(preview.entries), String(preview.domains.length)]),
    ),
    // A `<details>` rather than the list itself: twenty-seven domains between the sentence and the
    // button would push the button off the screen, and the point of the list is that it is there for
    // whoever wants it.
    h(
      'details',
      { class: 'vm-cleanup-review' },
      h('summary', null, msg('historyReview')),
      h(
        'ul',
        { class: 'vm-small' },
        ...preview.domains.map((entry) =>
          h(
            'li',
            null,
            h('code', null, entry.domain),
            ' ',
            h(
              'span',
              { class: 'vm-muted' },
              entry.entries === 1
                ? msg('historyReviewOneEntry')
                : msg('historyReviewEntries', [String(entry.entries)]),
            ),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'vm-onboarding-actions' },
      button(
        'historyClearButton',
        () => {
          void confirmAndClear(root, deps, preview);
        },
        'vm-button vm-button--danger',
      ),
      button('historyCancelButton', () => {
        paintIdle(root, deps, null);
      }),
    ),
  );
}

async function confirmAndClear(
  root: HTMLElement,
  deps: HistoryCleanupDeps,
  preview: CleanupPreview,
): Promise<void> {
  const confirmed = await confirmDialog({
    heading: msg('historyConfirmHeading'),
    body: [
      dialogText('historyConfirmBody', [String(preview.entries), String(preview.domains.length)]),
      dialogText('historyConfirmCaveat'),
    ],
    confirmLabel: msg('historyClearButton'),
    danger: true,
  });
  if (!confirmed) return;

  const removed = await deps.clear();
  if (removed === null) {
    render(root, h('p', { class: 'vm-notice vm-notice--danger', role: 'alert' }, msg('historyCheckFailed')));
    return;
  }
  paintIdle(
    root,
    deps,
    removed === 1 ? msg('historyClearedOne') : msg('historyCleared', [String(removed)]),
  );
}

function button(labelKey: string, onClick: () => void, className = 'vm-button vm-button--quiet'): HTMLElement {
  return h('button', { type: 'button', class: className, onclick: onClick }, msg(labelKey));
}
