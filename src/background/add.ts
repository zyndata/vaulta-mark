/**
 * Putting a page into the vault — the pipeline behind all four add entry points (D25).
 *
 * The toolbar popup, the two context-menu entries and the keyboard shortcut are four gestures onto
 * one function. That is not tidiness: each of them is a *user gesture on the active tab*, which is
 * precisely what makes `activeTab` grant us that tab's URL and title. It is why VaultaMark asks for
 * no host permission at install time, and why a fifth entry point that is not a gesture would
 * quietly need one.
 *
 * What happens to a URL on the way in:
 *
 * 1. **Refused, or accepted.** `chrome://`, our own pages, `about:`, `file://` and the long tail of
 *    schemes whose "bookmark" is a payload rather than a destination are rejected with a reason the
 *    UI can explain. A vault entry that cannot be reopened later is worse than a refusal now.
 * 2. **Normalized** by `vault/model.ts` (§3.5), plus the tracking-parameter strip, which is **on by
 *    default**: every parameter in the list below is a campaign or click identifier that no site
 *    resolves a page by, and leaving them on makes the same article saved from two newsletters look
 *    like two different bookmarks.
 * 3. **Checked against what is already there** by `duplicateKeyOf` — same page, different fragment
 *    or query order, counts as the same page. A duplicate is not an error: the answer is "you
 *    already have this, want to open it?", which the caller gets as `status: 'duplicate'`.
 */

import type { ItemSummary } from '../shared/messages.js';
import { UnsupportedUrlError } from '../vault/errors.js';
import { duplicateKeyOf, normalizeUrl, withoutTrackingParams } from '../vault/model.js';
import { hasPreview, isBookmark, isDeleted, type Bookmark, type VaultItem } from '../vault/types.js';
import type { VaultRepository } from '../storage/repo.js';

/**
 * Schemes a bookmark may have.
 *
 * An allowlist rather than a denylist of the four schemes PLAN §5 names, because the failure modes
 * differ in kind: forgetting to ban a scheme means storing something unopenable at best and a
 * `javascript:` payload at worst, while forgetting to allow one means a user has to tell us about a
 * scheme we then add. Only the second of those is recoverable.
 */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ftp:', 'ftps:']);

/** Browser-internal pages: ours, Chrome's, and the equivalents in other Chromium builds. */
const INTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'chrome-search:',
  'chrome-native:',
  'devtools:',
  'view-source:',
  'about:',
  'edge:',
  'brave:',
  'opera:',
  'vivaldi:',
  'moz-extension:',
]);

export interface AddOptions {
  /** From `VaultSettings.stripTrackingParams`. On by default (§3.5). */
  readonly stripTrackingParams?: boolean;
  readonly parentId?: string;
}

export interface AddResult {
  readonly status: 'added' | 'duplicate';
  readonly item: ItemSummary;
}

/** What the active tab told us. Separated out so the pipeline is testable without a `chrome`. */
export interface TabInfo {
  readonly url: string;
  readonly title?: string;
}

/* ------------------------------------------------------------------ URL policy */

/**
 * Reject a URL we will not store, or return it normalized.
 *
 * Unparseable input is refused rather than kept verbatim. `normalizeUrl` keeps what it cannot parse
 * because a *stored* bookmark should come back exactly as it was saved, but a string arriving from
 * a tab that `URL` cannot parse has no scheme we could have checked, and letting it through would
 * be an allowlist with a hole in it.
 */
export function vaultableUrl(raw: string, options: AddOptions = {}): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UnsupportedUrlError('unsupported-scheme');
  }

  const scheme = parsed.protocol.toLowerCase();
  if (INTERNAL_SCHEMES.has(scheme)) throw new UnsupportedUrlError('internal-page');
  if (scheme === 'file:') throw new UnsupportedUrlError('local-file');
  if (!ALLOWED_SCHEMES.has(scheme)) throw new UnsupportedUrlError('unsupported-scheme');

  return normalizeUrl(
    options.stripTrackingParams === true ? withoutTrackingParams(parsed) : parsed.href,
  );
}

/**
 * A title for a page that did not give us one.
 *
 * The host, not the whole URL: a row reading `https://example.com/a/b/c?d=e` is unreadable at popup
 * width, and the URL is on the row underneath anyway.
 */
export function titleFor(url: string, title: string | undefined): string {
  const trimmed = title?.trim() ?? '';
  if (trimmed !== '') return trimmed;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ the pipeline */

/** The already-vaulted bookmark for this URL, or `undefined`. Tombstones do not count. */
export function findDuplicate(items: Iterable<VaultItem>, url: string): Bookmark | undefined {
  const key = duplicateKeyOf(url);
  for (const item of items) {
    if (!isBookmark(item) || isDeleted(item)) continue;
    if (duplicateKeyOf(item.url) === key) return item;
  }
  return undefined;
}

/** The projection the UI gets. Built here so every path answers with the same shape. */
export function summarize(item: Bookmark): ItemSummary {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    createdAt: item.createdAt,
    ...(item.openedAt === undefined ? {} : { openedAt: item.openedAt }),
    hasPreview: hasPreview(item),
  };
}

/**
 * Vault one URL.
 *
 * Takes the repository rather than reaching for the session itself, so the whole pipeline can be
 * tested against a repository with no service worker around it.
 */
export async function addUrl(
  repo: VaultRepository,
  tab: TabInfo,
  options: AddOptions = {},
): Promise<AddResult> {
  const url = vaultableUrl(tab.url, options);

  const existing = findDuplicate(repo.getAll(), url);
  if (existing !== undefined) return { status: 'duplicate', item: summarize(existing) };

  const changed = await repo.apply([
    {
      kind: 'add',
      input: {
        type: 'bookmark',
        url,
        title: titleFor(url, tab.title),
        ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
      },
    },
  ]);
  const added = changed[0];
  if (added === undefined || !isBookmark(added)) {
    // `apply` returns the items it changed, and an `add` mutation always changes exactly one. If
    // that ever stops being true, failing here is better than answering with someone else's item.
    throw new Error('Adding a bookmark produced no bookmark.');
  }
  // Written now rather than 300 ms from now: the service worker may well be torn down before the
  // coalescing timer fires, and an add the user watched succeed must not evaporate.
  await repo.flush();
  return { status: 'added', item: summarize(added) };
}

/**
 * Vault the active tab.
 *
 * `lastFocusedWindow` rather than `currentWindow`: a service worker has no window of its own, and
 * "current" resolves to the last focused one anyway — naming it is the honest spelling.
 */
export async function addActiveTab(
  repo: VaultRepository,
  options: AddOptions = {},
): Promise<AddResult> {
  const tab = await activeTab();
  return await addUrl(repo, tab, options);
}

/** The active tab's URL and title, or `NoActiveTabError` if `activeTab` gave us neither. */
export async function activeTab(): Promise<TabInfo> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const url = tab?.url;
  // An empty or absent URL is the shape of "the `activeTab` grant did not reach this tab" — which
  // happens when the gesture was not on the tab we just asked about.
  if (tab === undefined || url === undefined || url === '') throw new NoActiveTabError();
  return { url, ...(tab.title === undefined ? {} : { title: tab.title }) };
}

/** No tab to read, or `activeTab` did not grant us its URL. */
export class NoActiveTabError extends Error {
  constructor() {
    super('There is no active tab whose URL this extension may read.');
    this.name = 'NoActiveTabError';
  }
}
