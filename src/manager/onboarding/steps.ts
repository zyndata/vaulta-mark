/**
 * The first-run flow as a state machine, with no DOM in it (PLAN §9 Phase 9).
 *
 * Separate from `screen.ts` because the interesting part of onboarding is not what it looks like —
 * it is which gates can be walked past. Two of them are the reason this phase exists at all:
 *
 * - **The no-recovery acknowledgement cannot be skipped.** There is no password recovery of any kind
 *   (D12), and someone who learns that after losing their password has been failed by the product.
 *   The gate is not "the user pressed Next"; it is "this profile has a vault", which can only be
 *   true if the typed phrase matched, because that is what `screen.ts` puts in front of `CREATE_VAULT`.
 * - **Incognito is either on or explicitly skipped.** Half the promise of the product is that vaulted
 *   links open in incognito, and it needs a checkbox on a page we are not allowed to navigate to
 *   (ARCHITECTURE §9). Nobody may be swept past it without noticing, and nobody may be trapped on it
 *   either — so "skip for now" is a real answer that leaves a real reminder. It is also the *last*
 *   screen now, because ticking the checkbox reloads the extension out from under this tab; see
 *   {@link ONBOARDING_STEPS}.
 *
 * Everything here is a pure function of a snapshot, so the whole of it is testable without a
 * browser, a vault or a clock.
 */

import type { OnboardingRecord } from '../../vault/types.js';

/**
 * The five screens, in order (PLAN §9).
 *
 * Order is load-bearing, and incognito is last for a reason that is not about reading order.
 * **Ticking "Allow in Incognito" reloads the extension, and Chrome closes every extension page it
 * has open — this wizard's tab included** (maintainer-reported 2026-08-23). Nothing can survive
 * that: the reload fires no `onInstalled` and no `onStartup`, so there is no event to reopen the
 * tab from, and the page is gone before any of its own code could run. Which leaves one honest
 * answer — put the step that kills the tab where there is nothing after it to lose. The password
 * still comes first, because a vault has to exist before "open a vaulted link" means anything.
 */
export const ONBOARDING_STEPS = ['intro', 'password', 'sync', 'chrome', 'incognito'] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const LAST_STEP = ONBOARDING_STEPS.length - 1;

/** What the flow knows about the world right now. Re-read rather than remembered — see `screen.ts`. */
export interface OnboardingProgress {
  /** Index into {@link ONBOARDING_STEPS}. */
  readonly step: number;
  /** This profile holds a vault. The only proof that the no-recovery step was answered. */
  readonly vaultExists: boolean;
  /** "Allow in Incognito" is on, as of the last time we asked Chrome. */
  readonly incognitoAllowed: boolean;
  /** The user chose "skip for now" on the incognito step. */
  readonly incognitoSkipped: boolean;
}

export function stepAt(index: number): OnboardingStep {
  // Clamped rather than indexed blind: `step` comes back from storage, where a record written by a
  // build with a different number of steps can outlive it.
  const clamped = Math.min(Math.max(index, 0), LAST_STEP);
  // `ONBOARDING_STEPS` is non-empty and `clamped` is in range, which `noUncheckedIndexedAccess`
  // cannot see. A `NaN` index would defeat the clamp, so the fallback is a real branch rather than
  // an assertion: `Math.max(NaN, 0)` is `NaN`, and a wizard that renders nothing is worse than one
  // that starts over.
  return ONBOARDING_STEPS[clamped] ?? 'intro';
}

/**
 * Whether the flow may leave the step it is on.
 *
 * `intro`, `sync` and `chrome` are always passable — they are things to read, plus one offer
 * (clean history) that is not ours to make on the user's behalf, and a reader who disagrees with
 * the sync tier can change it in Settings. The other two are the gates described at the top.
 * `incognito` is the last step, so "advancing" from it means finishing — and its gate still holds
 * there, because the only ways off the screen are the thing itself and an explicit skip.
 */
export function canAdvance(progress: OnboardingProgress): boolean {
  switch (stepAt(progress.step)) {
    case 'password':
      return progress.vaultExists;
    case 'incognito':
      return progress.incognitoAllowed || progress.incognitoSkipped;
    case 'intro':
    case 'sync':
    case 'chrome':
      return true;
  }
}

/** The step after this one, or {@link LAST_STEP} at the end. Refuses to move past a closed gate. */
export function next(progress: OnboardingProgress): number {
  if (!canAdvance(progress)) return progress.step;
  return Math.min(progress.step + 1, LAST_STEP);
}

/**
 * The step before this one.
 *
 * Always allowed, including backwards past a gate that is now closed: rewinding to re-read the
 * introduction cannot un-create a vault, and a flow you can only go forwards through is one people
 * click through without reading.
 */
export function back(progress: OnboardingProgress): number {
  return Math.max(progress.step - 1, 0);
}

export function isLastStep(step: number): boolean {
  return step >= LAST_STEP;
}

/**
 * Where a flow should resume, or `null` if it should not run at all.
 *
 * `null` for a completed record is what makes "it never appears again" true — the install tab is
 * opened once by `chrome.runtime.onInstalled`, but the page is also reachable by URL and by
 * "Replay onboarding", and only the replay clears the stamp.
 *
 * A stored step is clamped *and* held back to the password step when there is no vault: a record
 * saying "step 4" beside a profile with no vault is either a half-finished flow whose vault was
 * destroyed since, or a corrupted number. Both want the same answer.
 *
 * A record left mid-flow is not a failure state and nothing nags about one: the wizard is opened by
 * `onInstalled` and by "Replay onboarding", which resets `step` first. That matters more since the
 * incognito step moved last — the tab is *expected* to die there, so the successful path is the one
 * that leaves the record unstamped.
 */
export function resumeStep(record: OnboardingRecord, vaultExists: boolean): number | null {
  if (record.completedAt !== null) return null;
  const clamped = Math.min(Math.max(record.step, 0), LAST_STEP);
  const passwordStep = ONBOARDING_STEPS.indexOf('password');
  return vaultExists ? clamped : Math.min(clamped, passwordStep);
}
