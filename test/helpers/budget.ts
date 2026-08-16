/**
 * Wall-clock budgets, and the one place that decides which number a run is held to.
 *
 * Two of this suite's assertions are stopwatch readings — the worker's cold start and a 500-item
 * unlock, both from ARCHITECTURE §7.2. A stopwatch measures the machine as much as the code, and a
 * CI runner is roughly 3× slower than a development one, so each budget has always been two
 * numbers. What was wrong until now is *how the pair was chosen*: on `process.env.CI` alone, which
 * meant the full ~95-file parallel run on a laptop was held to the tight number while competing
 * with ninety-four other files for four cores. Both budgets were measured failing that way at
 * commits predating the code they gate, while `CI=1 npm run verify` was green.
 *
 * The tier now comes from `VM_BUDGET_TIER`, computed once in `vitest.config.ts` (the reasoning for
 * how it is detected lives there, next to the detection). A targeted run gets the tight number,
 * because typing a filename is what you do when you are actually measuring; the whole-suite run
 * gets the relaxed one.
 *
 * **This trades away something real and it is worth naming.** The tight budget now rarely runs
 * unattended, so a regression between 50 ms and 150 ms of cold start will not turn `npm run verify`
 * red on its own — CI holds the 150 ms line and nothing holds the 50 ms line by default. That is
 * the deliberate side of the trade: a gate that fires when nothing is wrong stops being read at
 * all, and this one was. When touching the worker's import graph or the unlock path, run the two
 * files by name, or `VM_BUDGET_TIER=tight npm run test`.
 */

/** True when this run is held to the tight, development-machine numbers. */
export const TIGHT_BUDGETS = process.env['VM_BUDGET_TIER'] === 'tight';

/**
 * Pick the budget for this run.
 *
 * Both numbers are stated at every call site rather than one being derived from the other, so a
 * reader sees the spec's figure and the allowance beside it without arithmetic.
 */
export function budgetMs(tight: number, relaxed: number): number {
  return TIGHT_BUDGETS ? tight : relaxed;
}
