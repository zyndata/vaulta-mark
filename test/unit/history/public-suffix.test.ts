/**
 * Loading the public suffix list out of the package (ARCHITECTURE §12.1).
 *
 * The list moved out of `background.js` and into a packaged asset, which turns a constant into an
 * I/O path — and an I/O path has failure modes a string literal never had. The three that matter
 * are here: it must be read once however many callers ask, a failed read must **refuse** rather
 * than fall back to "the last two labels", and a truncated file must be recognised as truncated
 * rather than parsed into a list with holes in it.
 *
 * The last one is the reason the floor exists at all: a hole in this list does not crash anything,
 * it silently makes a cleanup delete a different site's history.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PSL_ASSET,
  PublicSuffixListError,
  parsePublicSuffixList,
} from '../../../src/history/public-suffix.js';
import { publicSuffixText } from '../../helpers/psl.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

beforeEach(() => {
  installChromeMock();
  vi.resetModules();
});

afterEach(() => {
  uninstallChromeMock();
  vi.unstubAllGlobals();
});

/** A fresh module instance, because the loader caches for the lifetime of the worker. */
async function freshLoader(): Promise<typeof import('../../../src/history/public-suffix.js')> {
  vi.resetModules();
  return await import('../../../src/history/public-suffix.js');
}

describe('parsePublicSuffixList', () => {
  it('recognises the three rule kinds and skips comments and blank lines', async () => {
    const text = await publicSuffixText();
    const { plain, wildcard, exception } = parsePublicSuffixList(text);

    expect(plain.has('com')).toBe(true);
    expect(plain.has('co.uk')).toBe(true);
    expect(plain.has('github.io')).toBe(true);
    // Stored without their prefixes, which is what the matcher expects.
    expect(wildcard.has('ck')).toBe(true);
    expect(exception.has('www.ck')).toBe(true);
    // The header is four `//` lines, and none of them may become a rule.
    for (const rule of plain) expect(rule.startsWith('//')).toBe(false);
  });

  it('refuses a file that parsed to almost nothing', () => {
    expect(() => parsePublicSuffixList('// just a header\n\ncom\nnet\n')).toThrow(
      PublicSuffixListError,
    );
  });
});

describe('publicSuffixMatcher', () => {
  it('reads the asset once, however many callers ask', async () => {
    const body = await publicSuffixText();
    let reads = 0;
    vi.stubGlobal('fetch', (input: string) => {
      expect(input.endsWith(PSL_ASSET)).toBe(true);
      reads++;
      return Promise.resolve(new Response(body, { status: 200 }));
    });

    const loader = await freshLoader();
    const [first, second] = await Promise.all([
      loader.publicSuffixMatcher(),
      loader.publicSuffixMatcher(),
    ]);
    await loader.publicSuffixMatcher();

    expect(reads).toBe(1);
    expect(first).toBe(second);
    expect(first.registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
  });

  it('refuses when the asset cannot be read, and never guesses', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 404 })));
    const loader = await freshLoader();

    // The loader's own class, not the one imported at the top: `vi.resetModules()` gives this test
    // a second module instance, and `instanceof` across the two is false however identical they are.
    await expect(loader.publicSuffixMatcher()).rejects.toThrow(loader.PublicSuffixListError);
  });

  it('lets a later call try again after a failed read', async () => {
    const body = await publicSuffixText();
    let attempt = 0;
    vi.stubGlobal('fetch', () => {
      attempt++;
      return attempt === 1
        ? Promise.reject(new Error('interrupted'))
        : Promise.resolve(new Response(body, { status: 200 }));
    });

    const loader = await freshLoader();
    await expect(loader.publicSuffixMatcher()).rejects.toThrow(loader.PublicSuffixListError);

    // A worker that failed once is not permanently unable to clean history: the failure is not
    // cached, only the success is.
    const matcher = await loader.publicSuffixMatcher();
    expect(matcher.registrableDomain('alice.github.io')).toBe('alice.github.io');
  });

  it('is not touched by a cold start', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('nothing may read the list at startup')));
    // Importing the module must not read anything — the list is loaded on the first lookup that
    // needs it, which is never on the path the 50 ms cold-start budget is measured along.
    await expect(freshLoader()).resolves.toBeDefined();
  });
});
