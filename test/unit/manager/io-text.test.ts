/**
 * @vitest-environment jsdom
 *
 * The import preview's two count lines, and whether they agree with their own numbers.
 *
 * `src/manager/**` is otherwise covered by Playwright rather than here — it is import-time DOM glue
 * — but these two are pure functions over a pair of integers, and the bug they exist to prevent is
 * a real one that shipped: the preview read "38 of them are already in this vault" under a line
 * reading "28 bookmarks in 1 folders". Driving all six combinations through a browser would cost
 * six backups.
 *
 * Two things are asserted, and the second is the one that matters. The chrome mock answers
 * `getMessage` with the key it was given, so the tests below read as key names — that pins the
 * *choice*. Separately, every key named is checked against `_locales/en/messages.json`, because a
 * key that does not exist renders as an empty string, and an empty preview line reads as a preview
 * line that was never there.
 *
 * **Phase 18 changed the shape being pinned.** `countsLine` used to choose one of six whole
 * sentences enumerating English's two forms against two counts; it now writes two sentences, one
 * count each, and asks `Intl.PluralRules` for the form of each. So the same cases are driven, in
 * both `en` and `pl` — Polish being the language the enumeration could not have expressed, and the
 * one where 2 and 5 take different forms of the same noun.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countsLine, knownLine } from '../../../src/manager/io.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

const MESSAGES = JSON.parse(
  readFileSync(resolve('public/_locales/en/messages.json'), 'utf8'),
) as Record<string, { message: string }>;

afterEach(() => {
  uninstallChromeMock();
});

describe('countsLine, in English', () => {
  beforeEach(() => {
    installChromeMock();
  });

  it.each([
    [412, 19, 'ioPreviewCountsBookmarks_other ioPreviewCountsFolders_other'],
    [1, 19, 'ioPreviewCountsBookmarks_one ioPreviewCountsFolders_other'],
    [412, 1, 'ioPreviewCountsBookmarks_other ioPreviewCountsFolders_one'],
    [1, 1, 'ioPreviewCountsBookmarks_one ioPreviewCountsFolders_one'],
    // No folders at all is its own sentence, not the family with a zero in it.
    [412, 0, 'ioPreviewCountsBookmarks_other ioPreviewCountsNoFolders'],
    [1, 0, 'ioPreviewCountsBookmarks_one ioPreviewCountsNoFolders'],
    // A count of nothing is a plural in English, so it needs no form of its own.
    [0, 3, 'ioPreviewCountsBookmarks_other ioPreviewCountsFolders_other'],
    [0, 0, 'ioPreviewCountsBookmarks_other ioPreviewCountsNoFolders'],
  ])('%i bookmarks and %i folders reads from %s', (bookmarks, folders, keys) => {
    expect(countsLine(bookmarks, folders)).toBe(keys);
  });

  it('names only strings that exist, and that carry the numbers they are given', () => {
    for (const folders of [0, 1, 19]) {
      for (const bookmarks of [0, 1, 412]) {
        for (const key of countsLine(bookmarks, folders).split(' ')) {
          const message = MESSAGES[key]?.message;
          expect(message, key).toBeDefined();
          // Each half carries exactly its own number and never the other one's — the whole reason
          // the sentence was split, and the way a mixed-up substitution list would show up. Only
          // the "other" forms have a number at all; English's "one" spells it out as a word.
          expect(message?.includes('$FOLDERS$'), key).toBe(key === 'ioPreviewCountsFolders_other');
          expect(message?.includes('$BOOKMARKS$'), key).toBe(
            key === 'ioPreviewCountsBookmarks_other',
          );
        }
      }
    }
  });
});

/*
 * The same line in Polish, where "2 folders" and "5 folders" are different words.
 *
 * The English cases above cannot fail on this: `pluralCategory` answers `one` or `other` there for
 * every integer, which is what the six enumerated keys already did. This block is the one that
 * would have caught the old shape, and it is why the shape changed.
 */
describe('countsLine, in Polish', () => {
  beforeEach(() => {
    installChromeMock({ uiLanguage: 'pl-PL' });
  });

  it.each([
    [1, 1, 'ioPreviewCountsBookmarks_one ioPreviewCountsFolders_one'],
    [2, 2, 'ioPreviewCountsBookmarks_few ioPreviewCountsFolders_few'],
    [5, 12, 'ioPreviewCountsBookmarks_many ioPreviewCountsFolders_many'],
    // 22 and 12 end in the same digit and take different forms. No pair of keys can say that.
    [22, 12, 'ioPreviewCountsBookmarks_few ioPreviewCountsFolders_many'],
    [0, 0, 'ioPreviewCountsBookmarks_many ioPreviewCountsNoFolders'],
  ])('%i bookmarks and %i folders reads from %s', (bookmarks, folders, keys) => {
    expect(countsLine(bookmarks, folders)).toBe(keys);
  });
});

describe('knownLine', () => {
  beforeEach(() => {
    installChromeMock();
  });

  it.each([
    [0, 'ioPreviewAllNew'],
    [1, 'ioPreviewKnown_one'],
    [38, 'ioPreviewKnown_other'],
  ])('%i overlapping items reads from %s', (known, key) => {
    expect(knownLine(known)).toBe(key);
  });

  it('names only strings that exist, and puts a number in only the one with a placeholder', () => {
    for (const [known, hasCount] of [
      [0, false],
      [1, false],
      [38, true],
    ] as const) {
      const key = knownLine(known);
      const message = MESSAGES[key]?.message;
      expect(message, key).toBeDefined();
      expect(message?.includes('$COUNT$'), key).toBe(hasCount);
    }
  });
});
