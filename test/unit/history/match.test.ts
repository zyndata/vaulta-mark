/**
 * Is this history entry *this bookmark's page*? (ARCHITECTURE §12.6)
 *
 * The rule is asymmetric on purpose, and both halves of that are asserted here rather than left to
 * be re-derived from the source:
 *
 * - A bookmark with **no** query matches an entry that has one. That is the stripped-tracking-
 *   parameter case, and it is the common one: `stripTrackingParams` is on by default, so the vault
 *   routinely holds a shorter address than the browser visited.
 * - A bookmark **with** a query matches only that query. `watch?v=a` and `watch?v=b` are two videos,
 *   and a rule that ignored the query would offer to forget one and delete both.
 *
 * Everything here is decided *before* a `deleteUrl`, so a wrong answer in the widening direction is
 * somebody's browsing history. The hostile-input table at the bottom is there for the same reason
 * the one in `domain.test.ts` is.
 */

import { describe, expect, it } from 'vitest';

import { isSamePage, pageIndex, pageKeyOf } from '../../../src/history/match.js';

describe('the same page in two spellings', () => {
  const SAME: readonly (readonly [string, string, string])[] = [
    ['identical', 'https://example.com/a', 'https://example.com/a'],
    ['a fragment', 'https://example.com/a', 'https://example.com/a#section'],
    ['a trailing slash', 'https://example.com/a', 'https://example.com/a/'],
    ['a trailing slash on the bookmark', 'https://example.com/a/', 'https://example.com/a'],
    ['the host in capitals', 'https://example.com/a', 'https://EXAMPLE.com/a'],
    ['tracking parameters the vault stripped', 'https://example.com/a', 'https://example.com/a?utm_source=x'],
    ['several of them', 'https://example.com/a', 'https://example.com/a?utm_source=x&fbclid=y'],
    ['the same query in another order', 'https://example.com/a?b=2&c=3', 'https://example.com/a?c=3&b=2'],
    ['the root path', 'https://example.com', 'https://example.com/'],
    ['a port that is stated', 'https://example.com:443/a', 'https://example.com/a'],
  ];

  for (const [what, item, entry] of SAME) {
    it(`matches across ${what}`, () => {
      expect(isSamePage(item, entry)).toBe(true);
    });
  }
});

describe('two different pages', () => {
  const DIFFERENT: readonly (readonly [string, string, string])[] = [
    ['a different path', 'https://example.com/a', 'https://example.com/b'],
    ['a path that starts the same', 'https://example.com/a', 'https://example.com/a-archive'],
    ['a deeper path', 'https://example.com/a', 'https://example.com/a/b'],
    ['a different host', 'https://example.com/a', 'https://other.com/a'],
    ['a subdomain', 'https://example.com/a', 'https://www.example.com/a'],
    ['a different scheme', 'https://example.com/a', 'http://example.com/a'],
    ['a different port', 'https://example.com:8443/a', 'https://example.com/a'],
    // The one that matters: the query *is* the page here, so the widening must not apply.
    ['a different query', 'https://www.youtube.com/watch?v=a', 'https://www.youtube.com/watch?v=b'],
    ['a missing query', 'https://www.youtube.com/watch?v=a', 'https://www.youtube.com/watch'],
    ['an extra parameter on a bookmark that has one', 'https://example.com/a?b=2', 'https://example.com/a?b=2&c=3'],
  ];

  for (const [what, item, entry] of DIFFERENT) {
    it(`refuses ${what}`, () => {
      expect(isSamePage(item, entry)).toBe(false);
    });
  }

  it('is asymmetric, and that is the rule rather than an accident', () => {
    // The bookmark is the thing being asked about, so it is the bookmark's lack of a query that
    // widens the match — never the entry's.
    expect(isSamePage('https://example.com/a', 'https://example.com/a?utm_source=x')).toBe(true);
    expect(isSamePage('https://example.com/a?utm_source=x', 'https://example.com/a')).toBe(false);
  });
});

describe('hostile and malformed input', () => {
  const NOT_URLS = ['', 'not a url', 'javascript:alert(1)//https://example.com/a', '://example.com'];

  for (const value of NOT_URLS) {
    it(`answers false rather than throwing for ${JSON.stringify(value)}`, () => {
      expect(isSamePage(value, 'https://example.com/a')).toBe(false);
      expect(isSamePage('https://example.com/a', value)).toBe(false);
    });
  }

  it('has no key for something that is not a URL', () => {
    expect(pageKeyOf('not a url')).toBeNull();
  });

  it('does not let a fragment smuggle a different page in', () => {
    expect(isSamePage('https://example.com/a', 'https://example.com/b#/a')).toBe(false);
  });
});

describe('the index over many entries', () => {
  it('answers exactly what the pairwise rule would', () => {
    const entries = [
      'https://example.com/a?utm_source=x',
      'https://www.youtube.com/watch?v=b',
      'not a url',
    ];
    const index = pageIndex(entries);

    for (const item of ['https://example.com/a', 'https://www.youtube.com/watch?v=a', 'https://example.com/z']) {
      expect(index.has(item)).toBe(entries.some((entry) => isSamePage(item, entry)));
    }
  });

  it('finds a bookmark whose own query is present', () => {
    expect(pageIndex(['https://www.youtube.com/watch?v=b']).has('https://www.youtube.com/watch?v=b')).toBe(true);
  });

  it('is empty when there is nothing in it', () => {
    expect(pageIndex([]).has('https://example.com/a')).toBe(false);
  });

  it('ignores entries it cannot parse rather than refusing the whole scan', () => {
    expect(pageIndex(['nonsense', 'https://example.com/a']).has('https://example.com/a')).toBe(true);
  });
});
