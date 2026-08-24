/**
 * Loading the Public Suffix List, which ships as a package asset rather than as code.
 *
 * **Why it is not a bundled string any more.** The list is ~144 KB and the service worker may not
 * code-split (ARCHITECTURE §2: a worker that `import()`s will one day do it after being torn down),
 * so for four phases it sat inside `background.js` — 48 % of a file the worker parses every time
 * Chrome wakes it, roughly every 30 seconds. `scripts/check-budgets.mjs` measured the worker at
 * 327.7 KB of its 340 KB ceiling after 1.2.0, with 12 KB of headroom and one release costing 16 KB;
 * moving the list out is the change that was written down there as the way to get it back.
 *
 * **This is not a network fetch and does not touch INV-3 or INV-4.** `chrome.runtime.getURL` names
 * a file inside the installed package, `fetch` of it never leaves the machine, and the bytes are the
 * ones the user's own copy was installed with. What is forbidden is remote *data* deciding which
 * history entries get deleted — which is why `scripts/update-psl.mjs` is still a manual step whose
 * output is a reviewed diff, and why nothing here has a URL to fall back to.
 *
 * **A failure refuses rather than degrades.** If the asset cannot be read there is no "last two
 * labels" fallback, because that answer is wrong for `bbc.co.uk` and for `alice.github.io` in the
 * direction that deletes a stranger's history (§12.1). {@link PublicSuffixListError} propagates and
 * the operation does not happen.
 */

import { createDomainMatcher, type DomainMatcher, type PublicSuffixRules } from './domain.js';

/** The packaged file, copied verbatim into `dist/` from `public/` by Vite. */
export const PSL_ASSET = 'public-suffix-list.txt';

/**
 * A list that parsed to almost nothing means the asset is truncated or is not the list at all.
 *
 * The same floor `update-psl.mjs` applies when it writes the file: a hole here is not visible as a
 * crash, it is visible as a cleanup quietly treating `co.uk` as registrable.
 */
const MINIMUM_PLAIN_RULES = 1_000;

/** The asset was missing, unreadable, or did not look like the list. */
export class PublicSuffixListError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`The public suffix list could not be read: ${reason}`, options);
    this.name = new.target.name;
  }
}

/**
 * Parse the list's own rule syntax — the format publicsuffix.org publishes, minus the comments.
 *
 * Kept as the upstream syntax rather than three sections of our own so that the asset can be
 * diffed against the source it came from, and so this parser is the only thing that has to agree
 * with `update-psl.mjs`.
 */
export function parsePublicSuffixList(text: string): PublicSuffixRules {
  const plain = new Set<string>();
  const wildcard = new Set<string>();
  const exception = new Set<string>();

  for (const line of text.split('\n')) {
    const rule = line.trim();
    if (rule === '' || rule.startsWith('//')) continue;
    if (rule.startsWith('!')) exception.add(rule.slice(1));
    else if (rule.startsWith('*.')) wildcard.add(rule.slice(2));
    else plain.add(rule);
  }

  if (plain.size < MINIMUM_PLAIN_RULES) {
    throw new PublicSuffixListError(`only ${plain.size} rules parsed`);
  }
  return { plain, wildcard, exception };
}

/**
 * The matcher, built once per worker lifetime.
 *
 * Two things are cached rather than one: the promise, so concurrent callers share a single read
 * instead of racing two, and nothing at all on failure — a worker that failed once because the
 * read was interrupted should be allowed to try again rather than be permanently unable to clean
 * history. The worker dies every ~30 seconds anyway, so "per lifetime" is a short-lived cache by
 * construction, and the parse of ~10,000 rules costs a few milliseconds against a 50 ms cold-start
 * budget it is never on the path of: nothing loads this until someone asks to delete something.
 */
let pending: Promise<DomainMatcher> | null = null;

export function publicSuffixMatcher(): Promise<DomainMatcher> {
  pending ??= read().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

async function read(): Promise<DomainMatcher> {
  let text: string;
  try {
    const response = await fetch(chrome.runtime.getURL(PSL_ASSET));
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    text = await response.text();
  } catch (cause) {
    throw new PublicSuffixListError('the packaged asset could not be fetched', { cause });
  }
  return createDomainMatcher(parsePublicSuffixList(text));
}
