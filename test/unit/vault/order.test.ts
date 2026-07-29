import { describe, expect, it } from 'vitest';

import { InvalidMutationError } from '../../../src/vault/errors.js';
import {
  FIRST_ORDER,
  compareOrder,
  isOrderKey,
  orderBetween,
  ordersBetween,
} from '../../../src/vault/order.js';

/** A tiny xorshift, so "1,000 random reorders" is a fixed sequence that bisects cleanly. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

describe('orderBetween', () => {
  it('produces the documented first key', () => {
    expect(orderBetween(null, null)).toBe(FIRST_ORDER);
    expect(FIRST_ORDER).toBe('a0');
  });

  it('matches the worked example in ARCHITECTURE §3.4', () => {
    // a0 < a0V < a1 — the ordering the spec states, produced by the code rather than asserted at it.
    const first = orderBetween(null, null);
    const second = orderBetween(first, null);
    const middle = orderBetween(first, second);
    expect([first, middle, second]).toEqual(['a0', 'a0V', 'a1']);
    expect([first, middle, second].toSorted(compareOrder)).toEqual([first, middle, second]);
  });

  it('appends without lengthening the key', () => {
    let key = orderBetween(null, null);
    const keys = [key];
    for (let i = 0; i < 1_000; i++) {
      key = orderBetween(key, null);
      keys.push(key);
    }
    // The integer part is what keeps appends cheap: a thousand of them must not produce a
    // thousand-character key.
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(4);
    expect(keys.toSorted(compareOrder)).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('prepends without lengthening the key', () => {
    let key = orderBetween(null, null);
    const keys = [key];
    for (let i = 0; i < 1_000; i++) {
      key = orderBetween(null, key);
      keys.push(key);
    }
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(4);
    // Generated newest-first, so reversing them gives the display order.
    const ascending = keys.toReversed();
    expect(ascending.toSorted(compareOrder)).toEqual(ascending);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('always lands strictly between its neighbours', () => {
    const random = seededRandom(0x5eed);
    let keys = ordersBetween(null, null, 8);
    for (let i = 0; i < 500; i++) {
      const at = Math.floor(random() * (keys.length + 1));
      const before = at === 0 ? null : (keys[at - 1] ?? null);
      const after = at >= keys.length ? null : (keys[at] ?? null);
      const inserted = orderBetween(before, after);
      if (before !== null) expect(compareOrder(before, inserted)).toBe(-1);
      if (after !== null) expect(compareOrder(inserted, after)).toBe(-1);
      keys = [...keys.slice(0, at), inserted, ...keys.slice(at)];
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.toSorted(compareOrder)).toEqual(keys);
  });

  it('survives 1,000 random reorders without a collision or a renumber', () => {
    // The claim Phase 3 makes: a reorder touches exactly one item's key, and no sequence of them
    // forces the folder to be renumbered. `orderBetween` never throwing is what "never requires a
    // renumber" means operationally.
    const random = seededRandom(0xc0ffee);
    const list = ordersBetween(null, null, 40).map((order, index) => ({ id: index, order }));

    for (let move = 0; move < 1_000; move++) {
      const from = Math.floor(random() * list.length);
      const [item] = list.splice(from, 1);
      expect(item).toBeDefined();
      const to = Math.floor(random() * (list.length + 1));
      const before = to === 0 ? null : (list[to - 1]?.order ?? null);
      const after = to >= list.length ? null : (list[to]?.order ?? null);
      list.splice(to, 0, { id: item!.id, order: orderBetween(before, after) });
    }

    const orders = list.map((entry) => entry.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders.toSorted(compareOrder)).toEqual(orders);
    // Keys grow, but logarithmically: a pathological run would show up here as a length blow-up.
    expect(Math.max(...orders.map((order) => order.length))).toBeLessThan(20);
  });

  it('rejects neighbours that are not in ascending order', () => {
    expect(() => orderBetween('a1', 'a0')).toThrow(InvalidMutationError);
    expect(() => orderBetween('a1', 'a1')).toThrow(InvalidMutationError);
  });

  it('walks back across zero and up again without breaking the order', () => {
    // Crossing between the below-zero (uppercase head) and above-zero (lowercase head) integer
    // ranges is where the head character has to change the *length* of the integer part; getting
    // it wrong produces keys that compare in the wrong direction.
    let key = FIRST_ORDER;
    const descending = [key];
    for (let i = 0; i < 200; i++) {
      key = orderBetween(null, key);
      descending.push(key);
    }
    const ascending = descending.toReversed();
    expect(ascending.toSorted(compareOrder)).toEqual(ascending);

    let up = ascending[0]!;
    const back = [up];
    for (let i = 0; i < 400; i++) {
      up = orderBetween(up, null);
      back.push(up);
    }
    expect(back.toSorted(compareOrder)).toEqual(back);
    expect(new Set(back).size).toBe(back.length);
  });

  it('rejects malformed keys', () => {
    for (const bad of ['', '0', 'a', '!', 'a0' + '0', 'zz', 'a0$', 'a0é']) {
      expect(isOrderKey(bad), bad).toBe(false);
      expect(() => orderBetween(bad, null), bad).toThrow(InvalidMutationError);
    }
    expect(isOrderKey('a0')).toBe(true);
    expect(isOrderKey('a0V')).toBe(true);
  });

  it('rejects the reserved smallest integer part', () => {
    expect(isOrderKey(`A${'0'.repeat(26)}`)).toBe(false);
  });

  it('crosses the zero boundary in both directions', () => {
    // 'a0' is the first key above zero; walking below it must produce keys that still sort first.
    let key = FIRST_ORDER;
    for (let i = 0; i < 100; i++) key = orderBetween(null, key);
    expect(compareOrder(key, FIRST_ORDER)).toBe(-1);
    // Below zero the integer part is marked with an uppercase head ('Z' for one digit, 'Y' for
    // two, …), which is what keeps it sorting before every above-zero key as a plain string.
    expect(key.charAt(0) >= 'A' && key.charAt(0) <= 'Z').toBe(true);
    expect(isOrderKey(key)).toBe(true);
  });
});

describe('ordersBetween', () => {
  it('returns nothing for a count of zero', () => {
    expect(ordersBetween(null, null, 0)).toEqual([]);
  });

  it('returns ascending, distinct keys inside the gap', () => {
    const before = orderBetween(null, null);
    const after = orderBetween(before, null);
    const keys = ordersBetween(before, after, 25);
    expect(keys).toHaveLength(25);
    expect(new Set(keys).size).toBe(25);
    expect(keys.toSorted(compareOrder)).toEqual(keys);
    expect(compareOrder(before, keys[0]!)).toBe(-1);
    expect(compareOrder(keys.at(-1)!, after)).toBe(-1);
  });

  it('bisects rather than chaining, so keys stay short', () => {
    const before = orderBetween(null, null);
    const after = orderBetween(before, null);
    const keys = ordersBetween(before, after, 64);
    // Chaining 64 keys into one gap would push the last one past 30 characters.
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThan(12);
  });

  it('lays out a whole folder from nothing', () => {
    const keys = ordersBetween(null, null, 500);
    expect(keys).toHaveLength(500);
    expect(keys.toSorted(compareOrder)).toEqual(keys);
  });

  it('prepends a run before an existing first item', () => {
    const first = orderBetween(null, null);
    const keys = ordersBetween(null, first, 30);
    expect(keys).toHaveLength(30);
    expect(keys.toSorted(compareOrder)).toEqual(keys);
    expect(compareOrder(keys.at(-1)!, first)).toBe(-1);
    expect(new Set(keys).size).toBe(30);
  });

  it('appends a run after an existing last item', () => {
    const last = orderBetween(null, null);
    const keys = ordersBetween(last, null, 30);
    expect(keys.toSorted(compareOrder)).toEqual(keys);
    expect(compareOrder(last, keys[0]!)).toBe(-1);
  });

  it('rejects a negative or fractional count', () => {
    expect(() => ordersBetween(null, null, -1)).toThrow(InvalidMutationError);
    expect(() => ordersBetween(null, null, 1.5)).toThrow(InvalidMutationError);
  });
});

describe('compareOrder', () => {
  it('is a total order agreeing with plain string comparison', () => {
    expect(compareOrder('a0', 'a1')).toBe(-1);
    expect(compareOrder('a1', 'a0')).toBe(1);
    expect(compareOrder('a0', 'a0')).toBe(0);
  });
});
