/**
 * A windowed list: render the rows that are on screen, not the ones that are not (D3).
 *
 * The manager has to stay usable on a vault with thousands of bookmarks, and the honest reason a
 * list gets slow is not that layout is expensive — it is that five thousand rows are five thousand
 * subtrees, five thousand favicon elements, and a style recalculation across all of them every time
 * one row's class changes. This keeps the DOM at "what fits, plus a little", which makes the cost of
 * a render a function of the window rather than of the vault.
 *
 * Deliberately small, and deliberately not a framework:
 *
 * - **Fixed row height.** Measuring rows would mean rendering them, which is the thing being
 *   avoided. Every row in the manager is one line, so the height is a constant the caller passes.
 * - **The scroll container is ours; the rows are the caller's.** `renderRow` returns an element and
 *   this file positions it. Nothing here knows what a bookmark is.
 * - **Accessible by construction.** A windowed list is a lie to assistive technology unless it says
 *   how big it really is, so every row carries `aria-setsize`/`aria-posinset` and the container is
 *   a `listbox`. Screen readers announce "3 of 5,000", not "3 of 24".
 *
 * The viewport height is read from the element, with an override for tests: jsdom reports
 * `clientHeight` as 0 for everything, which would otherwise make every windowing test assert
 * against an empty window.
 */

export interface VirtualListOptions<T> {
  /** Row height in CSS pixels. Must match what the stylesheet gives a row. */
  readonly rowHeight: number;
  /** Build the element for one item. Called only for rows inside the window. */
  readonly renderRow: (item: T, index: number) => HTMLElement;
  /**
   * Rows rendered above and below the visible window, so a scroll of one row does not expose a
   * gap before the next frame runs.
   */
  readonly overscan?: number;
  /** Accessible name for the listbox. */
  readonly label?: string;
  /**
   * What to do once you are in it, for somebody who cannot see the toolbar the actions live on.
   *
   * A sighted user discovers `e` and `p` from the toolbar buttons beside the list; a screen-reader
   * user arriving at a listbox is told it is a listbox and nothing else, and every action on this
   * one is a bare keystroke because a listbox may not contain interactive descendants.
   */
  readonly description?: string;
  /** Test seam: jsdom reports every `clientHeight` as 0. */
  readonly viewportHeight?: () => number;
}

export interface VisibleRange {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

const DEFAULT_OVERSCAN = 6;

export class VirtualList<T> {
  /** The scrolling container. Put this in the document; everything else is internal. */
  readonly element: HTMLElement;

  readonly #canvas: HTMLElement;
  readonly #options: VirtualListOptions<T>;
  readonly #onScroll: () => void;
  readonly #resize: ResizeObserver | null;

  #items: readonly T[] = [];
  #range: VisibleRange = { start: 0, end: 0 };
  /** Rendered rows by item index, so a scroll of one row reuses the other twenty-three. */
  #rendered = new Map<number, HTMLElement>();

  constructor(options: VirtualListOptions<T>) {
    this.#options = options;

    this.#canvas = document.createElement('div');
    this.#canvas.className = 'vm-vlist-canvas';

    this.element = document.createElement('div');
    this.element.className = 'vm-vlist';
    this.element.setAttribute('role', 'listbox');
    this.element.setAttribute('aria-multiselectable', 'true');
    this.element.tabIndex = 0;
    if (options.label !== undefined) this.element.setAttribute('aria-label', options.label);
    /*
     * `aria-description` rather than a hidden element and `aria-describedby`, because a listbox may
     * contain nothing but options — the constraint that put every per-row action in the toolbar —
     * and the alternative is a paragraph somewhere else in the document whose only purpose is to be
     * pointed at. Chromium has implemented it since well before this extension's floor of 116, and
     * this ships to Chrome only.
     */
    if (options.description !== undefined)
      this.element.setAttribute('aria-description', options.description);
    this.element.append(this.#canvas);

    this.#onScroll = () => {
      this.#renderWindow();
    };
    this.element.addEventListener('scroll', this.#onScroll, { passive: true });

    /*
     * How tall the window is is measured, and a measurement taken at the wrong moment is wrong
     * until something moves. Two ways that happened, both reported:
     *
     * - **The list was rendered while it was off screen.** The manager's four screens are mutually
     *   exclusive, so the three-column layout is `hidden` — `display: none` — while import/export is
     *   up. An import repaints the list from behind that, `clientHeight` answers 0, and the floor
     *   below renders a single row's worth. *Back to bookmarks* changes no scroll position and fires
     *   no event, so the list sat there showing seven rows of thirty-one with a scrollbar that knew
     *   better, until a scroll woke it.
     * - **The window was resized.** Same shape: more room, no event, no rows to fill it.
     *
     * Observing the container answers both, and answers them wherever else the same thing happens —
     * a splitter drag, a zoom, a screen that appears — rather than making every caller remember.
     * `#renderWindow` returns immediately when the range is unchanged, so the callback is cheap.
     *
     * Absent in jsdom, hence the guard: the unit suite passes `viewportHeight` instead, and there
     * is nothing to observe in a document that lays nothing out.
     */
    this.#resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.#renderWindow();
          });
    this.#resize?.observe(this.element);
  }

  get length(): number {
    return this.#items.length;
  }

  /** The window currently in the DOM. Exposed for tests and for keyboard scrolling. */
  range(): VisibleRange {
    return this.#range;
  }

  /**
   * Replace the data.
   *
   * Every rendered row is dropped: index *i* means a different item now, and reusing an element
   * whose contents belong to something else is how a list ends up showing the previous filter's
   * bookmarks under the current filter's titles.
   */
  setItems(items: readonly T[]): void {
    this.#items = items;
    this.#canvas.style.height = `${String(items.length * this.#options.rowHeight)}px`;
    if (this.element.scrollTop > this.#canvas.clientHeight) this.element.scrollTop = 0;
    this.#discardRows();
    this.#renderWindow();
  }

  /** Re-run `renderRow` for the visible window. Call after something a row displays changes. */
  refresh(): void {
    this.#discardRows();
    this.#renderWindow();
  }

  /** Scroll `index` into view, moving as little as possible. Out-of-range indices are ignored. */
  scrollToIndex(index: number): void {
    if (index < 0 || index >= this.#items.length) return;
    const { rowHeight } = this.#options;
    const top = index * rowHeight;
    const viewport = this.#viewportHeight();
    if (top < this.element.scrollTop) this.element.scrollTop = top;
    else if (top + rowHeight > this.element.scrollTop + viewport) {
      this.element.scrollTop = top + rowHeight - viewport;
    }
    // Scrolling programmatically does not always deliver a `scroll` event before the caller wants
    // to touch the row (focusing it, for one), so the window is brought up to date now.
    this.#renderWindow();
  }

  /** The element currently rendering `index`, if it is inside the window. */
  rowAt(index: number): HTMLElement | undefined {
    return this.#rendered.get(index);
  }

  destroy(): void {
    this.element.removeEventListener('scroll', this.#onScroll);
    this.#resize?.disconnect();
    this.#discardRows();
  }

  /* ---------------------------------------------------------------- internals */

  #viewportHeight(): number {
    const measured = this.#options.viewportHeight?.() ?? this.element.clientHeight;
    // A container that has not been laid out yet reports 0. Rendering nothing in that case leaves
    // a permanently empty list if no scroll ever follows, so one row's worth is the floor.
    return measured > 0 ? measured : this.#options.rowHeight;
  }

  #discardRows(): void {
    for (const row of this.#rendered.values()) row.remove();
    this.#rendered.clear();
    this.#range = { start: 0, end: 0 };
  }

  #renderWindow(): void {
    const { rowHeight, overscan = DEFAULT_OVERSCAN } = this.#options;
    const total = this.#items.length;
    const visible = Math.ceil(this.#viewportHeight() / rowHeight);
    const first = Math.floor(this.element.scrollTop / rowHeight);
    const start = Math.max(0, first - overscan);
    const end = Math.min(total, first + visible + overscan);
    if (start === this.#range.start && end === this.#range.end && this.#rendered.size > 0) return;

    for (const [index, row] of this.#rendered) {
      if (index < start || index >= end) {
        row.remove();
        this.#rendered.delete(index);
      }
    }

    for (let index = start; index < end; index++) {
      if (this.#rendered.has(index)) continue;
      const item = this.#items[index];
      if (item === undefined) continue;
      const row = this.#options.renderRow(item, index);
      row.style.position = 'absolute';
      row.style.top = `${String(index * rowHeight)}px`;
      row.style.height = `${String(rowHeight)}px`;
      // The window is a rendering detail; the list's real size is what a screen reader must hear.
      row.setAttribute('aria-setsize', String(total));
      row.setAttribute('aria-posinset', String(index + 1));
      this.#rendered.set(index, row);
      this.#canvas.append(row);
    }

    this.#range = { start, end };
  }
}
