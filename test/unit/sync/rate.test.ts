/**
 * The write-rate governor (ARCHITECTURE §5.2).
 *
 * Chrome answers the 121st write in a minute with a rejected promise, and it lands mid-push —
 * between the buckets and the header — which is the torn state §5.4.1 exists to prevent. So the
 * assertion that matters here is not "it counts writes" but **"a burst can never get past our own
 * ceiling"**, checked against a simulated flood rather than against a handful of calls.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { RateLimited } from '../../../src/sync/provider.js';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  WRITES_PER_HOUR,
  WRITES_PER_MINUTE,
  WriteBudget,
  backoffMs,
  type BudgetStore,
} from '../../../src/sync/rate.js';
import { SYNC_LIMITS } from '../../mocks/chrome.js';

let clock = 0;
let stored: number[] = [];

const store: BudgetStore = {
  read: () => Promise.resolve(stored),
  write: (stamps) => {
    stored = [...stamps];
    return Promise.resolve();
  },
};

function budget(): WriteBudget {
  return new WriteBudget({ now: () => clock, store });
}

beforeEach(() => {
  clock = 1_750_000_000_000;
  stored = [];
});

describe('the budget', () => {
  it('sits below every limit Chrome actually enforces', () => {
    expect(WRITES_PER_MINUTE).toBeLessThan(SYNC_LIMITS.MAX_WRITE_OPERATIONS_PER_MINUTE);
    expect(WRITES_PER_HOUR).toBeLessThan(SYNC_LIMITS.MAX_WRITE_OPERATIONS_PER_HOUR);
  });

  it('allows writes up to the per-minute ceiling and refuses the next one', async () => {
    const governor = budget();
    for (let write = 0; write < WRITES_PER_MINUTE; write++) await governor.spend(1);
    await expect(governor.spend(1)).rejects.toBeInstanceOf(RateLimited);
  });

  it('says exactly how long to wait, and is right', async () => {
    const governor = budget();
    for (let write = 0; write < WRITES_PER_MINUTE; write++) await governor.spend(1);

    const wait = await governor.retryAfter(1);
    expect(wait).toBe(60_000);

    clock += wait - 1;
    await expect(governor.spend(1)).rejects.toBeInstanceOf(RateLimited);
    clock += 1;
    await expect(governor.spend(1)).resolves.toBeUndefined();
  });

  it('reserves a whole push or none of it', async () => {
    const governor = budget();
    for (let write = 0; write < WRITES_PER_MINUTE - 2; write++) await governor.spend(1);

    // Three writes is a bucket set, a removal and a header. Two slots are free, so none are taken.
    await expect(governor.spend(3)).rejects.toBeInstanceOf(RateLimited);
    expect((await governor.spent()).minute).toBe(WRITES_PER_MINUTE - 2);
    await expect(governor.spend(2)).resolves.toBeUndefined();
  });

  it('refuses a reservation larger than the window itself rather than waiting forever', async () => {
    await expect(budget().retryAfter(WRITES_PER_MINUTE + 1)).resolves.toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('enforces the hourly ceiling as well as the per-minute one', async () => {
    const governor = budget();
    // Sixty minutes at the per-minute ceiling would be 6,000 writes; the hourly budget stops it at
    // 1,400. Fourteen bursts of a hundred, a minute apart, is exactly the hourly allowance.
    for (let minute = 0; minute < WRITES_PER_HOUR / WRITES_PER_MINUTE; minute++) {
      for (let write = 0; write < WRITES_PER_MINUTE; write++) await governor.spend(1);
      clock += 60_000;
    }
    expect((await governor.spent()).hour).toBe(WRITES_PER_HOUR);
    await expect(governor.spend(1)).rejects.toBeInstanceOf(RateLimited);
  });

  it('never exceeds either ceiling under a burst of 500 rapid edits', async () => {
    const governor = budget();
    let allowed = 0;
    for (let edit = 0; edit < 500; edit++) {
      try {
        await governor.spend(1);
        allowed += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(RateLimited);
      }
      // 200 ms apart: a plausible flood, and far faster than the budget refills.
      clock += 200;
    }
    const spent = await governor.spent();
    expect(allowed).toBeLessThanOrEqual(WRITES_PER_HOUR);
    expect(spent.minute).toBeLessThanOrEqual(WRITES_PER_MINUTE);
    expect(spent.hour).toBeLessThanOrEqual(WRITES_PER_HOUR);
  });

  it('forgets writes older than an hour rather than growing the log forever', async () => {
    const governor = budget();
    await governor.spend(1);
    clock += 3_600_001;
    expect((await governor.spent()).hour).toBe(0);
  });

  it('spends nothing for a reservation of zero', async () => {
    const governor = budget();
    await governor.spend(0);
    expect(stored).toEqual([]);
  });

  it('survives a spend log written as something other than numbers', async () => {
    stored = [1, 'nonsense' as unknown as number, 2];
    await expect(budget().spent()).resolves.toBeDefined();
  });
});

describe('backoff', () => {
  it('doubles, and stops doubling at the ceiling', () => {
    const highest = (attempt: number): number => backoffMs(attempt, () => 1);
    expect(highest(0)).toBe(BACKOFF_BASE_MS);
    expect(highest(1)).toBe(BACKOFF_BASE_MS * 2);
    expect(highest(20)).toBe(BACKOFF_MAX_MS);
  });

  it('jitters, so devices that failed together do not retry together', () => {
    // Full jitter: anywhere in the top half of the window, never zero and never past the ceiling.
    expect(backoffMs(3, () => 0)).toBe((BACKOFF_BASE_MS * 8) / 2);
    expect(backoffMs(3, () => 1)).toBe(BACKOFF_BASE_MS * 8);
    const spread = new Set([0.1, 0.4, 0.9].map((roll) => backoffMs(3, () => roll)));
    expect(spread.size).toBe(3);
  });

  it('treats a negative attempt as the first one', () => {
    expect(backoffMs(-5, () => 1)).toBe(BACKOFF_BASE_MS);
  });
});
