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
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countsLine, knownLine } from '../../../src/manager/io.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

const MESSAGES = JSON.parse(
  readFileSync(resolve('public/_locales/en/messages.json'), 'utf8'),
) as Record<string, { message: string }>;

beforeEach(() => {
  installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('countsLine', () => {
  it.each([
    [412, 19, 'ioPreviewCounts'],
    [1, 19, 'ioPreviewCountsOneBookmark'],
    [412, 1, 'ioPreviewCountsOneFolder'],
    [1, 1, 'ioPreviewCountsOneEach'],
    [412, 0, 'ioPreviewCountsNoFolders'],
    [1, 0, 'ioPreviewCountsOneNoFolders'],
    // A count of nothing is a plural in English, so it needs no key of its own.
    [0, 3, 'ioPreviewCounts'],
    [0, 0, 'ioPreviewCountsNoFolders'],
  ])('%i bookmarks and %i folders reads from %s', (bookmarks, folders, key) => {
    expect(countsLine(bookmarks, folders)).toBe(key);
  });

  it('names only strings that exist, and that carry the numbers they are given', () => {
    for (const folders of [0, 1, 19]) {
      for (const bookmarks of [0, 1, 412]) {
        const key = countsLine(bookmarks, folders);
        const message = MESSAGES[key]?.message;
        expect(message, key).toBeDefined();
        expect(message, key).toContain('$BOOKMARKS$');
        // The no-folders pair says "and no folders" in words: there is no number to substitute.
        expect(message?.includes('$FOLDERS$'), key).toBe(folders > 0);
      }
    }
  });
});

describe('knownLine', () => {
  it.each([
    [0, 'ioPreviewAllNew'],
    [1, 'ioPreviewKnownOne'],
    [38, 'ioPreviewKnown'],
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
