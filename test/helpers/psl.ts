/**
 * The Public Suffix List, for tests that reach code which loads it.
 *
 * The list stopped being a bundled string in the worker and became a package asset read with
 * `fetch(chrome.runtime.getURL(…))` (src/history/public-suffix.ts). That is one `fetch` a unit test
 * has to answer, and answering it with a hand-written stub list would be the wrong kind of cheap:
 * `bbc.co.uk` and `alice.github.io` are the cases the whole file exists for, and a fixture that
 * omits them tests a different product. So this reads the real asset off disk — the same bytes Vite
 * copies into `dist/` — and serves them.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { vi } from 'vitest';

import { createDomainMatcher, type DomainMatcher } from '../../src/history/domain.js';
import { PSL_ASSET, parsePublicSuffixList } from '../../src/history/public-suffix.js';

const ASSET = fileURLToPath(new URL(`../../public/${PSL_ASSET}`, import.meta.url));

let text: string | null = null;

/** The shipped list, read once per test process. */
export async function publicSuffixText(): Promise<string> {
  text ??= await readFile(ASSET, 'utf8');
  return text;
}

/** A matcher over the real list, for tests that want the pure half without the loading. */
export async function realDomainMatcher(): Promise<DomainMatcher> {
  return createDomainMatcher(parsePublicSuffixList(await publicSuffixText()));
}

/**
 * Answer the asset's `fetch` with the real file, and nothing else's.
 *
 * A stub that answered every URL would hide the day some other code starts fetching: this one
 * throws on anything but the list, which in a unit test means the same as "there is no network".
 */
export async function stubPublicSuffixAsset(): Promise<void> {
  const body = await publicSuffixText();
  vi.stubGlobal('fetch', (input: string) => {
    if (!input.endsWith(PSL_ASSET)) {
      return Promise.reject(new Error(`unexpected fetch: ${input}`));
    }
    return Promise.resolve(new Response(body, { status: 200 }));
  });
}
