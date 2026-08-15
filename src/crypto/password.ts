/**
 * Master-password strength estimation (ARCHITECTURE §4.6).
 *
 * A deliberately small, in-repo, zxcvbn-*shaped* heuristic — length, character-class variety, a
 * bundled common-password list, and repeat/sequence/keyboard-walk detection — rather than zxcvbn
 * itself, which is a ~400 KB runtime dependency in a package whose whole premise is that you can
 * read all of it (D4).
 *
 * **What this is for.** There is no password recovery and no key escrow: a weak master password is
 * the one failure mode we cannot fix afterwards. The estimator exists so a user makes that choice
 * knowingly. It does not block: below "good" the create-vault flow asks for a second confirmation
 * (Phase 4), it does not refuse. The only hard rule is {@link MIN_PASSWORD_LENGTH}.
 *
 * **Nothing here is a user-facing string.** Warnings are machine-readable codes; the UI maps them
 * to localized text from `_locales`. And nothing here logs, hashes, or transmits the password — the
 * common-password check is a local set lookup against a bundled asset.
 */

import { gunzip, utf8Decode, fromBase64Url } from './codec.js';
import { COMMON_PASSWORDS_GZ } from './data/common-passwords.js';

/** Hard floor. Shorter than this and the vault cannot be created at all. */
export const MIN_PASSWORD_LENGTH = 10;

/** Bucketed strength, 0 (hopeless) to 4 (strong). */
export type PasswordScore = 0 | 1 | 2 | 3 | 4;

/** A password at or above this score does not trigger the extra confirmation step. */
export const ACCEPTABLE_SCORE: PasswordScore = 3;

/**
 * Machine-readable reasons a password scored badly. The UI turns these into sentences; keeping
 * them as codes is what keeps user-facing English out of `src/` (Phase 12).
 */
export type PasswordWarning =
  | 'too-short'
  | 'common-password'
  | 'common-password-variant'
  | 'single-character-class'
  | 'repeated-characters'
  | 'sequential-characters'
  | 'keyboard-pattern'
  | 'year-like';

export interface PasswordStrength {
  readonly score: PasswordScore;
  /** Estimated entropy after penalties. Informational — the score is what the UI shows. */
  readonly bits: number;
  /** Sorted and deduplicated, so the result is stable enough to assert on. */
  readonly warnings: readonly PasswordWarning[];
  readonly meetsMinimumLength: boolean;
  /** `true` when the vault can be created without the extra "are you sure" step. */
  readonly acceptable: boolean;
}

/** Entropy thresholds, in bits, for scores 1–4. Below the first entry the score is 0. */
const SCORE_THRESHOLDS = [28, 40, 56, 72] as const;

/** Rows a finger walks along. Reversed walks (`poiuy`) are checked too. */
const KEYBOARD_ROWS = [
  '`1234567890-=',
  'qwertyuiop[]\\',
  "asdfghjkl;'",
  'zxcvbnm,./',
  'azertyuiop',
  '1qaz2wsx3edc',
] as const;

/** Shortest run that counts as a walk, a sequence, or a repeat. */
const RUN_THRESHOLD = 4;

/** Leet substitutions, applied before the common-list lookup so `P@ssw0rd` finds `password`. */
const DELEET = new Map<string, string>([
  ['0', 'o'],
  ['1', 'i'],
  ['3', 'e'],
  ['4', 'a'],
  ['5', 's'],
  ['6', 'g'],
  ['7', 't'],
  ['8', 'b'],
  ['9', 'g'],
  ['@', 'a'],
  ['$', 's'],
  ['!', 'i'],
  ['+', 't'],
]);

/**
 * Score a password.
 *
 * Async only because the bundled list is decompressed on first use; the result is memoized, so
 * every call after the first is synchronous work behind an already-settled promise — cheap enough
 * to run on each keystroke of a strength meter.
 */
/**
 * Length in code points — the unit a person counts what they typed in, so ten emoji are ten
 * characters and not twenty UTF-16 units.
 *
 * The one place that answer is computed, so the repository's hard floor and the popup's live
 * validation cannot disagree about whether a password is long enough.
 */
export function passwordLength(password: string): number {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  return [...password].length;
}

export async function estimateStrength(password: string): Promise<PasswordStrength> {
  // Code points are the unit we want: a password of ten emoji is ten characters, not twenty
  // UTF-16 units, and the minimum length must be counted the way a person counts what they typed.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const characters = [...password];
  const warnings = new Set<PasswordWarning>();
  const meetsMinimumLength = characters.length >= MIN_PASSWORD_LENGTH;
  if (!meetsMinimumLength) warnings.add('too-short');

  if (characters.length === 0) {
    return freeze(0, 0, warnings, meetsMinimumLength);
  }

  const lower = password.toLowerCase();
  const common = await commonPasswords();

  // Patterns first: they both raise warnings and shrink the string the entropy estimate is
  // computed over, since `aaaaaaaa` carries nowhere near eight characters' worth of choice.
  const collapsed = collapseRuns(characters, warnings);
  if (hasSequence(lower)) warnings.add('sequential-characters');
  if (hasKeyboardWalk(lower)) warnings.add('keyboard-pattern');
  if (/(?:19|20)\d{2}/.test(password)) warnings.add('year-like');

  const classes = characterClasses(characters);
  if (classes.count === 1) warnings.add('single-character-class');

  let bits = collapsed.length * Math.log2(classes.alphabetSize);

  // Pattern penalties. Multiplicative rather than subtractive so a long passphrase that happens to
  // contain "2024" is not punished as hard as a short password that is nothing but a pattern.
  if (warnings.has('sequential-characters') || warnings.has('keyboard-pattern')) bits *= 0.6;
  if (warnings.has('repeated-characters')) bits *= 0.8;
  if (warnings.has('year-like')) bits *= 0.9;

  // The list check caps rather than scales: a password that *is* a known one has no entropy worth
  // the name, whatever its character classes claim.
  if (common.has(lower)) {
    warnings.add('common-password');
    bits = Math.min(bits, 8);
  } else if (isCommonVariant(lower, common)) {
    warnings.add('common-password-variant');
    bits = Math.min(bits, 18);
  }

  const score = meetsMinimumLength
    ? scoreFor(bits)
    : (Math.min(scoreFor(bits), 1) as PasswordScore);
  return freeze(score, bits, warnings, meetsMinimumLength);
}

/** Whether a password appears verbatim in the bundled list. Exposed for the create-vault flow. */
export async function isCommonPassword(password: string): Promise<boolean> {
  return (await commonPasswords()).has(password.toLowerCase());
}

let listPromise: Promise<ReadonlySet<string>> | null = null;

/** Decompress the bundled list once, then hand out the same set forever. */
async function commonPasswords(): Promise<ReadonlySet<string>> {
  listPromise ??= (async () => {
    const text = utf8Decode(await gunzip(fromBase64Url(COMMON_PASSWORDS_GZ)));
    return new Set(text.split('\n').filter((line) => line.length > 0));
  })();
  return listPromise;
}

/**
 * Is this a known password wearing a disguise? Checks the de-leeted form, and the form with
 * trailing digits and punctuation stripped — between them, most of what `password` becomes.
 */
function isCommonVariant(lower: string, common: ReadonlySet<string>): boolean {
  // Leet substitution is a per-code-point mapping over ASCII; anything else passes through.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const deleeted = [...lower].map((character) => DELEET.get(character) ?? character).join('');
  const candidates = [
    deleeted,
    lower.replace(/[\d\W_]+$/u, ''),
    deleeted.replace(/[\d\W_]+$/u, ''),
  ];
  return candidates.some((candidate) => candidate.length > 0 && common.has(candidate));
}

/**
 * Collapse runs of the same character to two, and flag the fact.
 *
 * Returns what is left, which is what the entropy estimate is computed over: `aaaaaaaaaa` should
 * not score like ten independent choices.
 */
function collapseRuns(characters: readonly string[], warnings: Set<PasswordWarning>): string[] {
  const out: string[] = [];
  let runLength = 0;
  let previous: string | undefined;
  for (const character of characters) {
    runLength = character === previous ? runLength + 1 : 1;
    previous = character;
    if (runLength >= RUN_THRESHOLD) warnings.add('repeated-characters');
    if (runLength <= 2) out.push(character);
  }
  return out;
}

/** A run of {@link RUN_THRESHOLD} or more characters ascending or descending by one code unit. */
function hasSequence(lower: string): boolean {
  let run = 1;
  let direction = 0;
  for (let i = 1; i < lower.length; i++) {
    const step = lower.charCodeAt(i) - lower.charCodeAt(i - 1);
    if (step === direction && (step === 1 || step === -1)) {
      run += 1;
    } else if (step === 1 || step === -1) {
      direction = step;
      run = 2;
    } else {
      direction = 0;
      run = 1;
    }
    if (run >= RUN_THRESHOLD) return true;
  }
  return false;
}

/** A substring of {@link RUN_THRESHOLD} adjacent keys from any row, forwards or backwards. */
function hasKeyboardWalk(lower: string): boolean {
  for (const row of KEYBOARD_ROWS) {
    // Keyboard rows are ASCII.
    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    const reversed = [...row].reverse().join('');
    for (let i = 0; i + RUN_THRESHOLD <= row.length; i++) {
      if (lower.includes(row.slice(i, i + RUN_THRESHOLD))) return true;
      if (lower.includes(reversed.slice(i, i + RUN_THRESHOLD))) return true;
    }
  }
  return false;
}

/**
 * Which character classes are present, and the resulting per-character alphabet size.
 *
 * "Other" is anything outside printable ASCII — accented letters, CJK, emoji. It is credited
 * generously (100) because such a character genuinely comes from a much larger pool than a Latin
 * letter, and stingily enough that we are not claiming a two-emoji password is unbreakable.
 */
function characterClasses(characters: readonly string[]): { count: number; alphabetSize: number } {
  const present = { lower: false, upper: false, digit: false, symbol: false, other: false };
  for (const character of characters) {
    if (/^[a-z]$/.test(character)) present.lower = true;
    else if (/^[A-Z]$/.test(character)) present.upper = true;
    else if (/^\d$/.test(character)) present.digit = true;
    else if (/^[\x20-\x7e]$/.test(character)) present.symbol = true;
    else present.other = true;
  }
  const alphabetSize =
    (present.lower ? 26 : 0) +
    (present.upper ? 26 : 0) +
    (present.digit ? 10 : 0) +
    (present.symbol ? 33 : 0) +
    (present.other ? 100 : 0);
  const count = Object.values(present).filter(Boolean).length;
  return { count, alphabetSize: Math.max(alphabetSize, 2) };
}

function scoreFor(bits: number): PasswordScore {
  let score = 0;
  for (const threshold of SCORE_THRESHOLDS) {
    if (bits >= threshold) score += 1;
  }
  return score as PasswordScore;
}

function freeze(
  score: PasswordScore,
  bits: number,
  warnings: ReadonlySet<PasswordWarning>,
  meetsMinimumLength: boolean,
): PasswordStrength {
  return {
    score,
    bits: Math.round(bits * 10) / 10,
    warnings: [...warnings].sort(),
    meetsMinimumLength,
    acceptable: meetsMinimumLength && score >= ACCEPTABLE_SCORE,
  };
}
