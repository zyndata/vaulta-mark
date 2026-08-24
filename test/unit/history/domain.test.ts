/**
 * Registrable-domain extraction against the shipped list (ARCHITECTURE §12.1).
 *
 * This is the function that decides which history entries a cleanup deletes, so the cases that
 * matter are the ones where the naive answer is wrong: `co.uk`, `com.au`, `github.io`, the wildcard
 * suffixes, and the handful of exception rules that punch holes in them. PLAN §9 names the first
 * four by name.
 *
 * The over-match case is the one with teeth. `chrome.history.search('example.com')` answers with
 * `notexample.community`, and the only thing standing between that and `deleteUrl` is
 * `urlBelongsTo` returning false.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { DomainMatcher } from '../../../src/history/domain.js';
import { parsePublicSuffixList } from '../../../src/history/public-suffix.js';
import { publicSuffixText, realDomainMatcher } from '../../helpers/psl.js';

/**
 * One matcher over the real shipped asset, built once.
 *
 * The list is read from `public/` rather than stubbed: these are the cases the file exists for, and
 * a fixture list that left out `co.uk` would leave the test passing and the product broken.
 */
let psl: DomainMatcher;

beforeAll(async () => {
  psl = await realDomainMatcher();
});

describe('registrableDomain', () => {
  it('handles plain single-label suffixes', () => {
    expect(psl.registrableDomain('example.com')).toBe('example.com');
    expect(psl.registrableDomain('www.example.com')).toBe('example.com');
    expect(psl.registrableDomain('a.b.c.example.com')).toBe('example.com');
    expect(psl.registrableDomain('example.org')).toBe('example.org');
  });

  it('handles multi-label suffixes rather than taking the last two labels', () => {
    // "last two labels" would answer `co.uk` here, and a cleanup aimed at `co.uk` would target
    // every British site in the profile's history.
    expect(psl.registrableDomain('bbc.co.uk')).toBe('bbc.co.uk');
    expect(psl.registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(psl.registrableDomain('example.com.au')).toBe('example.com.au');
    expect(psl.registrableDomain('shop.example.com.au')).toBe('example.com.au');
  });

  it('treats a suffix on its own as having no registrable domain', () => {
    expect(psl.registrableDomain('co.uk')).toBeNull();
    expect(psl.registrableDomain('com')).toBeNull();
    expect(psl.registrableDomain('com.au')).toBeNull();
  });

  it('handles github.io, which is one label deeper than it looks', () => {
    // A PRIVATE-section rule, and the reason the bundled list is not ICANN-only: without it
    // `alice.github.io` reduces to `github.io`, and a cleanup aimed at one person's pages would
    // delete every GitHub Pages site in the profile's history.
    expect(psl.registrableDomain('alice.github.io')).toBe('alice.github.io');
    expect(psl.registrableDomain('docs.alice.github.io')).toBe('alice.github.io');
    expect(psl.registrableDomain('github.io')).toBeNull();
  });

  it('keeps two people on one hosting domain apart', () => {
    expect(psl.registrableDomain('alice.blogspot.com')).toBe('alice.blogspot.com');
    expect(psl.registrableDomain('bob.blogspot.com')).toBe('bob.blogspot.com');
  });

  it('applies wildcard rules one label at a time', () => {
    // `*.ck` is a wildcard rule: `something.ck` is a suffix, so the registrable domain is one
    // label further left.
    expect(psl.registrableDomain('foo.ck')).toBeNull();
    expect(psl.registrableDomain('site.foo.ck')).toBe('site.foo.ck');
    expect(psl.registrableDomain('www.site.foo.ck')).toBe('site.foo.ck');
  });

  it('lets an exception rule punch through the wildcard above it', () => {
    // `!www.ck` beats `*.ck`, so `www.ck` is registrable rather than a public suffix.
    expect(psl.registrableDomain('www.ck')).toBe('www.ck');
    expect(psl.registrableDomain('anything.www.ck')).toBe('www.ck');
  });

  it('falls back to the last two labels for an unknown TLD', () => {
    expect(psl.registrableDomain('host.invalidtldthatdoesnotexist')).toBe(
      'host.invalidtldthatdoesnotexist',
    );
  });

  it('answers null for anything with no dot, and for nonsense', () => {
    expect(psl.registrableDomain('localhost')).toBeNull();
    expect(psl.registrableDomain('')).toBeNull();
    expect(psl.registrableDomain('   ')).toBeNull();
    expect(psl.registrableDomain('..')).toBeNull();
    expect(psl.registrableDomain('.example.com')).toBeNull();
  });

  it('normalises case and a trailing root dot', () => {
    expect(psl.registrableDomain('WWW.Example.COM')).toBe('example.com');
    expect(psl.registrableDomain('www.example.com.')).toBe('example.com');
  });

  it('answers an IP literal with itself', () => {
    // No registrable domain exists in the PSL sense, and dropping them would mean a bookmark on a
    // NAS or a dev box could never be cleaned. Equality is the right containment test for these.
    expect(psl.registrableDomain('192.168.1.5')).toBe('192.168.1.5');
    expect(psl.registrableDomain('[2001:db8::1]')).toBe('[2001:db8::1]');
  });

  it('is stable across repeated calls, so the lazy rule sets are built once and reused', () => {
    expect(psl.registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(psl.registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
  });
});

describe('registrableDomainOf', () => {
  it('reads the host out of a URL', () => {
    expect(psl.registrableDomainOf('https://news.bbc.co.uk/weather?a=1#b')).toBe('bbc.co.uk');
    expect(psl.registrableDomainOf('http://example.com:8080/')).toBe('example.com');
  });

  it('answers null for anything that is not a URL with a host', () => {
    expect(psl.registrableDomainOf('not a url')).toBeNull();
    expect(psl.registrableDomainOf('about:blank')).toBeNull();
    expect(psl.registrableDomainOf('file:///home/alice/notes.html')).toBeNull();
  });
});

describe('urlBelongsTo', () => {
  it('rejects the substring matches chrome.history.search returns', () => {
    expect(psl.urlBelongsTo('https://example.com/page', 'example.com')).toBe(true);
    expect(psl.urlBelongsTo('https://www.example.com/page', 'example.com')).toBe(true);

    // Every one of these is something `search({ text: 'example.com' })` would hand back.
    expect(psl.urlBelongsTo('https://notexample.community/page', 'example.com')).toBe(false);
    expect(psl.urlBelongsTo('https://example.com.evil.test/page', 'example.com')).toBe(false);
    expect(psl.urlBelongsTo('https://elsewhere.test/?ref=example.com', 'example.com')).toBe(false);
    expect(psl.urlBelongsTo('https://myexample.com/page', 'example.com')).toBe(false);
  });

  it('does not confuse two sites under the same public suffix', () => {
    expect(psl.urlBelongsTo('https://alice.github.io/blog', 'bob.github.io')).toBe(false);
    expect(psl.urlBelongsTo('https://bob.github.io/blog', 'bob.github.io')).toBe(true);
  });
});

describe('the shipped asset', () => {
  it('is the whole list, punycoded, with the three rule kinds recognised', async () => {
    const { plain, wildcard, exception } = parsePublicSuffixList(await publicSuffixText());

    // Not asserted exactly — that would pin the test to a fetch date — but an order of magnitude
    // below this means a regeneration went wrong and half the suffixes are missing. The wildcard
    // floor in particular would fail on an ICANN-only list, which has 16 of them to the full
    // list's 281.
    expect(plain.size).toBeGreaterThan(9_000);
    expect(wildcard.size).toBeGreaterThan(100);
    expect(exception.size).toBeGreaterThan(5);

    // Prefixes are stripped by the parser, and the whole list is ASCII: `URL.hostname` is always
    // punycode, so a Unicode rule could never match anything the extension sees.
    for (const set of [plain, wildcard, exception]) {
      for (const rule of set) {
        expect(rule.startsWith('*'), rule).toBe(false);
        expect(rule.startsWith('!'), rule).toBe(false);
        // Punycode and dots only, which is exactly the alphabet `URL.hostname` produces.
        expect(/^[a-z0-9.-]+$/u.test(rule), rule).toBe(true);
      }
    }
  });
});
