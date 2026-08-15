/**
 * @vitest-environment jsdom
 *
 * The windowed list (PLAN §9 Phase 6).
 *
 * The property under test is the one the manager's performance rests on: **the number of elements
 * in the DOM is a function of the viewport, not of the vault.** A 5,000-item list that renders
 * 5,000 rows passes every functional assertion in this file and fails the only one that matters.
 *
 * jsdom lays nothing out, so `clientHeight` is 0 for every element and `scrollTop` is a plain
 * property. That is workable — the windowing arithmetic is the thing being tested, not the
 * browser's scrolling — as long as the viewport height is injected rather than measured, which is
 * what the `viewportHeight` option exists for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VirtualList } from '../../../src/ui/virtual-list.js';

const ROW_HEIGHT = 32;
const VIEWPORT = 320; // ten rows

function items(count: number): string[] {
  return Array.from({ length: count }, (_unused, i) => `item-${String(i)}`);
}

/** A list wired the way the manager wires it, with a spy on the row builder. */
function makeList(count: number, overscan?: number) {
  const renderRow = vi.fn((item: string, index: number) => {
    const row = document.createElement('div');
    row.setAttribute('role', 'option');
    row.dataset['index'] = String(index);
    row.textContent = item;
    return row;
  });
  const list = new VirtualList<string>({
    rowHeight: ROW_HEIGHT,
    viewportHeight: () => VIEWPORT,
    renderRow,
    label: 'Bookmarks',
    ...(overscan === undefined ? {} : { overscan }),
  });
  document.body.append(list.element);
  list.setItems(items(count));
  return { list, renderRow };
}

/** The item indices currently in the DOM, in document order. */
function renderedIndices(list: VirtualList<string>): number[] {
  return [...list.element.querySelectorAll<HTMLElement>('[data-index]')].map((row) =>
    Number(row.dataset['index']),
  );
}

/** jsdom does not scroll, so move `scrollTop` and dispatch what a browser would. */
function scrollTo(list: VirtualList<string>, top: number): void {
  list.element.scrollTop = top;
  list.element.dispatchEvent(new Event('scroll'));
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('the window', () => {
  it('renders what fits plus the overscan, not the whole list', () => {
    const { list } = makeList(5_000, 4);
    // Ten rows fit; four above (clamped to the top) and four below.
    expect(renderedIndices(list)).toEqual([...Array(14).keys()]);
    expect(list.range()).toEqual({ start: 0, end: 14 });
  });

  it('keeps the DOM bounded no matter how large the vault is', () => {
    for (const count of [50, 500, 5_000, 50_000]) {
      document.body.replaceChildren();
      const { list } = makeList(count);
      expect(renderedIndices(list).length).toBeLessThanOrEqual(25);
      list.destroy();
    }
  });

  it('builds a row once per index it actually shows', () => {
    const { renderRow } = makeList(5_000, 4);
    expect(renderRow).toHaveBeenCalledTimes(14);
  });

  it('moves the window when the container scrolls', () => {
    const { list } = makeList(5_000, 4);
    scrollTo(list, 100 * ROW_HEIGHT);
    expect(list.range()).toEqual({ start: 96, end: 114 });
    expect(renderedIndices(list)[0]).toBe(96);
  });

  it('reuses the rows the two windows have in common', () => {
    const { list, renderRow } = makeList(5_000, 4);
    renderRow.mockClear();
    // One row further down: one new row at the bottom, one dropped at the top.
    scrollTo(list, ROW_HEIGHT);
    expect(renderRow).toHaveBeenCalledTimes(1);
    expect(renderRow.mock.calls[0]![1]).toBe(14);
  });

  it('does nothing at all when a scroll does not change the window', () => {
    const { list, renderRow } = makeList(5_000, 4);
    renderRow.mockClear();
    scrollTo(list, 4); // an eighth of a row
    expect(renderRow).not.toHaveBeenCalled();
  });

  it('clamps the window at both ends', () => {
    const { list } = makeList(20, 4);
    expect(list.range().start).toBe(0);
    scrollTo(list, 10 * ROW_HEIGHT);
    expect(list.range().end).toBe(20);
    expect(renderedIndices(list).at(-1)).toBe(19);
  });

  it('renders nothing for an empty list, and recovers when items arrive', () => {
    const { list } = makeList(0);
    expect(renderedIndices(list)).toEqual([]);
    list.setItems(items(3));
    expect(renderedIndices(list)).toEqual([0, 1, 2]);
  });

  it('renders at least one row when the container has not been laid out', () => {
    // A real container reports `clientHeight: 0` until it is in a laid-out document. Rendering
    // nothing then would leave a permanently blank list if no scroll ever followed.
    const list = new VirtualList<string>({
      rowHeight: ROW_HEIGHT,
      renderRow: (item) => {
        const row = document.createElement('div');
        row.textContent = item;
        return row;
      },
    });
    document.body.append(list.element);
    list.setItems(items(10));
    expect(list.range().end).toBeGreaterThan(0);
  });
});

describe('positioning', () => {
  it('gives the canvas the height of the whole list, so the scrollbar is honest', () => {
    const { list } = makeList(5_000);
    const canvas = list.element.querySelector<HTMLElement>('.vm-vlist-canvas');
    expect(canvas?.style.height).toBe(`${String(5_000 * ROW_HEIGHT)}px`);
  });

  it('places each row at its own offset', () => {
    const { list } = makeList(100, 2);
    const row = list.rowAt(3);
    expect(row?.style.top).toBe(`${String(3 * ROW_HEIGHT)}px`);
    expect(row?.style.height).toBe(`${String(ROW_HEIGHT)}px`);
    expect(row?.style.position).toBe('absolute');
  });
});

describe('accessibility', () => {
  it('is a multi-selectable listbox with the name it was given', () => {
    const { list } = makeList(10);
    expect(list.element.getAttribute('role')).toBe('listbox');
    expect(list.element.getAttribute('aria-multiselectable')).toBe('true');
    expect(list.element.getAttribute('aria-label')).toBe('Bookmarks');
    expect(list.element.tabIndex).toBe(0);
  });

  it('tells assistive technology the real size, not the window size', () => {
    // The whole point: "3 of 5,000", never "3 of 24".
    const { list } = makeList(5_000);
    const row = list.rowAt(2);
    expect(row?.getAttribute('aria-setsize')).toBe('5000');
    expect(row?.getAttribute('aria-posinset')).toBe('3');
  });

  it('has no name attribute at all when none was given', () => {
    const list = new VirtualList<string>({ rowHeight: ROW_HEIGHT, renderRow: () => document.createElement('div') });
    expect(list.element.hasAttribute('aria-label')).toBe(false);
  });
});

describe('setItems', () => {
  it('rebuilds every visible row rather than reusing one for a different item', () => {
    // Index 0 means a different bookmark after a filter; an element reused across the change
    // would show the old title under the new selection.
    const { list, renderRow } = makeList(100);
    renderRow.mockClear();
    list.setItems(['fresh', 'rows']);
    expect(renderedIndices(list)).toEqual([0, 1]);
    expect(list.element.textContent).toBe('freshrows');
    expect(renderRow).toHaveBeenCalledTimes(2);
  });

  it('returns to the top when the new list is shorter than the current scroll position', () => {
    const { list } = makeList(5_000);
    scrollTo(list, 4_000 * ROW_HEIGHT);
    list.setItems(items(3));
    expect(list.element.scrollTop).toBe(0);
    expect(renderedIndices(list)).toEqual([0, 1, 2]);
  });
});

describe('refresh', () => {
  it('re-runs renderRow for the window without changing it', () => {
    const { list, renderRow } = makeList(5_000, 4);
    const before = list.range();
    renderRow.mockClear();
    list.refresh();
    expect(list.range()).toEqual(before);
    expect(renderRow).toHaveBeenCalledTimes(14);
  });
});

describe('scrollToIndex', () => {
  it('scrolls down only as far as it has to', () => {
    const { list } = makeList(5_000);
    list.scrollToIndex(20);
    // Row 20 ends at 21 * 32 = 672; the viewport is 320 tall, so the top lands at 352.
    expect(list.element.scrollTop).toBe(21 * ROW_HEIGHT - VIEWPORT);
    expect(list.rowAt(20)).toBeDefined();
  });

  it('scrolls up to put the row at the top of the viewport', () => {
    const { list } = makeList(5_000);
    scrollTo(list, 100 * ROW_HEIGHT);
    list.scrollToIndex(50);
    expect(list.element.scrollTop).toBe(50 * ROW_HEIGHT);
  });

  it('does not move for a row that is already in view', () => {
    const { list } = makeList(5_000);
    scrollTo(list, 100 * ROW_HEIGHT);
    list.scrollToIndex(105);
    expect(list.element.scrollTop).toBe(100 * ROW_HEIGHT);
  });

  it('ignores an index outside the list', () => {
    const { list } = makeList(10);
    list.scrollToIndex(-1);
    list.scrollToIndex(10);
    expect(list.element.scrollTop).toBe(0);
  });
});

describe('destroy', () => {
  it('drops every row and stops answering scroll events', () => {
    const { list, renderRow } = makeList(5_000);
    list.destroy();
    expect(renderedIndices(list)).toEqual([]);
    renderRow.mockClear();
    scrollTo(list, 100 * ROW_HEIGHT);
    expect(renderRow).not.toHaveBeenCalled();
  });
});

describe('the 5,000-item budget', () => {
  it('renders the first screen well inside 400 ms', () => {
    // PLAN §9 Phase 6's definition of done. jsdom does no layout, so this measures the part we
    // control — building and positioning the window — and the assertion that makes the number
    // meaningful is `renderRow` having been called two dozen times rather than five thousand.
    const renderRow = vi.fn((item: string) => {
      const row = document.createElement('div');
      row.append(document.createElement('img'), document.createTextNode(item));
      return row;
    });
    const list = new VirtualList<string>({
      rowHeight: ROW_HEIGHT,
      viewportHeight: () => VIEWPORT,
      renderRow,
    });
    document.body.append(list.element);

    const started = performance.now();
    list.setItems(items(5_000));
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(400);
    expect(renderRow.mock.calls.length).toBeLessThan(30);
  });
});
