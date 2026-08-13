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
 *
 * Rows are also drag sources, and folder rows are drop targets (`dnd.ts`). Dragging is a shortcut,
 * never the only route: everything it does is also on the toolbar's *Move to…*, because a pointer
 * gesture is unavailable to a keyboard and awkward on a list five thousand rows long.
 */

import { h, msg } from '../ui/dom.js';
import { displayHost, faviconImage } from '../ui/favicon.js';
import { matchRanges } from '../vault/search.js';
import { VirtualList } from '../ui/virtual-list.js';
import { dropZone, startItemDrag } from './dnd.js';
import type { ListRow } from '../shared/messages.js';

/** Must match `.vm-row` in manager.css — the windowing arithmetic depends on it. */
export const ROW_HEIGHT = 44;

/**
 * How long after a click a second one on the same row still counts as a double click.
 *
 * The list detects double clicks itself instead of listening for `dblclick`, and it has to: the
 * first click changes the selection, `setSelection` calls `VirtualList.refresh()`, and refresh
 * rebuilds every row in the window. The element the first click landed on is gone before the second
 * one arrives, so the browser has no shared target to fire `dblclick` at — which is why
 * double-clicking a folder used to select it twice and open nothing.
 *
 * 500 ms is Windows' own default double-click time, and Chromium's on every platform.
 */
const DOUBLE_CLICK_MS = 500;

export interface ListDeps {
  /** Click, ctrl/cmd-click and shift-click all land here with the modifiers intact. */
  readonly onSelect: (index: number, modifiers: { toggle: boolean; range: boolean }) => void;
  /** Enter, or a double click. A folder opens *into*; a bookmark opens in incognito. */
  readonly onActivate: (row: ListRow) => void;
  readonly onKey: (event: KeyboardEvent) => void;
  /** A drag is starting on this row. Returns the ids to carry, or none to refuse it. */
  readonly onDragStart: (index: number) => readonly string[];
  /** Whether the drag in flight may land in this folder. */
  readonly acceptsDrop: (folderId: string) => boolean;
  readonly onDropInFolder: (folderId: string) => void;
  /** The eye was clicked: pin this row's preview, or put it away (§14.5). */
  readonly onPreview: (row: ListRow, anchor: HTMLElement) => void;
  /** The pointer came to rest on a row that has a picture. Arms the 200 ms hover delay. */
  readonly onHover: (row: ListRow, anchor: HTMLElement) => void;
  readonly onHoverEnd: () => void;
}

export class BookmarkList {
  readonly element: HTMLElement;

  readonly #list: VirtualList<ListRow>;
  readonly #deps: ListDeps;
  #selection: ReadonlySet<string> = new Set();
  #terms: readonly string[] = [];
  #cursor = -1;
  /**
   * A plain click on an already-selected row, held until the mouse comes back up.
   *
   * Collapsing a multi-selection to one row on `mousedown` is what makes a group undraggable: by
   * the time the drag starts there is nothing left to drag but the row under the pointer. Every
   * file manager defers it to `mouseup`, and so does this — a click still collapses, a drag no
   * longer does.
   */
  #pendingCollapse: number | null = null;
  /**
   * The last plain left click, for {@link DOUBLE_CLICK_MS}.
   *
   * Keyed by item id and not by row index, and cleared whenever the data changes: an index means a
   * different bookmark after a search, a folder change or a reload, and two clicks a moment apart
   * on either side of one of those is two people's worth of intent, not a double click.
   */
  #lastClick: { id: string; at: number } | null = null;

  constructor(deps: ListDeps) {
    this.#deps = deps;
    this.#list = new VirtualList<ListRow>({
      rowHeight: ROW_HEIGHT,
      label: msg('listLabel'),
      description: msg('listKeyboardHint'),
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
    this.#lastClick = null;
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

  /** The element currently showing row `index`, or `undefined` if it is outside the window. */
  rowElement(index: number): HTMLElement | undefined {
    return this.#list.rowAt(index);
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
      draggable: 'true',
      'aria-selected': selected ? 'true' : 'false',
    });

    element.addEventListener('mousedown', (event: MouseEvent) => {
      // Deliberately *not* `preventDefault()`: that would stop the listbox taking focus, and a
      // listbox without focus is one where Delete deletes nothing and the arrow keys only scroll.
      // The text selection a shift-click would otherwise paint is handled by `user-select: none`
      // on the row instead.
      const plain = !event.ctrlKey && !event.metaKey && !event.shiftKey;
      if (plain && this.#selection.has(row.id) && this.#selection.size > 1) {
        this.#pendingCollapse = index;
        return;
      }
      this.#pendingCollapse = null;
      this.#deps.onSelect(index, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
    });
    element.addEventListener('mouseup', (event: MouseEvent) => {
      if (this.#pendingCollapse === index) {
        this.#pendingCollapse = null;
        this.#deps.onSelect(index, { toggle: false, range: false });
      }
      // Focus lands here rather than on the `mousedown`, and this is the whole reason Delete and
      // the arrow keys work on a clicked row: selecting one rebuilds the window, which detaches the
      // element the mousedown was dispatched on, and Chromium answers a mousedown whose target left
      // the document by focusing nothing at all. A mouseup has no focus behaviour of its own to
      // fight with, so this is the point where it sticks.
      this.element.focus();

      // A modified click is extending a selection, not opening anything, however fast it repeats.
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
        this.#lastClick = null;
        return;
      }
      const now = Date.now();
      const previous = this.#lastClick;
      this.#lastClick = { id: row.id, at: now };
      if (previous?.id !== row.id || now - previous.at > DOUBLE_CLICK_MS) return;
      // Cleared, so a third click starts a new pair rather than opening the row again.
      this.#lastClick = null;
      this.#deps.onActivate(row);
    });

    element.addEventListener('dragstart', (event: DragEvent) => {
      // The drag won the race against `mouseup`, so the selection it started from is the one to
      // carry — and the collapse it was holding is now the wrong answer.
      this.#pendingCollapse = null;
      if (!startItemDrag(event, this.#deps.onDragStart(index))) event.preventDefault();
    });

    if (row.type === 'folder') {
      dropZone(element, {
        accepts: () => this.#deps.acceptsDrop(row.id),
        onDrop: () => {
          this.#deps.onDropInFolder(row.id);
        },
      });
    }

    if (row.hasThumb) {
      element.addEventListener('mouseenter', () => {
        this.#deps.onHover(row, element);
      });
      element.addEventListener('mouseleave', () => {
        this.#deps.onHoverEnd();
      });
    }

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
      row.hasThumb ? this.#eye(row, element) : h('span', { class: 'vm-row-eye' }),
      row.hasNote
        ? h('span', { class: 'vm-row-note', title: msg('listHasNote') }, '📝')
        : h('span', { class: 'vm-row-note' }),
    );
    return element;
  }

  /**
   * The eye that opens a row's preview.
   *
   * A `span`, not a `button`, and that is ARIA rather than laziness: a row is an `option` in a
   * multi-selectable `listbox`, and a listbox may not contain interactive descendants (the same
   * constraint that put every other per-row action in the toolbar). It carries a `title` for a
   * pointer and is hidden from assistive technology, which reaches the same picture through the
   * detail pane and through the `p` shortcut on the list.
   *
   * Its own `mousedown` stops there rather than reaching the row: opening a preview is not selecting
   * a bookmark, and letting it through would also start the double-click timer.
   */
  #eye(row: ListRow, anchor: HTMLElement): HTMLElement {
    const eye = h(
      'span',
      { class: 'vm-row-eye is-present', title: msg('listHasThumb'), 'aria-hidden': 'true' },
      '👁',
    );
    eye.addEventListener('mousedown', (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
    });
    eye.addEventListener('mouseup', (event: MouseEvent) => {
      event.stopPropagation();
    });
    eye.addEventListener('click', (event: MouseEvent) => {
      event.stopPropagation();
      this.#deps.onPreview(row, anchor);
    });
    return eye;
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
