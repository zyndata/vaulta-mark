/**
 * The write-rate governor for `chrome.storage.sync` (ARCHITECTURE §5.2).
 *
 * Chrome allows 120 writes a minute and 1,800 an hour, and answers the 121st with a rejected
 * promise. That is not a limit to discover in production: the failure lands mid-push, between the
 * buckets and the header, which is precisely the state §5.4.1 is written to avoid. So VaultaMark
 * spends against **its own, lower** budget — 100 a minute, 1,400 an hour — and refuses a write
 * before Chrome does, with a {@link RateLimited} that says exactly how long to wait.
 *
 * The budget is kept in `chrome.storage.session` rather than in a module variable, and the reason is
 * MV3: the service worker is torn down every thirty seconds, and an in-memory counter would reset
 * with it. Two hundred edits spread over four worker lifetimes would each see an empty budget and
 * happily spend it, which is how an extension gets throttled by a limiter it wrote itself. The
 * session area is memory-backed, cleared on browser exit — the same lifetime Chrome's own counters
 * have — and holds nothing but timestamps, so INV-6 is not in play.
 */

import { RateLimited } from './provider.js';

/** Our ceiling, under Chrome's 120. The gap absorbs a write we did not account for. */
export const WRITES_PER_MINUTE = 100;

/** Our ceiling, under Chrome's 1,800. */
export const WRITES_PER_HOUR = 1_400;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Where the spend log lives. Memory-backed, timestamps only. */
export const BUDGET_KEY = 'vm.syncWrites';

/** The spend log, abstracted so the governor is testable without a `chrome` in scope. */
export interface BudgetStore {
  read(): Promise<readonly number[]>;
  write(stamps: readonly number[]): Promise<void>;
}

export const sessionBudgetStore: BudgetStore = {
  read: async () => {
    const raw = (await chrome.storage.session.get(BUDGET_KEY))[BUDGET_KEY];
    return Array.isArray(raw) ? raw.filter((at): at is number => typeof at === 'number') : [];
  },
  write: async (stamps) => {
    await chrome.storage.session.set({ [BUDGET_KEY]: [...stamps] });
  },
};

export interface WriteBudgetOptions {
  readonly now?: () => number;
  readonly store?: BudgetStore;
  readonly perMinute?: number;
  readonly perHour?: number;
}

export class WriteBudget {
  readonly #now: () => number;
  readonly #store: BudgetStore;
  readonly #perMinute: number;
  readonly #perHour: number;

  constructor(options: WriteBudgetOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#store = options.store ?? sessionBudgetStore;
    this.#perMinute = options.perMinute ?? WRITES_PER_MINUTE;
    this.#perHour = options.perHour ?? WRITES_PER_HOUR;
  }

  /**
   * Reserve `count` writes, or refuse the whole reservation.
   *
   * All-or-nothing on purpose. A push is a set of bucket writes followed by one header write, and
   * half of it is the torn state the ordering rule exists to prevent — better to wait a few seconds
   * and issue the lot than to spend the last four slots on the first four buckets.
   */
  async spend(count: number): Promise<void> {
    if (count <= 0) return;
    const now = this.#now();
    const stamps = prune(await this.#store.read(), now);

    const wait = this.#waitFor(stamps, count, now);
    if (wait > 0) throw new RateLimited(wait);

    await this.#store.write([...stamps, ...Array.from({ length: count }, () => now)]);
  }

  /** How long until `count` writes would be allowed. `0` means "now". Does not spend anything. */
  async retryAfter(count: number): Promise<number> {
    const now = this.#now();
    return this.#waitFor(prune(await this.#store.read(), now), count, now);
  }

  /** Writes charged in the last minute and hour. For the status UI and for tests. */
  async spent(): Promise<{ minute: number; hour: number }> {
    const now = this.#now();
    const stamps = prune(await this.#store.read(), now);
    return {
      minute: stamps.filter((at) => at > now - MINUTE_MS).length,
      hour: stamps.length,
    };
  }

  /**
   * When `count` more writes would fit.
   *
   * The wait is derived from the log rather than from a fixed delay: if 100 writes were charged in
   * the last minute, the first slot opens exactly when the oldest of them ages out, and waiting any
   * longer is throughput given away for nothing.
   */
  #waitFor(stamps: readonly number[], count: number, now: number): number {
    const minute = stamps.filter((at) => at > now - MINUTE_MS);
    const minuteWait = slotWait(minute, this.#perMinute, count, now, MINUTE_MS);
    const hourWait = slotWait(stamps, this.#perHour, count, now, HOUR_MS);
    return Math.max(minuteWait, hourWait);
  }
}

/**
 * How long until `count` slots are free in a window that holds at most `limit`.
 *
 * A reservation larger than the window itself can never be satisfied, and saying so immediately
 * beats a caller retrying forever: the answer is `Infinity`, which the provider turns into a
 * `QuotaExceeded`-shaped failure rather than a retry.
 */
function slotWait(
  stamps: readonly number[],
  limit: number,
  count: number,
  now: number,
  windowMs: number,
): number {
  if (count > limit) return Number.POSITIVE_INFINITY;
  const free = limit - stamps.length;
  if (free >= count) return 0;
  // The (count - free)th oldest stamp is the one whose expiry frees the last slot we need.
  const sorted = [...stamps].sort((a, b) => a - b);
  const blocking = sorted[count - free - 1];
  return blocking === undefined ? 0 : Math.max(1, blocking + windowMs - now);
}

function prune(stamps: readonly number[], now: number): number[] {
  return stamps.filter((at) => at > now - HOUR_MS);
}

/* ------------------------------------------------------------------ backoff */

/** First retry delay after a failure, doubling from here. */
export const BACKOFF_BASE_MS = 2_000;

/** Ceiling on the retry delay. Beyond this a sync is waiting for the next trigger anyway. */
export const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * The delay before retry number `attempt` (0-based), with full jitter.
 *
 * Jittered because the trigger that failed is often one every device saw at the same moment — a
 * `storage.onChanged` from a third device, or a browser start after a suspend. Retrying on the same
 * doubling schedule would have them collide again on every attempt, each one burning a write
 * against a budget they are all sharing.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
