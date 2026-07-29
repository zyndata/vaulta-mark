/**
 * Fractional index keys (ARCHITECTURE §3.4).
 *
 * An item's position among its siblings is a short base-62 string, ordered by plain lexicographic
 * comparison: `a0 < a0V < a1`. Inserting between two siblings mints a key strictly between theirs,
 * so a reorder rewrites **one** item — and therefore dirties one bucket — instead of renumbering a
 * whole folder and rewriting the vault. That is the entire reason this file exists: with integer
 * positions, dragging one bookmark to the top of a 400-item folder would be a 400-item commit and,
 * on the Chrome-sync tier, a quota event.
 *
 * The keys carry a variable-length **integer part** whose length is encoded in the first character
 * (`a` → 1 digit, `b` → 2, …; `Z` → 1 digit below zero, `Y` → 2, …). That prefix is what keeps
 * appends cheap: adding to the end of a list increments the integer part instead of appending a
 * digit, so a thousand sequential adds produce keys of length 2–3 rather than length 500. Only
 * inserting *between* two adjacent keys lengthens the fractional part, and then only by a digit.
 *
 * The algorithm is the well-known one from David Greenspan's note on fractional indexing (the same
 * one `fractional-indexing` implements), in its base-62 form. It is reproduced here rather than
 * depended on: it is ~120 lines, it is load-bearing for data we cannot re-derive, and D4 says a
 * runtime dependency needs a written case. This is not that case.
 *
 * No key is ever equal to another key generated for the same gap, and no sequence of inserts can
 * exhaust the space in practice — the integer part would have to overflow 27 base-62 digits.
 */

import { InvalidMutationError } from './errors.js';

/**
 * Base-62 digits **in ASCII order**, so `<` on the strings agrees with `<` on the digit values.
 * The obvious alternative (`0-9a-zA-Z`) does not have that property and would silently produce a
 * list that sorts differently from how it was ordered.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const ZERO_DIGIT = '0';
const LAST_DIGIT = 'z';

/** The lowest representable integer part. Reserved: no key may *be* it, only sit above it. */
const SMALLEST_INTEGER = `A${ZERO_DIGIT.repeat(26)}`;

/** The key a first-ever child gets: integer part `a0`, empty fractional part. */
export const FIRST_ORDER = `a${ZERO_DIGIT}`;

/**
 * Compare two order keys. Plain lexicographic comparison — the alphabet is chosen so that this is
 * correct — exposed as a named function so call sites read as intent rather than as string trivia.
 */
export function compareOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether `value` is a well-formed order key this module could have produced. */
export function isOrderKey(value: string): boolean {
  try {
    validateOrderKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A key strictly between `before` and `after`.
 *
 * `null` means "no neighbour on that side": `orderBetween(null, null)` is the first key in an empty
 * list, `orderBetween(last, null)` appends, `orderBetween(null, first)` prepends.
 */
export function orderBetween(before: string | null, after: string | null): string {
  if (before !== null) validateOrderKey(before);
  if (after !== null) validateOrderKey(after);
  if (before !== null && after !== null && before >= after) {
    throw new InvalidMutationError(`Order keys ${before} and ${after} are not in ascending order.`);
  }

  if (before === null) {
    if (after === null) return FIRST_ORDER;

    const integerPart = integerPartOf(after);
    const fractionalPart = after.slice(integerPart.length);
    if (integerPart === SMALLEST_INTEGER) return integerPart + midpoint('', fractionalPart);
    // A shorter integer part is itself a valid key below `after`, and costs no extra digits.
    if (integerPart < after) return integerPart;

    const decremented = decrementInteger(integerPart);
    if (decremented === null) {
      throw new InvalidMutationError('Order key space is exhausted below the first item.');
    }
    return decremented;
  }

  const beforeInteger = integerPartOf(before);
  const beforeFraction = before.slice(beforeInteger.length);

  if (after === null) {
    const incremented = incrementInteger(beforeInteger);
    return incremented ?? beforeInteger + midpoint(beforeFraction, null);
  }

  const afterInteger = integerPartOf(after);
  const afterFraction = after.slice(afterInteger.length);
  if (beforeInteger === afterInteger) {
    return beforeInteger + midpoint(beforeFraction, afterFraction);
  }

  const incremented = incrementInteger(beforeInteger);
  if (incremented === null) {
    throw new InvalidMutationError('Order key space is exhausted above the last item.');
  }
  if (incremented < after) return incremented;
  return beforeInteger + midpoint(beforeFraction, null);
}

/**
 * `count` ascending keys strictly between `before` and `after`.
 *
 * Used to lay out an imported folder in one pass, and as the escape hatch when a scoped renumber is
 * genuinely wanted. Bisects rather than chaining, so `n` keys stay short instead of the last one
 * carrying `n` digits of fractional part.
 */
export function ordersBetween(
  before: string | null,
  after: string | null,
  count: number,
): string[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new InvalidMutationError(`Cannot generate ${String(count)} order keys.`);
  }
  if (count === 0) return [];
  if (count === 1) return [orderBetween(before, after)];

  if (after === null) {
    // Appending: walk forward, which is the cheap direction — each step increments the integer
    // part rather than lengthening the fraction.
    const out: string[] = [];
    let previous = before;
    for (let i = 0; i < count; i++) {
      previous = orderBetween(previous, null);
      out.push(previous);
    }
    return out;
  }
  if (before === null) {
    // Prepending: walk backward, then flip, for the same reason.
    const out: string[] = [];
    let next = after;
    for (let i = 0; i < count; i++) {
      next = orderBetween(null, next);
      out.push(next);
    }
    return out.reverse();
  }

  const middleIndex = Math.floor(count / 2);
  const middle = orderBetween(before, after);
  return [
    ...ordersBetween(before, middle, middleIndex),
    middle,
    ...ordersBetween(middle, after, count - middleIndex - 1),
  ];
}

/**
 * How long the integer part starting with `head` is, in characters, `head` included.
 *
 * `a`–`z` encode 1–26 digits above zero; `Z`–`A` encode 1–26 digits below it. Encoding the length
 * in the first character is what makes the keys self-delimiting, and therefore comparable as plain
 * strings without a separator that would itself need to sort correctly.
 */
function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new InvalidMutationError(`Order key head "${head}" is not a valid integer-part marker.`);
}

function integerPartOf(key: string): string {
  const length = integerLength(key.charAt(0));
  if (length > key.length) {
    throw new InvalidMutationError(
      `Order key "${key}" declares a longer integer part than it has.`,
    );
  }
  return key.slice(0, length);
}

function validateInteger(integerPart: string): void {
  if (integerPart.length !== integerLength(integerPart.charAt(0))) {
    throw new InvalidMutationError(`"${integerPart}" is not a well-formed order integer part.`);
  }
}

/**
 * Reject keys we could not have produced.
 *
 * A trailing zero digit in the fractional part is the important one: `a01` and `a010` would name
 * the same position, so allowing both would let two items claim one slot while comparing unequal.
 */
function validateOrderKey(key: string): void {
  if (key === SMALLEST_INTEGER) {
    throw new InvalidMutationError('The smallest integer part is reserved and is not a valid key.');
  }
  const integerPart = integerPartOf(key);
  const fractionalPart = key.slice(integerPart.length);
  if (fractionalPart.endsWith(ZERO_DIGIT)) {
    throw new InvalidMutationError(`Order key "${key}" has a trailing zero digit.`);
  }
  for (const character of key) {
    if (!DIGITS.includes(character)) {
      throw new InvalidMutationError(`Order key "${key}" contains a non-base-62 character.`);
    }
  }
}

/** The next integer part, or `null` at the top of the representable range. */
function incrementInteger(integerPart: string): string | null {
  validateInteger(integerPart);
  const head = integerPart.charAt(0);
  // Base-62 digits are single ASCII characters by construction; there is no grapheme to break.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const digits = [...integerPart.slice(1)];

  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const next = DIGITS.indexOf(digits[i] ?? '') + 1;
    if (next === DIGITS.length) {
      digits[i] = ZERO_DIGIT;
    } else {
      digits[i] = DIGITS.charAt(next);
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');

  // Carried out of the digits: the integer part grows (or shrinks, below zero) by one place, which
  // the head character has to record.
  if (head === 'Z') return `a${ZERO_DIGIT}`;
  if (head === 'z') return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') digits.push(ZERO_DIGIT);
  else digits.pop();
  return nextHead + digits.join('');
}

/** The previous integer part, or `null` at the bottom of the representable range. */
function decrementInteger(integerPart: string): string | null {
  validateInteger(integerPart);
  const head = integerPart.charAt(0);
  // Base-62 digits are single ASCII characters by construction; there is no grapheme to break.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const digits = [...integerPart.slice(1)];

  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const next = DIGITS.indexOf(digits[i] ?? '') - 1;
    if (next === -1) {
      digits[i] = LAST_DIGIT;
    } else {
      digits[i] = DIGITS.charAt(next);
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join('');

  if (head === 'a') return `Z${LAST_DIGIT}`;
  if (head === 'A') return null;
  const previousHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (previousHead < 'Z') digits.push(LAST_DIGIT);
  else digits.pop();
  return previousHead + digits.join('');
}

/**
 * A fractional-part string strictly between `a` and `b`, both read as digits after an implied
 * radix point. `b === null` means "no upper bound".
 *
 * Recursion is on the common prefix: everything the two share is copied through, and the decision
 * is made at the first digit where they differ.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) {
    throw new InvalidMutationError(`Fractional parts ${a} and ${b} are not in ascending order.`);
  }
  if (a.endsWith(ZERO_DIGIT) || b?.endsWith(ZERO_DIGIT) === true) {
    throw new InvalidMutationError('Fractional parts must not end in a zero digit.');
  }

  if (b !== null) {
    let common = 0;
    while ((a.charAt(common) || ZERO_DIGIT) === b.charAt(common)) common++;
    if (common > 0) {
      return b.slice(0, common) + midpoint(a.slice(common), b.slice(common));
    }
  }

  const digitA = a === '' ? 0 : DIGITS.indexOf(a.charAt(0));
  const digitB = b === null ? DIGITS.length : DIGITS.indexOf(b.charAt(0));

  if (digitB - digitA > 1) {
    return DIGITS.charAt(Math.round(0.5 * (digitA + digitB)));
  }
  // The first digits are consecutive, so there is no room at this place value: descend one digit.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), null);
}
