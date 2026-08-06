/**
 * The detail pane: everything about one item, and the only place any of it is edited.
 *
 * Edits are **explicit**. There is a Save button, and nothing is written until it is pressed. A
 * pane that saved as you typed would be pleasant right up to the first time someone selected the
 * wrong row and started typing over a note — and there is no version history to get it back from.
 *
 * The tag input is a chip field rather than a comma-separated string, because tags are normalized
 * on the way in (lowercased, whitespace collapsed, deduped) and a text box would show the user
 * something different from what was stored the moment they pressed Save.
 *
 * This is also where a *folder* is renamed and deleted. The sidebar navigates; properties live
 * here, so there is one place to learn rather than two.
 */

import { h, msg, render } from '../ui/dom.js';
import { inlinePreview, type ThumbData } from '../ui/thumb.js';
import type { ItemDetail } from '../shared/messages.js';
import { MAX_NOTE_LENGTH } from '../vault/types.js';

export interface DetailDeps {
  /** The single selected item, or `null` when zero or many are selected. */
  readonly item: ItemDetail | null;
  readonly selectionCount: number;
  /** The preview, fetched when the pane is built. Not part of `ItemDetail`: it is 40 KB. */
  readonly loadThumb: (id: string) => Promise<ThumbData>;
  /**
   * "Refresh preview" was clicked.
   *
   * Named for what it is rather than for what it does, because what it does is open the page —
   * re-capturing needs the page loaded and needs the `activeTab` grant that only a gesture on that
   * tab creates. The pane says so in words before the button is pressed (§14.5).
   */
  readonly refreshPreview: (item: ItemDetail) => void;
  readonly save: (patch: {
    title: string;
    url?: string;
    note: string | null;
    tags: string[] | null;
  }) => Promise<void>;
  readonly open: (id: string) => void;
  readonly renameFolder: (item: ItemDetail) => void;
  readonly deleteFolder: (item: ItemDetail) => void;
}

export function detailPane(deps: DetailDeps): HTMLElement {
  const aside = h('aside', { class: 'vm-detail', 'aria-label': msg('detailLabel') });

  if (deps.item === null) {
    render(
      aside,
      h(
        'p',
        { class: 'vm-muted' },
        deps.selectionCount > 1
          ? msg('detailMany', [String(deps.selectionCount)])
          : msg('detailNothing'),
      ),
    );
    return aside;
  }

  const item = deps.item;
  const isFolder = item.type === 'folder';

  const title = h('input', { type: 'text', value: item.title, autocomplete: 'off' });
  const url = h('input', { type: 'text', value: item.url ?? '', autocomplete: 'off', spellcheck: 'false' });
  const note = h('textarea', { rows: 6, maxlength: MAX_NOTE_LENGTH });
  note.value = item.note;

  const counter = h('p', { class: 'vm-hint vm-small vm-muted' });
  const updateCounter = (): void => {
    counter.textContent = msg('detailNoteCount', [
      String(note.value.length),
      String(MAX_NOTE_LENGTH),
    ]);
  };
  note.addEventListener('input', updateCounter);
  updateCounter();

  const tags = tagField(item.tags);
  const save = h('button', { class: 'vm-button', type: 'submit' }, msg('detailSave'));

  const form = h(
    'form',
    {
      class: 'vm-detail-form',
      onsubmit: (event: Event) => {
        event.preventDefault();
        void (async () => {
          save.disabled = true;
          const next = tags.value();
          // The outcome is reported through the page's live region, not from here: a successful
          // save reloads the vault, and reloading rebuilds this pane — so anything written to an
          // element inside it lands on a node that has already been replaced.
          await deps.save({
            title: title.value,
            ...(isFolder ? {} : { url: url.value }),
            note: note.value === '' ? null : note.value,
            tags: next.length === 0 ? null : next,
          });
          save.disabled = false;
        })();
      },
    },
    field('detailFieldTitle', title),
    isFolder ? null : field('detailFieldUrl', url),
    isFolder ? null : field('detailFieldTags', tags.element),
    isFolder ? null : field('detailFieldNote', note, counter),
    save,
  );

  render(
    aside,
    h(
      'p',
      { class: 'vm-small vm-muted' },
      item.path.length === 0
        ? msg('detailAtTopLevel')
        : msg('detailInFolder', [item.path.map((crumb) => crumb.title).join(' / ')]),
    ),
    form,
    isFolder
      ? h(
          'div',
          { class: 'vm-detail-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'vm-button vm-button--quiet vm-button--inline',
              onclick: () => {
                deps.renameFolder(item);
              },
            },
            msg('folderRename'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'vm-button vm-button--danger vm-button--inline',
              onclick: () => {
                deps.deleteFolder(item);
              },
            },
            msg('folderDelete'),
          ),
        )
      : h(
          'div',
          { class: 'vm-detail-actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'vm-button vm-button--quiet vm-button--inline',
              onclick: () => {
                deps.open(item.id);
              },
            },
            msg('detailOpen'),
          ),
        ),
    isFolder ? null : previewSection(item, deps),
    isFolder
      ? null
      : h(
          'p',
          { class: 'vm-small vm-muted' },
          msg('detailStats', [
            new Date(item.createdAt).toLocaleDateString(),
            String(item.openCount ?? 0),
          ]),
        ),
  );

  return aside;
}

/**
 * The preview, and the plain sentence about what refreshing it costs.
 *
 * Painted asynchronously into a slot rather than awaited before the pane is built: the picture may
 * be a Drive round trip away (§14.6), and a detail pane that waited for it would be a detail pane
 * that stutters every time the selection moves. The slot keeps its shape while it is empty.
 *
 * Nothing here fetches unless the item claims a picture — `hasThumb` is the whole of what a render
 * is allowed to know without asking (INV-4).
 */
function previewSection(item: ItemDetail, deps: DetailDeps): HTMLElement {
  const slot = h('div', { class: 'vm-thumb-slot' });

  if (item.hasThumb) {
    void (async () => {
      const data = await deps.loadThumb(item.id);
      // The pane is rebuilt on every selection change, so by the time this resolves the element may
      // no longer be on the page. Painting into a detached node is harmless; releasing the object
      // URL when it is, is not optional.
      const card = inlinePreview(data);
      if (slot.isConnected) render(slot, card.element);
      else card.release();
    })();
  } else {
    slot.append(h('p', { class: 'vm-thumb-absent vm-small vm-muted' }, msg('thumbNone')));
  }

  return h(
    'section',
    { class: 'vm-detail-preview' },
    h('h3', { class: 'vm-small' }, msg('thumbHeading')),
    slot,
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg('thumbRefreshExplain')),
    h(
      'button',
      {
        type: 'button',
        class: 'vm-button vm-button--quiet vm-button--inline',
        onclick: () => {
          deps.refreshPreview(item);
        },
      },
      msg('thumbRefresh'),
    ),
  );
}

function field(labelKey: string, control: HTMLElement, extra?: HTMLElement): HTMLElement {
  return h('label', { class: 'vm-field' }, h('span', null, msg(labelKey)), control, extra ?? null);
}

/* ------------------------------------------------------------------ tag chips */

interface TagField {
  readonly element: HTMLElement;
  value(): string[];
}

/**
 * A chip input over the tags of one item.
 *
 * Enter and comma commit the typed tag; Backspace on an empty box removes the last chip, which is
 * the behaviour everyone has already learned from every other chip input. Normalization is left to
 * the model — the field only trims and drops duplicates, so what is shown here is what will be
 * stored, without re-implementing the rules in a second place.
 */
function tagField(initial: readonly string[]): TagField {
  let tags = [...initial];

  const chips = h('span', { class: 'vm-chips' });
  const input = h('input', {
    type: 'text',
    class: 'vm-chip-input',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: msg('detailTagsPlaceholder'),
    'aria-label': msg('detailFieldTags'),
  });

  const paint = (): void => {
    render(
      chips,
      ...tags.map((tag) =>
        h(
          'span',
          { class: 'vm-chip' },
          tag,
          h(
            'button',
            {
              type: 'button',
              class: 'vm-chip-remove',
              'aria-label': msg('detailRemoveTag', [tag]),
              onclick: () => {
                tags = tags.filter((entry) => entry !== tag);
                paint();
              },
            },
            '×',
          ),
        ),
      ),
    );
  };
  paint();

  const commit = (): void => {
    const typed = input.value.trim().toLowerCase();
    input.value = '';
    if (typed === '' || tags.includes(typed)) return;
    tags.push(typed);
    paint();
  };

  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ',') {
      // Enter inside a form submits it; committing a tag is not submitting the item.
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === 'Backspace' && input.value === '' && tags.length > 0) {
      tags.pop();
      paint();
    }
  });
  // A tag typed and left uncommitted when the user reaches for Save should still count.
  input.addEventListener('blur', commit);

  return {
    element: h('span', { class: 'vm-tag-field' }, chips, input),
    value: () => [...tags],
  };
}
