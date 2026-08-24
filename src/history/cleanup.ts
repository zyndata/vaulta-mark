/**
 * The `chrome.history` half of history hygiene (ARCHITECTURE §12.2).
 *
 * Kept apart from `background/history.ts` for the same reason `import/native-bookmarks.ts` is kept
 * apart from `background/io.ts`: this file knows about Chrome's history and about registrable
 * domains and about nothing else, so it can be tested against a mocked API without a vault, a key or
 * a session — and so the module that *does* hold the key never has to think about `search`'s
 * matching rules.
 *
 * The one rule that matters here: **`chrome.history.search` over-matches.** It is a substring search
 * over URL and title, so asking it for `example.com` answers with `notexample.community`, with
 * `evil.com/?ref=example.com`, and with a blog post whose *title* mentions the domain. Every result
 * is therefore re-checked with the domain matcher's `urlBelongsTo` before it can reach
 * `deleteUrl`. Nothing in this file deletes a URL it has not re-derived the registrable domain of.
 */

import { publicSuffixMatcher } from './public-suffix.js';

/** The optional permission this needs. Requested in context, never at install (D26). */
export const HISTORY_PERMISSION = 'history';

/**
 * Something that needed `chrome.history` ran without the permission.
 *
 * Beside the reader rather than in `vault/errors.ts`, mirroring `BookmarksPermissionError`: a
 * permission the profile has not granted is a fact about the browser, not about the vault.
 */
export class HistoryPermissionError extends Error {
  constructor(operation: string, options?: ErrorOptions) {
    super(`The "history" permission has not been granted; ${operation} requires it.`, options);
    this.name = new.target.name;
  }
}

/**
 * `maxResults: 0` is Chrome's "no limit".
 *
 * Worth spelling out because it reads like a bug: `QueryOptions::max_count` defaults to 0 meaning
 * unbounded, and the extension API only overrides it when `maxResults` is truthy. A cleanup that
 * silently stopped at Chrome's 100-result default would report an accurate-looking dry run and then
 * leave most of the history it promised to remove.
 */
const NO_LIMIT = 0;

/** From the beginning of the profile's history. */
const FROM_THE_BEGINNING = 0;

/** Whether the profile has already granted `history`. Safe to call from anywhere. */
export async function hasHistoryPermission(): Promise<boolean> {
  return await chrome.permissions.contains({ permissions: [HISTORY_PERMISSION] });
}

/**
 * Ask for the `history` permission.
 *
 * **Must be called from a page, during a user gesture** — Chrome refuses `permissions.request` from
 * a service worker outright. The explaining is the UI's job and the reading is the worker's, so the
 * request itself sits here between them.
 */
export async function requestHistoryPermission(): Promise<boolean> {
  return await chrome.permissions.request({ permissions: [HISTORY_PERMISSION] });
}

/**
 * Give the permission back.
 *
 * Offered beside the cleanup because read-and-delete access to someone's entire browsing history is
 * not something an extension should hold between the two minutes a year it is used.
 */
export async function dropHistoryPermission(): Promise<boolean> {
  return await chrome.permissions.remove({ permissions: [HISTORY_PERMISSION] });
}

/** What one vaulted domain has in history. */
export interface DomainMatches {
  readonly domain: string;
  readonly entries: number;
}

export interface HistoryScan {
  /** Per-domain counts, in the order the domains were given, minus the ones with nothing. */
  readonly domains: readonly DomainMatches[];
  /** Every matching URL, deduplicated across domains. This is exactly what a run would delete. */
  readonly urls: readonly string[];
}

/**
 * Find the history entries belonging to these registrable domains. Reads; deletes nothing.
 *
 * The dry run and the execution share this function rather than each doing their own search, which
 * is what makes "this will remove 143 entries" and "removed 143 entries" the same number for the
 * same reason instead of by coincidence.
 *
 * Deduplicated across domains because `search` is a substring match: one URL can be returned by two
 * different queries, and counting it twice would overstate the dry run and double-delete on the way
 * out.
 */
export async function scanHistory(domains: readonly string[]): Promise<HistoryScan> {
  // Read once, before the loop: the list is a packaged asset now, and the re-check below runs per
  // history result rather than per domain (`history/public-suffix.ts`).
  const psl = await publicSuffixMatcher();
  const seen = new Set<string>();
  const counts: DomainMatches[] = [];

  for (const domain of domains) {
    const results = await chrome.history.search({
      text: domain,
      maxResults: NO_LIMIT,
      startTime: FROM_THE_BEGINNING,
    });

    let entries = 0;
    for (const item of results) {
      const url = item.url;
      // A history item without a URL is not something we could delete, and Chrome types it as
      // optional. The `belongs to this domain` check is the one that matters.
      if (url === undefined || !psl.urlBelongsTo(url, domain)) continue;
      entries++;
      seen.add(url);
    }
    if (entries > 0) counts.push({ domain, entries });
  }

  return { domains: counts, urls: [...seen] };
}

/**
 * Delete exactly these URLs.
 *
 * Takes a URL list rather than a domain list on purpose: the thing that decided a URL is in scope is
 * {@link scanHistory}, and a second function that re-derived the scope would be a second place for
 * the two to disagree. Returns how many deletions Chrome accepted.
 */
export async function deleteHistory(urls: readonly string[]): Promise<number> {
  let removed = 0;
  for (const url of urls) {
    try {
      await chrome.history.deleteUrl({ url });
      removed++;
    } catch {
      // A URL Chrome will not delete (it was already gone, or it is not a form `deleteUrl` accepts)
      // is not a reason to abandon the rest of the batch. Nothing is logged: the URL is vault
      // content.
    }
  }
  return removed;
}

