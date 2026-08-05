/**
 * Opening a vaulted link, which VaultaMark does in incognito or explains why it cannot
 * (ARCHITECTURE §9).
 *
 * Incognito-only opening is half the product: a vaulted URL that is opened in a normal window lands
 * in history, in the omnibox's prediction data, and in whatever else the profile records — which is
 * the exact leak the vault exists to prevent. So the default path is an incognito window, the
 * fallback is a normal one, and the fallback is never taken without the user choosing it.
 *
 * The awkward part is that **there is no API to request incognito access.** `"Allow in Incognito"`
 * is a checkbox on `chrome://extensions`, an extension cannot navigate there, and Chrome offers no
 * permission prompt for it. All we can do is detect the state, explain it, hand over the URL to
 * paste, and offer a Re-check button — which is what the guided prompt in `ui/incognito-prompt.ts`
 * does.
 *
 * `incognito: "spanning"` in the manifest (D29) is what makes any of this work: one service worker
 * across normal and incognito windows, so the vault the user just unlocked is still unlocked in the
 * window we open. Under `"split"` the incognito side would be a second, separately-locked instance.
 */

import type { OpenStatus } from '../shared/messages.js';

/**
 * The last `isAllowedIncognitoAccess()` answer, for this worker's lifetime.
 *
 * "Cached per session" in §9 means exactly this much: MV3 tears the worker down after ~30 seconds
 * of idle, so the cache is short-lived and self-healing by construction. That is a feature — the
 * one event that would invalidate it, the user flipping the toggle, is followed either by a new
 * worker or by the Re-check button, and observing it properly would mean the `management`
 * permission, which is not worth an install-time warning for a checkbox we can re-read for free.
 */
let cachedAccess: boolean | null = null;

/** Whether "Allow in Incognito" is on. `recheck` skips the cache — the Re-check button's path. */
export async function isAllowedIncognitoAccess(recheck = false): Promise<boolean> {
  if (!recheck && cachedAccess !== null) return cachedAccess;
  const allowed = await chrome.extension.isAllowedIncognitoAccess();
  cachedAccess = allowed;
  return allowed;
}

/** Drop the cached answer. Called on lock, so a fresh session never inherits a stale one. */
export function forgetIncognitoAccess(): void {
  cachedAccess = null;
}

/** `chrome://extensions/?id=<our id>` — the page the user has to open by hand. */
export function extensionSettingsUrl(): string {
  return `chrome://extensions/?id=${chrome.runtime.id}`;
}

export interface OpenOptions {
  /** Reuse an open incognito window instead of creating one. From `reuseIncognitoWindow`. */
  readonly reuseWindow?: boolean;
  /** Open in a normal window even though incognito access is off. An explicit user choice only. */
  readonly force?: boolean;
}

/**
 * Open a URL the way §9 specifies.
 *
 * Returns rather than throws for the "not allowed" case: it is not a failure, it is the state the
 * UI has a whole screen for.
 */
export async function openVaulted(url: string, options: OpenOptions = {}): Promise<OpenStatus> {
  if (await isAllowedIncognitoAccess()) {
    if (options.reuseWindow === true) {
      const existing = await findIncognitoWindow();
      if (existing !== undefined) {
        await chrome.tabs.create({ windowId: existing, url, active: true });
        await focusWindow(existing);
        return 'incognito';
      }
    }
    await chrome.windows.create({ incognito: true, url, focused: true });
    return 'incognito';
  }

  if (options.force !== true) return 'needs-incognito-access';
  // The user was told, in the guided prompt, that this visit is recorded in history.
  await chrome.windows.create({ url, focused: true });
  return 'normal';
}

/* ------------------------------------------------------------------ the history queue */

/**
 * Hosts the user asked to clear from history after a normal-window fallback.
 *
 * In `chrome.storage.session`, not `storage.local`, and this is not an implementation detail: the
 * host of a vaulted URL *is* vault content, and INV-6 says vault content never reaches disk in the
 * clear. `storage.session` is memory-backed, restricted to trusted contexts, and emptied by
 * `session.lock()` along with the key — so a queued host lives exactly as long as the unlocked
 * session that produced it, and never longer. The cost is that locking before Phase 9 drains the
 * queue drops it, which is the right way round to be wrong.
 */
export const HISTORY_QUEUE_KEY = 'vm.historyQueue';

/** Queue a URL's host for the history cleanup Phase 9 performs. Duplicates collapse. */
export async function queueHistoryCleanup(url: string): Promise<void> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  if (host === '') return;
  const queued = new Set(await readHistoryQueue());
  if (queued.has(host)) return;
  queued.add(host);
  await chrome.storage.session.set({ [HISTORY_QUEUE_KEY]: [...queued] });
}

/** The queued hosts. `background/history.ts` drains this; anything malformed reads as empty. */
export async function readHistoryQueue(): Promise<readonly string[]> {
  const raw = (await chrome.storage.session.get(HISTORY_QUEUE_KEY))[HISTORY_QUEUE_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Forget the queue.
 *
 * Called once the cleanup on lock has had its turn (`background/history.ts`). The lock clears the
 * whole session area a moment later anyway; doing it explicitly here is what makes the drain
 * one-shot rather than "whatever survived", including on the path where the permission was never
 * granted and there was nothing to drain it *with*.
 */
export async function clearHistoryQueue(): Promise<void> {
  await chrome.storage.session.remove(HISTORY_QUEUE_KEY);
}

/* ------------------------------------------------------------------ windows */

/** The id of an open incognito window, if there is one. Normal windows and popups are skipped. */
async function findIncognitoWindow(): Promise<number | undefined> {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  return windows.find((window) => window.incognito)?.id;
}

/**
 * Bring the reused window forward.
 *
 * Best-effort: a window that vanished between `getAll` and here is a race, not an error, and the
 * tab was created before this ran either way.
 */
async function focusWindow(windowId: number): Promise<void> {
  try {
    await chrome.windows.update(windowId, { focused: true });
  } catch {
    // Nothing to do and nothing to report — the tab is open.
  }
}
