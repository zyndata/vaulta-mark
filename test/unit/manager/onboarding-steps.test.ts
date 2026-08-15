/**
 * The first-run flow's gates (PLAN §9 Phase 9).
 *
 * The Definition of done says a fresh install "walks a user through incognito + no-recovery +
 * sync-tier without them being able to skip the no-recovery acknowledgement", and this is where that
 * is a fact rather than an intention. The gate is `vaultExists`, not "the form said so": nothing can
 * set it but a `CREATE_VAULT` that succeeded, and nothing can send one but a form whose typed phrase
 * matched (`ui/create-form.ts`, tested separately).
 */

import { describe, expect, it } from 'vitest';

import {
  LAST_STEP,
  ONBOARDING_STEPS,
  back,
  canAdvance,
  isLastStep,
  next,
  resumeStep,
  stepAt,
  type OnboardingProgress,
} from '../../../src/manager/onboarding/steps.js';
import { DEFAULT_ONBOARDING, type OnboardingRecord } from '../../../src/vault/types.js';

function at(step: number, over: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return {
    step,
    vaultExists: false,
    incognitoAllowed: false,
    incognitoSkipped: false,
    ...over,
  };
}

const INTRO = ONBOARDING_STEPS.indexOf('intro');
const PASSWORD = ONBOARDING_STEPS.indexOf('password');
const INCOGNITO = ONBOARDING_STEPS.indexOf('incognito');
const SYNC = ONBOARDING_STEPS.indexOf('sync');
const CHROME = ONBOARDING_STEPS.indexOf('chrome');

describe('the step list', () => {
  it('is the five screens PLAN §9 names, in that order', () => {
    expect([...ONBOARDING_STEPS]).toEqual(['intro', 'password', 'incognito', 'sync', 'chrome']);
    expect(LAST_STEP).toBe(4);
  });

  it('clamps an index from storage rather than rendering nothing', () => {
    expect(stepAt(0)).toBe('intro');
    expect(stepAt(4)).toBe('chrome');
    expect(stepAt(-3)).toBe('intro');
    expect(stepAt(99)).toBe('chrome');
    expect(stepAt(Number.NaN)).toBe('intro');
  });
});

describe('the no-recovery gate', () => {
  it('will not let the password step be passed without a vault', () => {
    expect(canAdvance(at(PASSWORD))).toBe(false);
    expect(next(at(PASSWORD))).toBe(PASSWORD);
  });

  it('opens the moment a vault exists, and only then', () => {
    expect(canAdvance(at(PASSWORD, { vaultExists: true }))).toBe(true);
    expect(next(at(PASSWORD, { vaultExists: true }))).toBe(INCOGNITO);
  });

  it('cannot be walked around by an incognito answer', () => {
    expect(canAdvance(at(PASSWORD, { incognitoAllowed: true, incognitoSkipped: true }))).toBe(false);
  });
});

describe('the incognito gate', () => {
  it('is closed until the toggle is on or the step is skipped', () => {
    expect(canAdvance(at(INCOGNITO, { vaultExists: true }))).toBe(false);
    expect(next(at(INCOGNITO, { vaultExists: true }))).toBe(INCOGNITO);
  });

  it('opens on the real thing', () => {
    expect(canAdvance(at(INCOGNITO, { vaultExists: true, incognitoAllowed: true }))).toBe(true);
  });

  it('opens on an explicit skip — nobody may be trapped on it either', () => {
    expect(canAdvance(at(INCOGNITO, { vaultExists: true, incognitoSkipped: true }))).toBe(true);
  });
});

describe('the ungated steps', () => {
  it('let the reading screens through', () => {
    expect(canAdvance(at(INTRO))).toBe(true);
    expect(canAdvance(at(SYNC, { vaultExists: true, incognitoAllowed: true }))).toBe(true);
    expect(canAdvance(at(CHROME, { vaultExists: true, incognitoAllowed: true }))).toBe(true);
  });

  it('stops advancing at the last step', () => {
    expect(isLastStep(CHROME)).toBe(true);
    expect(next(at(CHROME, { vaultExists: true, incognitoAllowed: true }))).toBe(CHROME);
  });
});

describe('going back', () => {
  it('is always allowed, including out of a step whose gate is shut', () => {
    // Rewinding to re-read the introduction cannot un-create a vault, and a flow you can only go
    // forwards through is one people click through without reading.
    expect(back(at(PASSWORD))).toBe(INTRO);
    expect(back(at(INCOGNITO, { vaultExists: true }))).toBe(PASSWORD);
  });

  it('stops at the first step', () => {
    expect(back(at(INTRO))).toBe(INTRO);
  });
});

describe('resumeStep', () => {
  function record(over: Partial<OnboardingRecord> = {}): OnboardingRecord {
    return { ...DEFAULT_ONBOARDING, ...over };
  }

  it('starts a fresh install at the beginning', () => {
    expect(resumeStep(record(), false)).toBe(INTRO);
  });

  it('answers null once the flow has been completed, so it never appears again', () => {
    expect(resumeStep(record({ completedAt: 1_750_000_000_000, step: 4 }), true)).toBeNull();
    expect(resumeStep(record({ completedAt: 1_750_000_000_000, step: 0 }), true)).toBeNull();
  });

  it('resumes where a closed tab left off', () => {
    expect(resumeStep(record({ step: SYNC }), true)).toBe(SYNC);
  });

  it('holds a vault-less profile back to the password step', () => {
    // A record saying "step 4" beside a profile with no vault is a half-finished flow whose vault
    // was destroyed since, or a corrupted number. Both want the same answer.
    expect(resumeStep(record({ step: CHROME }), false)).toBe(PASSWORD);
  });

  it('clamps a step from a build with a different number of screens', () => {
    expect(resumeStep(record({ step: 99 }), true)).toBe(CHROME);
    expect(resumeStep(record({ step: -1 }), true)).toBe(INTRO);
  });
});
