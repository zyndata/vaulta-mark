/**
 * The duplicates screen: every address saved more than once, with its copies side by side.
 *
 * A screen rather than a filtered list, because the list column shows one row per bookmark and the
 * question here is about *groups* — and because a row is an `option` in a listbox, which may hold
 * nothing you can tick.
 *
 * **Nothing is chosen for the user.** Copies of one address differ in title, folder, tags, note and
 * age, and which of those matters is exactly what this screen cannot know: the copy in the right
 * folder may be the one with the wrong title. So every checkbox starts clear, and the only
 * shortcut offered — *Tick all but the oldest* — is a button somebody presses, not a default
 * somebody has to notice and undo. A screen whose only verb is *delete* does not get to guess.
 *
 * Removal leaves through the caller's `remove`, which is the same `DELETE_ITEMS` path the list
 * column's Delete key uses: one batch, one `vaultRev`, one set of tombstones, one 8-second undo.
 * The selection spans groups on purpose — cleaning forty addresses should be one undo, not forty.
 *
 * Read once, when the screen opens, and again after it has removed something. It is a review, not
 * a live view: a list that rearranged itself under a decision in progress would move the row out
 * from under the cursor, and the only edit that matters here is the one being made on this screen.
 */

import { send, type DuplicateGroupView, type DuplicateRow } from '../shared/messages.js';
import { confirmDialog, dialogText } from '../ui/dialog.js';
import { append, h, msg, render } from '../ui/dom.js';
import { errorText } from '../ui/strings.js';

export interface DuplicatesScreenDeps {
  readonly onBack: () => void;
  /**
   * Delete these ids as one batch, with the undo toast, answering whether it happened.
   *
   * A callback rather than a `send` here so there is exactly one delete-with-undo in the manager.
   * A second one would be a second thing to keep atomic, and the two would drift.
   *
   * No `say` beside it, unlike the other screens: the only thing this one has to report is the
   * removal, and the toast that carries the undo already says how many went. A live-region line
   * repeating it would be the same sentence twice.
   */
  readonly remove: (ids: readonly string[]) => Promise<boolean>;
}

/**
 * Build the screen. It fills itself in once its own request comes back.
 *
 * Returned synchronously, like `ioScreen`, so the caller can put it on the page and let the round
 * trip land into it — the alternative is a click with nothing on screen until the worker answers.
 */
export function duplicatesScreen(deps: DuplicatesScreenDeps): HTMLElement {
  const body = h('div', { class: 'vm-dupes-body' }, h('p', { class: 'vm-placeholder' }, msg('dupesLoading')));

  const root = h(
    'section',
    { class: 'vm-dupes', 'aria-label': msg('dupesHeading') },
    h(
      'div',
      { class: 'vm-dupes-head' },
      h('h2', null, msg('dupesHeading')),
      h(
        'button',
        { type: 'button', class: 'vm-button vm-button--inline', onclick: deps.onBack },
        msg('dupesBack'),
      ),
    ),
    body,
  );

  void reload(body, deps);
  return root;
}

/* ------------------------------------------------------------------ contents */

async function reload(body: HTMLElement, deps: DuplicatesScreenDeps): Promise<void> {
  const response = await send({ type: 'LIST_DUPLICATES' });
  if (response.type === 'ERROR') {
    // The vault locking under this screen is the usual way here, and `app.ts` is already tearing
    // the page down when that happens. Anything else is worth reading rather than a blank panel.
    render(body, h('p', { class: 'vm-placeholder' }, errorText(response.code)));
    return;
  }
  render(body, ...contents(response.groups, body, deps));
}

function contents(
  groups: readonly DuplicateGroupView[],
  body: HTMLElement,
  deps: DuplicatesScreenDeps,
): HTMLElement[] {
  if (groups.length === 0) {
    return [
      h('p', { class: 'vm-placeholder' }, msg('dupesEmpty')),
      h('p', { class: 'vm-hint vm-small vm-muted' }, msg('dupesRule')),
    ];
  }

  const selection = new Set<string>();
  const removeButton = h('button', {
    type: 'button',
    class: 'vm-button vm-button--danger',
    disabled: true,
  });

  function paintRemove(): void {
    removeButton.disabled = selection.size === 0;
    render(removeButton, msg('dupesRemoveSelected', [String(selection.size)]));
  }
  paintRemove();

  removeButton.addEventListener('click', () => {
    void (async () => {
      if (await confirmRemoval(groups, selection, deps)) await reload(body, deps);
    })();
  });

  return [
    h(
      'div',
      { class: 'vm-dupes-intro' },
      h('p', null, msg('dupesIntro', [String(groups.length)])),
      h('p', { class: 'vm-hint vm-small vm-muted' }, msg('dupesRule')),
    ),
    h('div', { class: 'vm-dupes-bar' }, removeButton),
    h(
      'ol',
      { class: 'vm-dupes-groups' },
      ...groups.map((group) => groupItem(group, selection, paintRemove)),
    ),
  ];
}

function groupItem(
  group: DuplicateGroupView,
  selection: Set<string>,
  onChange: () => void,
): HTMLElement {
  // The oldest copy's address, not the group's key: the key is a normal form with the campaign
  // parameters and the fragment already taken off, and showing it would put an address on screen
  // that none of these bookmarks actually holds.
  const first = group.items[0];
  const address = first?.url ?? '';

  const boxes: HTMLInputElement[] = [];
  const copies = group.items.map((item) => {
    const box = h('input', {
      type: 'checkbox',
      class: 'vm-dupes-check',
      'aria-label': msg('dupesRemoveLabel', [item.title]),
      onchange: () => {
        if (box.checked) selection.add(item.id);
        else selection.delete(item.id);
        onChange();
      },
    });
    boxes.push(box);
    return copyItem(item, box, address);
  });

  return h(
    'li',
    { class: 'vm-dupes-group' },
    h(
      'div',
      { class: 'vm-dupes-group-head' },
      h('p', { class: 'vm-dupes-address' }, address),
      h('p', { class: 'vm-small vm-muted' }, msg('dupesCopies', [String(group.items.length)])),
    ),
    h('ul', { class: 'vm-dupes-copies' }, ...copies),
    h(
      'div',
      { class: 'vm-dupes-group-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'vm-button vm-button--quiet vm-button--inline',
          onclick: () => {
            // Every copy but the first, and the first is the oldest. A shortcut for the common
            // shape — same page saved twice, nothing to choose between them — that still leaves
            // the user looking at what is ticked before anything is removed.
            for (const [index, box] of boxes.entries()) {
              if (index === 0 || box.checked) continue;
              box.checked = true;
              box.dispatchEvent(new Event('change'));
            }
          },
        },
        msg('dupesTickExtras'),
      ),
    ),
  );
}

function copyItem(item: DuplicateRow, box: HTMLInputElement, groupAddress: string): HTMLElement {
  const folder =
    item.path.length === 0
      ? msg('dupesTopLevel')
      : msg('detailInFolder', [item.path.map((crumb) => crumb.title).join(' / ')]);

  const facts = h(
    'p',
    { class: 'vm-small vm-muted vm-dupes-facts' },
    folder,
    ' · ',
    msg('dupesAdded', [new Date(item.createdAt).toLocaleDateString()]),
    item.hasNote ? ' · ' : null,
    item.hasNote ? msg('dupesHasNote') : null,
  );

  const row = h(
    'li',
    { class: 'vm-dupes-copy' },
    h('label', { class: 'vm-dupes-copy-label' }, box, h('span', { class: 'vm-dupes-title' }, item.title)),
    facts,
  );

  if (item.tags.length > 0) {
    append(
      row,
      h(
        'p',
        { class: 'vm-chips vm-dupes-tags' },
        ...item.tags.map((tag) => h('span', { class: 'vm-chip vm-chip--small' }, tag)),
      ),
    );
  }

  // Only when it differs. Two copies whose addresses are identical need no second line, and every
  // group has at least one copy that matches the heading — printing it under each one would make
  // the one line worth reading impossible to spot.
  if (item.url !== undefined && item.url !== groupAddress) {
    append(row, h('p', { class: 'vm-small vm-muted vm-dupes-url' }, msg('dupesSavedAs', [item.url])));
  }
  return row;
}

/* ------------------------------------------------------------------ removal */

/**
 * Ask, then remove.
 *
 * The question names two numbers when they differ, and the second is the one worth stopping for:
 * ticking *every* copy of an address removes that bookmark from the vault outright. That is a
 * legitimate thing to want — the page is gone, the project is over — but it is not what a screen
 * called "duplicates" implies, and it is the one outcome here that the undo is the only way back
 * from.
 */
async function confirmRemoval(
  groups: readonly DuplicateGroupView[],
  selection: ReadonlySet<string>,
  deps: DuplicatesScreenDeps,
): Promise<boolean> {
  const ids = [...selection];
  if (ids.length === 0) return false;

  let emptied = 0;
  for (const group of groups) {
    if (group.items.every((item) => selection.has(item.id))) emptied += 1;
  }

  const confirmed = await confirmDialog({
    heading: msg('dupesConfirmHeading', [String(ids.length)]),
    body: [
      ...(emptied === 0
        ? []
        : [
            dialogText(emptied === 1 ? 'dupesConfirmEmptiedOne' : 'dupesConfirmEmptied', [
              String(emptied),
            ]),
          ]),
      dialogText('deleteConfirmBody'),
    ],
    confirmLabel: msg('dupesConfirmButton'),
    danger: true,
  });
  if (!confirmed) return false;

  return await deps.remove(ids);
}
