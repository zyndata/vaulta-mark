/**
 * @vitest-environment jsdom
 *
 * Plural agreement: which form a count picks, and which locale decides.
 *
 * The counts driven here are the ones where English and Polish disagree, because a table that only
 * proves `1` is singular proves nothing an `=== 1` did not already do. Polish moves twice inside the
 * teens and again at every 21: 2, 3 and 4 take one form, 5 through 21 take another, 22 goes back to
 * the first. **12 and 22 are the pair that matters** — the same last digit, different forms — and
 * they are exactly what a pair of keys could not express and why `Intl.PluralRules` is here.
 *
 * `Intl.PluralRules` is the browser's, so this is not a test of CLDR's tables. It is a test of the
 * two decisions around them: the suffix a category becomes, and the locale the category is asked
 * about — which is *not* the browser's UI language, but the UI language resolved against the
 * locales we ship. Getting the second one wrong is silent and only wrong in someone else's
 * language: a Russian browser reading our English would be told 21 is `one` and shown "1 bookmark".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCALE,
  SHIPPED_LOCALES,
  messageLocale,
  plural,
  pluralCategory,
  pluralLocale,
} from '../../../src/ui/plural.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

const COUNTS = [0, 1, 2, 4, 5, 12, 22, 25, 101] as const;

afterEach(() => {
  uninstallChromeMock();
});

describe('pluralCategory', () => {
  it.each([
    ['en', ['other', 'one', 'other', 'other', 'other', 'other', 'other', 'other', 'other']],
    ['pl', ['many', 'one', 'few', 'few', 'many', 'many', 'few', 'many', 'many']],
  ])('%s picks the forms CLDR says it does', (locale, expected) => {
    expect(COUNTS.map((count) => pluralCategory(count, locale))).toStrictEqual(expected);
  });

  it('disagrees with English on eight of nine counts, which is the point', () => {
    const disagreements = COUNTS.filter(
      (count) => pluralCategory(count, 'en') !== pluralCategory(count, 'pl'),
    );
    // Only 1 lines up: `one` in both. Every other count here would have been rendered by a
    // two-key pair in a form that is wrong in Polish.
    expect(disagreements).toStrictEqual([0, 2, 4, 5, 12, 22, 25, 101]);
  });

  it('gives Polish four forms and English two', () => {
    expect(new Set(COUNTS.map((count) => pluralCategory(count, 'pl')))).toStrictEqual(
      new Set(['one', 'few', 'many']),
    );
    // `other` is Polish's fourth, reached by fractions rather than by any whole number above.
    expect(pluralCategory(1.5, 'pl')).toBe('other');
    expect(new Set(COUNTS.map((count) => pluralCategory(count, 'en')))).toStrictEqual(
      new Set(['one', 'other']),
    );
  });
});

describe('messageLocale', () => {
  const shipped = ['en', 'pl'];

  it.each([
    ['pl', 'pl'],
    ['PL', 'pl'],
    ['pl-PL', 'pl'],
    // Chrome hands back a hyphen; the directory names and some settings use an underscore.
    ['pl_PL', 'pl'],
    ['en-GB', 'en'],
  ])('resolves %s to %s', (ui, expected) => {
    expect(messageLocale(ui, shipped)).toBe(expected);
  });

  it('falls back to the default locale for a language we do not ship', () => {
    // The case this function exists for. Chrome renders our English here, so the plural rules asked
    // must be English's — `Intl.PluralRules('ru').select(21)` is `one`, and an English "1 bookmark"
    // over twenty-one of them is what taking the UI language at face value would print.
    expect(messageLocale('ru-RU', shipped)).toBe(DEFAULT_LOCALE);
    expect(messageLocale('de', shipped)).toBe('en');
    expect(messageLocale('', shipped)).toBe('en');
  });

  it('defaults to the locales this build actually ships', () => {
    expect(SHIPPED_LOCALES).toContain(DEFAULT_LOCALE);
    for (const tag of SHIPPED_LOCALES) expect(messageLocale(tag)).toBe(tag);
  });
});

describe('plural, against the browser', () => {
  it('reads the UI language once and keeps it', () => {
    const mock = installChromeMock();
    let asked = 0;
    mock.chrome.i18n.getUILanguage = () => {
      asked += 1;
      return 'en';
    };
    pluralLocale();
    pluralLocale();
    // Chrome restarts to change its UI language, so the answer cannot move under an open document.
    // Asking again would be one message-passing round trip per row of a five-thousand-row list.
    expect(asked).toBe(1);
  });

  describe('with the chrome mock, which answers with the key it was given', () => {
    beforeEach(() => {
      installChromeMock();
    });

    it('appends the category as a suffix', () => {
      expect(plural('listCountBookmarks', 1)).toBe('listCountBookmarks_one');
      expect(plural('listCountBookmarks', 143)).toBe('listCountBookmarks_other');
    });

    it('passes the substitutions through untouched', () => {
      // The mock ignores them, so this pins the call shape rather than the result: a family member
      // that spells its number out in words and one that substitutes it are handed the same array.
      expect(plural('listCountBookmarks', 5, ['5'])).toBe('listCountBookmarks_other');
    });
  });

  it('falls back to the "other" form when the category has no key', () => {
    // What a half-finished outside translation looks like — and it must look like English words
    // rather than a blank label, because a blank one is invisible to everybody who could report it.
    const mock = installChromeMock();
    mock.chrome.i18n.getMessage = (key: string) => (key.endsWith('_other') ? 'a fallback' : '');
    expect(plural('somethingUnfinished', 5)).toBe('a fallback');
  });

  it('does not paper over a family that is missing entirely', () => {
    // `_other` absent too means the family does not exist, and an empty string is the honest
    // answer: `scripts/verify-strings.mjs` is what catches it, at build time, by name.
    const mock = installChromeMock();
    mock.chrome.i18n.getMessage = () => '';
    expect(plural('typo', 5)).toBe('');
  });
});
