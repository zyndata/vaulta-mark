/**
 * How an extension page tells the service worker that it, and not another application, has the
 * keyboard focus.
 *
 * **This exists because Chrome's own focus signal cannot answer the question.** Measured
 * 2026-08-22 on Windows 10 against the real `dist/`, recording `chrome.windows.onFocusChanged` in
 * the worker:
 *
 * - Another *application* taking focus fires **no event at all**. `getLastFocused().focused`
 *   silently turns false and nothing wakes the worker to notice.
 * - Opening the toolbar popup **does** fire — the window's own id, then `WINDOW_ID_NONE` a
 *   millisecond later — and while that popup is open **no window is focused**. Chrome's window
 *   model does not contain the popup, so a popup with the user in front of it is byte-for-byte the
 *   same state as a browser the user has walked away from.
 * - `WINDOW_ID_NONE` also arrives at moments when a window *is* focused, such as restoring a
 *   minimised one.
 *
 * So the popup and the manager say so themselves. A page that holds the focus is the one piece of
 * evidence Chrome will not give the worker, and it is exactly the evidence that tells "the quick
 * menu is open" apart from "the user is in another program" (ARCHITECTURE §7.3).
 *
 * A port rather than a message, because the interesting event is the page **going away**: a popup
 * that is dismissed, or a tab that is closed, gets no chance to send anything, and
 * `port.onDisconnect` is Chrome telling the worker for it. It also carries the other direction —
 * the worker asking a page to say again whether it still holds the focus, which is how a claim that
 * went stale in silence is caught (minimising a window fires no `blur` inside it).
 */

/** The name every focus beacon connects under. The worker ignores ports named anything else. */
export const FOCUS_PORT = 'vm.focus';

/** The only thing a beacon ever says. */
export interface FocusReport {
  readonly focused: boolean;
}

export function isFocusReport(value: unknown): value is FocusReport {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FocusReport).focused === 'boolean'
  );
}

/**
 * How long to wait before trying again after a connect that found nothing on the other end, and the
 * ceiling it doubles towards. The first attempt is the common case — a page that Chrome reloaded a
 * few milliseconds ahead of the worker it belongs to — so it is short; the ceiling is what keeps a
 * genuinely unreachable worker from becoming a busy loop.
 */
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5_000;

/**
 * Start reporting this page's focus for as long as it is open.
 *
 * Called unconditionally by every extension page, whatever the auto-lock settings say: the worker
 * is the one that knows whether anybody cares, the cost of a port that nothing reads is a few bytes,
 * and a page that only reported when a setting was on would have to be told when the setting
 * changed.
 *
 * Returns a function that stops the beacon and closes its port. No page calls it — a page stops
 * reporting by ceasing to exist — but a test needs one, because a listener left on `window` outlives
 * the test that added it and would report into the next one's worker.
 *
 * The reconnect is the part worth reading twice, and it has two cases Chrome tells apart only
 * through `runtime.lastError`:
 *
 * - **The port opened and later dropped** — MV3 killing the worker, roughly every thirty seconds.
 *   A *focused* page whose claim has vanished is precisely the state that makes the worker lock a
 *   vault the user is looking at, so it reconnects at once, which starts a fresh worker and
 *   re-states the claim.
 * - **The port never opened at all** — `lastError` says "Could not establish connection. Receiving
 *   end does not exist", which is what a reload of an unpacked extension produces: Chrome reloads
 *   this page a few milliseconds before the new worker has registered `onConnect`. Reconnecting at
 *   once would spin, so it backs off. Retrying at all is the point: a page whose only connect
 *   failed is not in the worker's beacon set, so it can never be asked either, and it would be a
 *   focused window the worker is certain nobody is looking at.
 *
 * Either way `lastError` is *read*, because reading it is what marks it read — an unattended one
 * prints `Unchecked runtime.lastError` into the page's console.
 *
 * An unfocused page has no claim to make and waits until it is focused again.
 */
export function startFocusBeacon(): () => void {
  let port: chrome.runtime.Port | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let backoff = RETRY_BASE_MS;
  let stopped = false;

  const report = (): void => {
    if (port === null) {
      // Nothing to say and nowhere to say it: a page that is not focused has no claim to make, and
      // waking the worker to hear "still not me" is the waste MV3 exists to prevent.
      if (document.hasFocus()) connect();
      return;
    }
    try {
      port.postMessage({ focused: document.hasFocus() } satisfies FocusReport);
    } catch {
      // The worker went away between the check and the post. Reconnecting re-states the claim.
      port = null;
      connect();
    }
  };

  function cancelRetry(): void {
    if (retry === null) return;
    clearTimeout(retry);
    retry = null;
  }

  function scheduleRetry(): void {
    if (retry !== null) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, RETRY_MAX_MS);
    retry = setTimeout(() => {
      retry = null;
      if (!stopped && document.hasFocus()) connect();
    }, delay);
  }

  function connect(): void {
    if (stopped || port !== null) return;
    cancelRetry();
    let opened: chrome.runtime.Port;
    try {
      opened = chrome.runtime.connect({ name: FOCUS_PORT });
    } catch {
      // "Extension context invalidated": this page belongs to a version of the extension that no
      // longer exists, which happens to every open page when an unpacked build is reloaded. No
      // future connect can succeed, so there is nothing to retry for — the tab has to be reloaded.
      return;
    }
    port = opened;
    opened.onMessage.addListener(report);
    opened.onDisconnect.addListener(() => {
      // Read, not merely tested for: an unread `lastError` is the console line this exists to
      // avoid, and its presence is also the only way to tell a connection that never opened from a
      // worker that was torn down under an open one.
      const unreachable = chrome.runtime.lastError !== undefined;
      port = null;
      if (!unreachable) backoff = RETRY_BASE_MS;
      if (!document.hasFocus()) return;
      if (unreachable) scheduleRetry();
      else connect();
    });
    report();
  }

  window.addEventListener('focus', report);
  window.addEventListener('blur', report);
  // A tab that is hidden by a switch to another tab has lost the focus as surely as one that was
  // clicked out of, and Chrome does not always fire `blur` for it.
  document.addEventListener('visibilitychange', report);

  connect();

  return () => {
    stopped = true;
    cancelRetry();
    window.removeEventListener('focus', report);
    window.removeEventListener('blur', report);
    document.removeEventListener('visibilitychange', report);
    const open = port;
    port = null;
    open?.disconnect();
  };
}
