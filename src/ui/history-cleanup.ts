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

import { confirmDialog, dialogPlural, dialogText } from './dialog.js';
import { h, msg, render } from './dom.js';
import { plural } from './plural.js';

/** One vaulted domain and how many history entries it has. Mirrors the wire shape. */
export interface CleanupDomain {
  readonly domain: string;
  readonly entries: number;
}

/**
 * How many sites the review list will open itself for.
 *
 * Above this it stays a closed `<details>`: the list is a review, and a review of forty sites that
 * pushes the buttons under it off the screen is worse than one that waits to be asked for.
 */
const INLINE_REVIEW_LIMIT = 8;

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
  /**
   * `CLEAR_VAULTED_HISTORY`, answering with how many entries went. `null` on failure.
   *
   * With no argument it is every vaulted domain; with one it is that subset, which is what the
   * *Remove* beside each site in the review list sends.
   */
  readonly clear: (domains?: readonly string[]) => Promise<number | null>;
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
  const check = button('historyCheckButton', () => {
    void (async () => {
      // The dry run searches history once per vaulted domain, which on a vault of any size is
      // seconds rather than milliseconds. Without this the button answered a press by doing
      // nothing visible for that whole time and then replacing itself.
      check.disabled = true;
      check.textContent = msg('historyChecking');
      let preview;
      try {
        preview = await deps.preview();
      } finally {
        check.disabled = false;
        check.textContent = msg('historyCheckButton');
      }
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
  });

  render(
    root,
    done === null ? null : h('p', { class: 'vm-notice vm-notice--ok', role: 'status' }, done),
    h('p', { class: 'vm-small vm-muted' }, msg('historyCheckHint')),
    check,
  );
}

/**
 * The dry run, and the two ways to act on it: all of it, or one site at a time.
 *
 * @param done what the last per-site removal did, if there was one. Kept above the remaining list
 *   rather than sending the panel back to the check button, because clearing one site is usually
 *   the first of several and re-running the whole dry run between them is seconds of scanning to
 *   re-learn what is already on screen.
 */
function paintPreview(
  root: HTMLElement,
  deps: HistoryCleanupDeps,
  preview: CleanupPreview,
  done: string | null = null,
): void {
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
    done === null ? null : h('p', { class: 'vm-notice vm-notice--ok', role: 'status' }, done),
    h(
      'p',
      { class: 'vm-notice vm-notice--warning', role: 'status' },
      `${plural('historyDryRunEntries', preview.entries, [String(preview.entries)])} ${plural('historyDryRunSites', preview.domains.length, [String(preview.domains.length)])}`,
    ),
    // A `<details>` rather than the list itself: twenty-seven domains between the sentence and the
    // button would push the button off the screen, and the point of the list is that it is there for
    // whoever wants it. It is open when the list is short enough to be read at a glance, because the
    // per-site buttons live inside it and a control nobody can see is not an offer.
    h(
      'details',
      { class: 'vm-cleanup-review', open: preview.domains.length <= INLINE_REVIEW_LIMIT },
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
              plural('historyReviewEntries', entry.entries, [String(entry.entries)]),
            ),
            // One site at a time. The site is named in its own confirmation, so a mis-aimed click
            // on a row of look-alike domains still has somewhere to be caught.
            h(
              'button',
              {
                type: 'button',
                class: 'vm-button vm-button--quiet vm-cleanup-remove',
                'aria-label': msg('historyReviewRemoveLabel', [entry.domain]),
                onclick: () => {
                  void confirmAndClearOne(root, deps, preview, entry);
                },
              },
              msg('historyReviewRemove'),
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
      dialogPlural('historyConfirmEntries', preview.entries, [String(preview.entries)]),
      dialogPlural('historyDryRunSites', preview.domains.length, [String(preview.domains.length)]),
      dialogText('historyConfirmCaveat'),
    ],
    confirmLabel: msg('historyClearButton'),
    danger: true,
  });
  if (!confirmed) return;

  const removed = await clearing(root, deps);
  if (removed === null) return;
  paintIdle(root, deps, clearedText(removed));
}

/**
 * One site from the review list.
 *
 * The confirmation names *that* site and quotes *its* count, rather than reusing the whole-vault
 * wording with a smaller number in it: the two actions differ only in scope, so the scope is the
 * one thing the dialog has to say out loud.
 */
async function confirmAndClearOne(
  root: HTMLElement,
  deps: HistoryCleanupDeps,
  preview: CleanupPreview,
  entry: CleanupDomain,
): Promise<void> {
  const confirmed = await confirmDialog({
    heading: msg('historyConfirmHeading'),
    body: [
      dialogPlural('historyConfirmSite', entry.entries, [entry.domain, String(entry.entries)]),
      dialogText('historyConfirmCaveat'),
    ],
    confirmLabel: msg('historyReviewRemove'),
    danger: true,
  });
  if (!confirmed) return;

  const removed = await clearing(root, deps, [entry.domain]);
  if (removed === null) return;

  const rest = preview.domains.filter((candidate) => candidate.domain !== entry.domain);
  const done = clearedText(removed);
  if (rest.length === 0) {
    paintIdle(root, deps, done);
    return;
  }
  paintPreview(
    root,
    deps,
    {
      ...preview,
      domains: rest,
      // This dry run's own numbers minus the site that has just gone, rather than a fresh scan: the
      // sentence above the list describes what *this* check found, and re-scanning between two
      // removals would spend seconds re-learning what is already on the screen.
      entries: Math.max(0, preview.entries - entry.entries),
    },
    done,
  );
}

/**
 * Delete, with the panel saying so while it happens.
 *
 * Deleting is a `deleteUrl` per entry, so a few hundred of them is a few seconds during which the
 * panel would otherwise still be offering the button that started it. Answers `null` when the
 * deletion failed, having already said so — the callers have nothing to add.
 */
async function clearing(
  root: HTMLElement,
  deps: HistoryCleanupDeps,
  domains?: readonly string[],
): Promise<number | null> {
  render(root, h('p', { class: 'vm-notice', role: 'status' }, msg('historyClearing')));
  const removed = await deps.clear(domains);
  if (removed === null) {
    render(root, h('p', { class: 'vm-notice vm-notice--danger', role: 'alert' }, msg('historyCheckFailed')));
  }
  return removed;
}

function clearedText(removed: number): string {
  return plural('historyCleared', removed, [String(removed)]);
}

function button(
  labelKey: string,
  onClick: () => void,
  className = 'vm-button vm-button--quiet',
): HTMLButtonElement {
  return h('button', { type: 'button', class: className, onclick: onClick }, msg(labelKey));
}
