/**
 * Whether a history entry is *this bookmark's page* (ARCHITECTURE §12.6).
 *
 * The rest of history hygiene works at the granularity of a registrable domain, and deliberately:
 * "clear the sites in my vault" is a promise about sites, and a domain is the unit Chrome's
 * substring search can be made safe at (`domain.ts`). One bookmark at a time is a different
 * question, asked in a different place — the row that warns and the button beside it in the detail
 * pane both name one page — and answering it with the domain rule would offer to delete a site's
 * entire history under the title of a single bookmark.
 *
 * So this compares pages, and the whole difficulty is that two spellings of the same page are
 * routine:
 *
 * - **A stored URL is not always the visited one.** `stripTrackingParams` is on by default, so the
 *   vault holds `example.com/post` for a page whose history entry is `example.com/post?utm_source=x`.
 * - **Trailing slashes and fragments are noise.** `example.com/a`, `example.com/a/` and
 *   `example.com/a#top` are one page to a person and three strings to a computer.
 *
 * And the trap in the other direction: a query string is often the *identity* of the page.
 * `youtube.com/watch?v=a` and `youtube.com/watch?v=b` are two different videos, and a rule that
 * ignored the query would offer to forget one of them and delete both.
 *
 * The rule that follows from those three facts:
 *
 * 1. Compare origin, path and query, all normalized, ignoring the fragment.
 * 2. **Only when the bookmark itself carries no query**, also accept a history entry that differs
 *    from it by having one. That is exactly the tracking-parameter case, and it cannot fire on the
 *    YouTube case, because a bookmark of a specific video has a query of its own.
 *
 * Pure, and dependency-free like `domain.ts`: no `chrome.*`, no vault types. What it decides is used
 * to *offer* a deletion the user then confirms, never to widen an automatic one.
 */

/**
 * A URL reduced to the page it names, or `null` if it is not a URL we compare.
 *
 * Lowercased host, no fragment, no trailing slash on the path, and query parameters sorted — two
 * orderings of the same parameters are one page, and Chrome hands back whichever the link used.
 */
export function pageKeyOf(url: string): string | null {
  const parsed = parse(url);
  if (parsed === null) return null;
  return parsed.query === '' ? parsed.page : `${parsed.page}?${parsed.query}`;
}

/**
 * The same rule as {@link isSamePage}, asked of many entries at once.
 *
 * The presence scan asks "is this bookmark in history?" for every bookmark in the vault against
 * every history entry the domains turned up, and the pairwise form of that is a product of two
 * numbers that both grow with the vault. Two sets built once answer each bookmark in constant time,
 * and — the part worth checking — answer *identically*: the exact set is the rule's first clause and
 * the by-page set is its second.
 */
export function pageIndex(urls: Iterable<string>): PageIndex {
  const exact = new Set<string>();
  const anyQuery = new Set<string>();
  for (const url of urls) {
    const parsed = parse(url);
    if (parsed === null) continue;
    exact.add(parsed.query === '' ? parsed.page : `${parsed.page}?${parsed.query}`);
    anyQuery.add(parsed.page);
  }
  return {
    has: (itemUrl: string): boolean => {
      const item = parse(itemUrl);
      if (item === null) return false;
      // No query on the bookmark: any entry for the same page counts, which is the
      // stripped-tracking-parameter case. A query on the bookmark: it has to be that query.
      return item.query === '' ? anyQuery.has(item.page) : exact.has(`${item.page}?${item.query}`);
    },
  };
}

export interface PageIndex {
  /** Whether history holds an entry for the page this bookmark's URL names. */
  has(itemUrl: string): boolean;
}

/**
 * Whether `historyUrl` is an entry for the page `itemUrl` names.
 *
 * Not symmetric, and that is the point: the bookmark is the thing being asked about, so it is the
 * bookmark's lack of a query — never the history entry's — that widens the match.
 */
export function isSamePage(itemUrl: string, historyUrl: string): boolean {
  const item = parse(itemUrl);
  const entry = parse(historyUrl);
  if (item === null || entry === null) return false;
  if (item.page !== entry.page) return false;
  return item.query === '' || item.query === entry.query;
}

interface Parsed {
  /** Origin and path, normalized. Everything a comparison needs before the query. */
  readonly page: string;
  /** Sorted `key=value` pairs, or `''` when there are none. */
  readonly query: string;
}

function parse(url: string): Parsed | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // `URL` already lowercases the host and the scheme, and resolves `.` and `..` out of the path.
  const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/u, '') : '';
  const params = [...parsed.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    page: `${parsed.origin}${path}`,
    query: params.map(([key, value]) => `${key}=${value}`).join('&'),
  };
}
