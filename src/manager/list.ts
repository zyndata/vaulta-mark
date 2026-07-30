/**
 * The main list: rows, selection, and the keyboard.
 *
 * Two decisions shape everything here.
 *
 * **A row is an `option`, not a container of buttons.** Multi-select with per-row action buttons is
 * a shape that has no correct ARIA spelling — a `listbox` may not contain interactive descendants,
 * and a `grid` turns every action into a cell the user must arrow through. So the rows are pure
 * options in a multi-selectable listbox, and everything you can *do* to them lives in the toolbar
 * above and the detail pane beside. That is also why the whole list is one tab stop.
 *
 * **The list is windowed** (`ui/virtual-list.ts`), which means a row for an item can be created,
 * destroyed and created again while nothing about that item changed. Selection therefore lives in
 * a set of ids held by the caller, never in a class on an element: a selected row that scrolls out
 * of view and back must come back selected.
 */

import { h, msg } from '../ui/dom.js';
import { displayHost, faviconImage } from '../ui/favicon.js';
import { matchRanges } from '../vault/search.js';
import { VirtualList } from '../ui/virtual-list.js';
import type { ListRow } from '../shared/messages.js';

/** Must match `.vm-row` in manager.css — the windowing arithmetic depends on it. */
export const ROW_HEIGHT = 44;

export interface ListDeps {
  /** Click, ctrl/cmd-click and shift-click all land here with the modifiers intact. */
  readonly onSelect: (index: number, modifiers: { toggle: boolean; range: boolean }) => void;
  /** Enter, or a double click. A folder opens *into*; a bookmark opens in incognito. */
  readonly onActivate: (row: ListRow) => void;
  readonly onKey: (event: KeyboardEvent) => void;
}

export class BookmarkList {
  readonly element: HTMLElement;

  readonly #list: VirtualList<ListRow>;
  readonly #deps: ListDeps;
  #selection: ReadonlySet<string> = new Set();
  #terms: readonly string[] = [];
  #cursor = -1;

  constructor(deps: ListDeps) {
    this.#deps = deps;
    this.#list = new VirtualList<ListRow>({
      rowHeight: ROW_HEIGHT,
      label: msg('listLabel'),
      renderRow: (row, index) => this.#renderRow(row, index),
    });
    this.element = this.#list.element;
    this.element.addEventListener('keydown', (event) => {
      deps.onKey(event);
    });
  }

  get length(): number {
    return this.#list.length;
  }

  /** Replace the rows. Resets the window; the caller re-applies selection and cursor after. */
  setRows(rows: readonly ListRow[], terms: readonly string[]): void {
    this.#terms = terms;
    this.#list.setItems(rows);
  }

  /**
   * Update selection and cursor without rebuilding the data.
   *
   * `refresh()` rather than a targeted class toggle: only the windowed rows exist, so there is
   * nothing to toggle on the ones that do not, and rebuilding two dozen rows is cheaper than
   * keeping a second index of which element is currently showing which id.
   */
  setSelection(selection: ReadonlySet<string>, cursor: number): void {
    this.#selection = selection;
    this.#cursor = cursor;
    if (cursor >= 0) this.#list.scrollToIndex(cursor);
    this.#list.refresh();
    if (cursor >= 0) {
      const row = this.#list.rowAt(cursor);
      // The listbox itself keeps the focus (it is one tab stop); `aria-activedescendant` is what
      // tells a screen reader which option the cursor is on.
      if (row !== undefined) this.element.setAttribute('aria-activedescendant', row.id);
    } else this.element.removeAttribute('aria-activedescendant');
  }

  focus(): void {
    this.element.focus();
  }

  destroy(): void {
    this.#list.destroy();
  }

  /* ---------------------------------------------------------------- one row */

  #renderRow(row: ListRow, index: number): HTMLElement {
    const selected = this.#selection.has(row.id);
    const element = h('div', {
      class: `vm-row${selected ? ' is-selected' : ''}${index === this.#cursor ? ' is-cursor' : ''}`,
      role: 'option',
      id: row.id,
      'aria-selected': selected ? 'true' : 'false',
    });

    element.addEventListener('mousedown', (event: MouseEvent) => {
      // `mousedown`, not `click`: shift-clicking a range in a listbox otherwise paints a text
      // selection across every row it passes over.
      event.preventDefault();
      this.#deps.onSelect(index, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
    });
    element.addEventListener('dblclick', () => {
      this.#deps.onActivate(row);
    });

    const icon =
      row.type === 'folder'
        ? h('span', { class: 'vm-row-folder', role: 'presentation' }, '📁')
        : faviconImage(row.url ?? '');

    element.append(
      icon,
      h(
        'span',
        { class: 'vm-row-text' },
        h('span', { class: 'vm-row-title' }, ...highlight(row.title, this.#terms)),
        h(
          'span',
          { class: 'vm-row-sub vm-small vm-muted' },
          row.type === 'folder'
            ? msg('listFolderCount', [String(row.descendants ?? 0)])
            : displayHost(row.url ?? ''),
        ),
      ),
      tagChips(row.tags),
      row.hasNote
        ? h('span', { class: 'vm-row-note', title: msg('listHasNote') }, '📝')
        : h('span', { class: 'vm-row-note' }),
    );
    return element;
  }
}

/** Wrap every match in `<mark>`, leaving the rest of the string as text nodes. */
export function highlight(text: string, terms: readonly string[]): (Node | string)[] {
  const ranges = matchRanges(text, terms);
  if (ranges.length === 0) return [text];

  const out: (Node | string)[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start > at) out.push(text.slice(at, range.start));
    out.push(h('mark', null, text.slice(range.start, range.end)));
    at = range.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * The tags on a row, trimmed to what fits.
 *
 * A bookmark may carry 32 tags and a row is one line; showing all of them would push the title off
 * the screen for the benefit of the one bookmark that has them. The detail pane shows the rest.
 */
function tagChips(tags: readonly string[]): HTMLElement {
  const shown = tags.slice(0, 3);
  return h(
    'span',
    { class: 'vm-row-tags' },
    ...shown.map((tag) => h('span', { class: 'vm-chip vm-chip--small' }, tag)),
    tags.length > shown.length
      ? h('span', { class: 'vm-chip vm-chip--small vm-muted' }, `+${String(tags.length - shown.length)}`)
      : null,
  );
}
