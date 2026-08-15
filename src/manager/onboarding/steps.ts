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
 *   either — so "skip for now" is a real answer that leaves a real reminder.
 *
 * Everything here is a pure function of a snapshot, so the whole of it is testable without a
 * browser, a vault or a clock.
 */

import type { OnboardingRecord } from '../../vault/types.js';

/**
 * The five screens, in order (PLAN §9).
 *
 * Order is load-bearing. The password comes before incognito because a vault has to exist before
 * "open a vaulted link" means anything, and the two things Chrome still does come last because they
 * are the ones you only care about once everything else is working.
 */
export const ONBOARDING_STEPS = ['intro', 'password', 'incognito', 'sync', 'chrome'] as const;

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
 * `intro` and `sync` are always passable — they are things to read, and a reader who disagrees with
 * the sync tier can change it in Settings. The other two are the gates described at the top.
 * `chrome` is the last step, so "advancing" from it means finishing, which is always allowed: its
 * two offers (clean history, turn off URL prediction) are ones we cannot make on the user's behalf.
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
 */
export function resumeStep(record: OnboardingRecord, vaultExists: boolean): number | null {
  if (record.completedAt !== null) return null;
  const clamped = Math.min(Math.max(record.step, 0), LAST_STEP);
  const passwordStep = ONBOARDING_STEPS.indexOf('password');
  return vaultExists ? clamped : Math.min(clamped, passwordStep);
}
