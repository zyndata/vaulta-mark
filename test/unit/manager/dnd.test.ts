/**
 * `reorderZone`'s bands: which part of a row means "into this" and which means "between these two".
 *
 * Worth a unit test rather than leaving it to the E2E, because the arithmetic has three cases that
 * a pointer test would have to hit by pixel — and because the interesting one is the *degenerate*
 * case: a row that cannot be dropped into must still answer over every pixel of itself, or a drag
 * mysteriously refuses over the middle half of its target.
 *
 * `src/manager/**` is excluded from the coverage gates (import-time DOM glue, covered by E2E), and
 * this file is here anyway: `dnd.ts` is the exception in that directory — pure geometry with no
 * worker, no message and no import-time side effect.
 */

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { DRAG_TYPE, reorderZone, type DropPlacement } from '../../../src/manager/dnd.js';

const ROW_TOP = 100;
const ROW_HEIGHT = 44;

/**
 * A row of known geometry with a zone on it, plus a way to drag over it at a given fraction.
 *
 * jsdom lays nothing out — every `getBoundingClientRect` is zeroes — so the box is stubbed. That is
 * the whole of what the real browser contributes here; the decision under test is arithmetic.
 */
function row(placements: readonly DropPlacement[]): {
  element: HTMLElement;
  over: (fraction: number) => void;
  drop: (fraction: number) => DropPlacement | null;
  classes: () => string[];
} {
  const element = document.createElement('div');
  document.body.append(element);
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    top: ROW_TOP,
    height: ROW_HEIGHT,
    bottom: ROW_TOP + ROW_HEIGHT,
    left: 0,
    right: 200,
    width: 200,
    x: 0,
    y: ROW_TOP,
    toJSON: () => ({}),
  });

  let dropped: DropPlacement | null = null;
  reorderZone(element, {
    placements: () => placements,
    onDrop: (placement) => {
      dropped = placement;
    },
  });

  const event = (type: string, fraction: number): DragEvent => {
    const dragEvent = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(dragEvent, 'clientY', {
      value: ROW_TOP + fraction * ROW_HEIGHT,
    });
    Object.defineProperty(dragEvent, 'dataTransfer', {
      value: { types: [DRAG_TYPE], dropEffect: 'none' },
    });
    return dragEvent;
  };

  return {
    element,
    over: (fraction) => {
      element.dispatchEvent(event('dragover', fraction));
    },
    drop: (fraction) => {
      dropped = null;
      element.dispatchEvent(event('drop', fraction));
      return dropped;
    },
    classes: () => [...element.classList],
  };
}

describe('a row that can be dropped into', () => {
  const all: readonly DropPlacement[] = ['before', 'after', 'into'];

  it('reads as before, into, after down its height', () => {
    const target = row(all);
    expect(target.drop(0.1)).toBe('before');
    expect(target.drop(0.5)).toBe('into');
    expect(target.drop(0.9)).toBe('after');
  });

  it('puts the boundaries at the quarters', () => {
    const target = row(all);
    // Exactly on a boundary belongs to the middle: the bands are `< 0.25` and `> 0.75`, so the
    // larger, more forgiving target wins the tie rather than a one-pixel sliver.
    expect(target.drop(0.24)).toBe('before');
    expect(target.drop(0.25)).toBe('into');
    expect(target.drop(0.75)).toBe('into');
    expect(target.drop(0.76)).toBe('after');
  });

  it('shows a different mark for a position than for a container', () => {
    const target = row(all);
    target.over(0.1);
    expect(target.classes()).toContain('is-drop-before');
    // One mark at a time: a row showing both an insertion line and a container outline is telling
    // the user two different things about the same drop.
    expect(target.classes()).not.toContain('is-drop-target');

    target.over(0.5);
    expect(target.classes()).toEqual(['is-drop-target']);

    target.over(0.9);
    expect(target.classes()).toEqual(['is-drop-after']);
  });
});

describe('a row that cannot be dropped into', () => {
  it('splits in half rather than leaving a dead band down the middle', () => {
    // A bookmark in a reorderable listing, or a folder the drag may not enter. If it kept the
    // quarter bands, half of every row would refuse the drag for a reason nothing on screen shows.
    const target = row(['before', 'after']);
    expect(target.drop(0.1)).toBe('before');
    expect(target.drop(0.49)).toBe('before');
    expect(target.drop(0.51)).toBe('after');
    expect(target.drop(0.9)).toBe('after');
  });

  it('answers `into` over its whole height when a position is not on offer', () => {
    // Every derived sort order, and every cross-folder view. The row behaves exactly as it did
    // before reordering existed.
    const target = row(['into']);
    expect(target.drop(0.05)).toBe('into');
    expect(target.drop(0.95)).toBe('into');
  });

  it('accepts nothing, and marks nothing, when it can take no placement at all', () => {
    const target = row([]);
    expect(target.drop(0.5)).toBeNull();
    target.over(0.5);
    expect(target.classes()).toEqual([]);
  });
});

describe('the drag payload', () => {
  it('ignores a drag that is not one of ours', () => {
    const element = document.createElement('div');
    let dropped = false;
    reorderZone(element, {
      placements: () => ['before', 'after', 'into'],
      onDrop: () => {
        dropped = true;
      },
    });

    // A file dragged in from the desktop, or a selection from another page. The private MIME type
    // is the whole test — nothing else about the event distinguishes them.
    const foreign = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(foreign, 'dataTransfer', { value: { types: ['Files'] } });
    element.dispatchEvent(foreign);

    expect(dropped).toBe(false);
    expect(foreign.defaultPrevented).toBe(false);
  });
});
