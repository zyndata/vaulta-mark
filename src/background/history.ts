/**
 * History hygiene, where it meets the vault (ARCHITECTURE §12).
 *
 * A vault stops URLs reaching the omnibox. It does not stop *history* reaching the omnibox, and a
 * page you visited before you vaulted it — or opened through the explicit normal-window fallback —
 * is still sitting in `chrome.history` autocompleting itself into the address bar. Closing that hole
 * is the whole of this file.
 *
 * Three rules it exists to keep:
 *
 * - **The domain set never leaves the device.** It is derived from the decrypted vault at the moment
 *   it is needed and thrown away with the function call. Nothing here writes a domain anywhere:
 *   `vm.historyQueue` is in `storage.session` for exactly this reason (`incognito.ts`), and the
 *   `clearHistoryOnLock` setting is a boolean rather than a list.
 * - **Only vaulted domains are deleted.** `chrome.history.search` is a substring match and would
 *   happily hand back somebody else's site; `history/cleanup.ts` re-derives the registrable domain of
 *   every result before it can be deleted. Quick-close is the one deliberate exception, and it says
 *   so on the tin.
 * - **Nothing here is automatic without an explicit opt-in.** The cleanup runs when someone presses
 *   the button, and on lock only if `clearHistoryOnLock` was switched on. The one thing that runs
 *   unasked is draining the queue of URLs the user *individually* ticked "clear this afterwards" for
 *   — which is not us deciding, it is us keeping a promise.
 */

import {
  HistoryPermissionError,
  deleteHistory,
  domainsOf,
  hasHistoryPermission,
  scanHistory,
} from '../history/cleanup.js';
import { registrableDomain, registrableDomainOf } from '../history/domain.js';
import { isSamePage, pageIndex } from '../history/match.js';
import type {
  CountResponse,
  HistoryPreviewResponse,
  HistoryPresenceResponse,
} from '../shared/messages.js';
import type { VaultRepository } from '../storage/repo.js';
import { isBookmark, type VaultSettings } from '../vault/types.js';
import { clearHistoryQueue, readHistoryQueue } from './incognito.js';
import { requireVault } from './items.js';
import * as session from './session.js';

/**
 * The distinct registrable domains of every live bookmark, in the order the vault yields them.
 *
 * Tombstones are already gone by the time `getAll` answers, which is the behaviour we want: a
 * bookmark deleted last week is not a domain the user is asking us to keep clean.
 */
export function vaultDomains(repo: VaultRepository): string[] {
  return domainsOf(
    repo
      .getAll()
      .filter(isBookmark)
      .map((item) => item.url),
  );
}

/**
 * What a cleanup would delete.
 *
 * An ungranted permission is a state the settings screen renders — with the button that asks for it
 * — rather than an error, the same way `nativeTree` handles `bookmarks`. Actually *running* without
 * the permission is a different matter and throws, because by then the user has pressed a button
 * that said it would delete something.
 */
export async function previewCleanup(): Promise<HistoryPreviewResponse> {
  const repo = await requireVault();
  await session.touch();
  if (!(await hasHistoryPermission())) {
    return { type: 'HISTORY_PREVIEW', granted: false, domains: [], searched: 0, entries: 0 };
  }

  const domains = vaultDomains(repo);
  const scan = await scanHistory(domains);
  return {
    type: 'HISTORY_PREVIEW',
    granted: true,
    domains: scan.domains,
    searched: domains.length,
    entries: scan.urls.length,
  };
}

/**
 * Delete the history entries belonging to vaulted domains.
 *
 * Re-scans rather than trusting a URL list the page held onto: the preview may be minutes old, the
 * worker may have been torn down and rebuilt since, and a stale list would either miss what has been
 * visited since or try to delete what has already gone. Both scans run the same code, so the numbers
 * only differ when the history actually differs.
 */
export async function runCleanup(): Promise<CountResponse> {
  const repo = await requireVault();
  await session.touch();
  if (!(await hasHistoryPermission())) throw new HistoryPermissionError('clearing history');

  const scan = await scanHistory(vaultDomains(repo));
  return { type: 'COUNT', count: await deleteHistory(scan.urls) };
}

/* ------------------------------------------------------------------ one bookmark at a time */

/**
 * Which vaulted bookmarks are still in Chrome's history (§12.6).
 *
 * The cleanup answers "what would go" as a list of sites; this answers the same question as a list
 * of *bookmarks*, which is what the manager can point at. A row that carries the warning is a page
 * whose address the omnibox can still suggest, which is the one thing vaulting it was supposed to
 * stop — and until now nothing said so anywhere the user was looking.
 *
 * One scan for the whole vault rather than one query per bookmark: `chrome.history.search` is an
 * IPC round trip, and a query per row would be five thousand of them on a large vault to draw an
 * icon. It is the same scan the dry run does, and the matching afterwards is two set lookups per
 * bookmark (`history/match.ts`).
 *
 * Ungranted is a state rather than an error, like {@link previewCleanup}: the manager simply draws
 * no warnings, because without the permission there is nothing it could truthfully draw.
 */
export async function historyPresence(): Promise<HistoryPresenceResponse> {
  const repo = await requireVault();
  await session.touch();
  if (!(await hasHistoryPermission())) {
    return { type: 'HISTORY_PRESENCE', granted: false, ids: [] };
  }

  const bookmarks = repo.getAll().filter(isBookmark);
  const scan = await scanHistory(domainsOf(bookmarks.map((item) => item.url)));
  const index = pageIndex(scan.urls);
  return {
    type: 'HISTORY_PRESENCE',
    granted: true,
    ids: bookmarks.filter((item) => index.has(item.url)).map((item) => item.id),
  };
}

/**
 * Delete the history entries for **one** bookmark's page.
 *
 * Scoped to the page rather than to the site, which is the whole difference between this and the
 * cleanup beside it: this is offered under one bookmark's title, in the pane that shows that one
 * bookmark, so deleting a domain's worth of unrelated history from there would be an ambush. The
 * per-page rule and why it is not a string comparison are in `history/match.ts`.
 *
 * The domain search is only how the candidates are *found* — `search` over-matches and everything it
 * returns is re-checked, first that it belongs to the domain (`scanHistory`) and then that it is
 * this page (`isSamePage`).
 */
export async function forgetItemHistory(id: string): Promise<CountResponse> {
  const repo = await requireVault();
  await session.touch();
  if (!(await hasHistoryPermission())) throw new HistoryPermissionError('clearing history');

  const item = repo.getAll().find((candidate) => candidate.id === id);
  if (item === undefined || !isBookmark(item)) return { type: 'COUNT', count: 0 };

  const domain = registrableDomainOf(item.url);
  if (domain === null) return { type: 'COUNT', count: 0 };

  const scan = await scanHistory([domain]);
  const mine = scan.urls.filter((url) => isSamePage(item.url, url));
  return { type: 'COUNT', count: await deleteHistory(mine) };
}

/* ------------------------------------------------------------------ the lock path */

/**
 * Called while the vault is still open, just before the key is dropped.
 *
 * Two jobs, in order of how much they were asked for:
 *
 * 1. **Drain `vm.historyQueue`** — the hosts of URLs the user opened in a normal window having
 *    ticked "clear this domain's history afterwards" in the guided prompt. That tick is a promise
 *    about specific pages, so it is kept whatever the settings say. The queue lives in
 *    `storage.session` and is about to be wiped by the lock either way, so this is its last chance.
 * 2. **`clearHistoryOnLock`** — the whole vault's domains, if that setting is on.
 *
 * Never throws. A lock that failed because a history deletion failed would leave the key in memory,
 * which is a far worse outcome than an uncleaned history entry.
 */
export async function cleanOnLock(repo: VaultRepository, settings: VaultSettings): Promise<void> {
  try {
    if (!(await hasHistoryPermission())) return;

    const queued = await readHistoryQueue();
    const domains = new Set<string>();
    for (const host of queued) {
      const domain = registrableDomain(host);
      if (domain !== null) domains.add(domain);
    }
    if (settings.clearHistoryOnLock) {
      for (const domain of vaultDomains(repo)) domains.add(domain);
    }
    if (domains.size === 0) return;

    const scan = await scanHistory([...domains]);
    await deleteHistory(scan.urls);
  } catch {
    // Nothing is logged, and nothing propagates: the context carries hostnames, which are vault
    // content, and the caller is `session.lock()`, which must finish.
  } finally {
    await clearHistoryQueue();
  }
}

/* ------------------------------------------------------------------ quick-close */

export type QuickCloseOutcome =
  /** The tab is gone and its domain's history with it. */
  | 'closed'
  /** The setting is off. Nothing happened, and nothing is reported — it is not an error. */
  | 'disabled'
  /** The setting is on but the permission is not granted, or there was no tab to close. */
  | 'refused';

/**
 * Close the active tab and delete that domain's history (§12.3).
 *
 * Deliberately **not** limited to vaulted domains: the point of the keystroke is "get this off my
 * screen and out of my history", and a version that only cleaned pages already in the vault would
 * silently do nothing on exactly the page someone reached for it on. The settings copy says so in
 * as many words, which is why it is off by default and behind its own toggle.
 *
 * The history is deleted *before* the tab is closed. Closing first would be more satisfying and
 * would also race: Chrome writes the visit as the tab tears down, and a deletion that ran first
 * would leave the entry it was aimed at.
 */
export async function quickClose(): Promise<QuickCloseOutcome> {
  const settings = await session.settings();
  if (!settings.quickClose) return 'disabled';
  if (!(await hasHistoryPermission())) return 'refused';

  // The keystroke is the gesture that grants `activeTab` for the tab in front of the user, which is
  // why this can read a URL with no host permission (D25).
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url;
  const tabId = tab?.id;
  if (url === undefined || tabId === undefined) return 'refused';

  const domain = registrableDomain(new URL(url).hostname);
  if (domain === null) return 'refused';

  const scan = await scanHistory([domain]);
  await deleteHistory(scan.urls);
  await chrome.tabs.remove(tabId);
  return 'closed';
}
