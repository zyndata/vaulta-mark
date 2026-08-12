/**
 * The quota line's number.
 *
 * It reads like a formatting detail and is not: this function is the whole of what the sync section
 * tells someone about how much room they have, and it shipped rendering fifteen gigabytes as
 * `15728640 kB` — eight digits, no separators, one unit for every backend. The tests below are the
 * two facts that matter (the unit scales, and a Drive total reads as Google writes it) plus the
 * boundaries where a unit changes, which is where an off-by-one in the chooser would hide.
 *
 * `Intl` is asked for `en-US` explicitly. The function deliberately passes `undefined` so the browser
 * picks, and a suite that ran under a locale using `,` as the decimal separator would otherwise fail
 * on the string rather than on the behaviour.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { storageSize } from '../../../src/manager/sync.js';

const RealNumberFormat = Intl.NumberFormat;

beforeAll(() => {
  vi.spyOn(Intl, 'NumberFormat').mockImplementation(
    (_locales: unknown, options: Intl.NumberFormatOptions | undefined) =>
      new RealNumberFormat('en-US', options),
  );
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('storageSize', () => {
  it('reads a Drive quota the way Google writes it', () => {
    // 15 GiB is what a "15 GB" Drive actually reports, and the two have to agree or the extension
    // looks like it is measuring something else.
    expect(storageSize(16_106_127_360)).toBe('15 GB');
  });

  it('keeps one decimal on a partly used Drive', () => {
    // The figure from the report that started this: 6,010,430 kB.
    expect(storageSize(6_154_680_320)).toBe('5.7 GB');
  });

  it('stays in kilobytes for a Chrome sync quota', () => {
    expect(storageSize(102_400)).toBe('100 kB');
    expect(storageSize(71_680)).toBe('70 kB');
  });

  it.each([
    ['just under a megabyte', 1024 * 1024 - 1, '1,024 kB'],
    ['exactly a megabyte', 1024 * 1024, '1 MB'],
    ['just under a gigabyte', 1024 ** 3 - 1, '1,024 MB'],
    ['exactly a gigabyte', 1024 ** 3, '1 GB'],
  ])('switches unit at %s', (_label, bytes, expected) => {
    expect(storageSize(bytes)).toBe(expected);
  });

  it('drops the decimal once the number is large enough not to need it', () => {
    // 9.5 MB keeps its digit; 12 MB does not, because "12.3 MB" is precision nobody acts on.
    expect(storageSize(Math.round(9.5 * 1024 * 1024))).toBe('9.5 MB');
    expect(storageSize(Math.round(12.3 * 1024 * 1024))).toBe('12 MB');
  });

  it('does not offer a fraction of a kilobyte', () => {
    // An empty vault is "0 kB", not "0.1 kB": a decimal here would be precision about nothing, and
    // there is no smaller unit to fall back to on purpose — bytes are not a quota.
    expect(storageSize(0)).toBe('0 kB');
    expect(storageSize(512)).toBe('1 kB');
  });
});
