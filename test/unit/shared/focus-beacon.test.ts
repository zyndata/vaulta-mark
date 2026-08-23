/**
 * @vitest-environment jsdom
 *
 * The page half of the focus signal. What the worker does with it is `background/autolock.ts`.
 *
 * jsdom rather than the default environment because the whole module is about `document.hasFocus()`
 * and the two window events around it — there is nothing here to test without a document.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FOCUS_PORT, isFocusReport, startFocusBeacon } from '../../../src/shared/focus-beacon.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

/**
 * Beacons started by the test that is running, stopped on the way out.
 *
 * jsdom keeps one `window` for the whole file, so a beacon left listening would report into the
 * next test's worker — the reports are per-mock, but the listeners are not.
 */
const running: (() => void)[] = [];

function start(): void {
  running.push(startFocusBeacon());
}

/**
 * The worker's side: every port that connected under our name, and everything it said.
 *
 * `die()` is the MV3 teardown as Chrome performs it — the worker's end of every port drops, the
 * page is told, and the instance that takes over has its listeners registered by the time the page
 * reconnects. Modelling it as "the listeners are still there" is what makes the restart observable
 * at all: a mock cannot register the next worker's listeners in the microsecond the page reconnects.
 */
function listen(): {
  reports: { name: string; focused: unknown }[];
  die: () => void;
} {
  const reports: { name: string; focused: unknown }[] = [];
  const ports: chrome.runtime.Port[] = [];
  chrome.runtime.onConnect.addListener((port) => {
    ports.push(port);
    port.onMessage.addListener((raw: unknown) => {
      reports.push({ name: port.name, focused: (raw as { focused: unknown }).focused });
    });
  });
  return {
    reports,
    die: () => {
      for (const port of ports.splice(0)) port.disconnect();
    },
  };
}

function focus(has: boolean): void {
  vi.spyOn(document, 'hasFocus').mockReturnValue(has);
}

beforeEach(() => {
  installChromeMock();
});

afterEach(() => {
  // The beacons first: a pending retry timer belongs to the beacon that scheduled it, and clearing
  // it is what `stop()` does.
  while (running.length > 0) running.pop()?.();
  vi.useRealTimers();
  uninstallChromeMock();
  vi.restoreAllMocks();
});

describe('isFocusReport', () => {
  it('accepts only the one shape it is meant to', () => {
    expect(isFocusReport({ focused: true })).toBe(true);
    expect(isFocusReport({ focused: false })).toBe(true);
    // Everything arriving over a port is untrusted, including from a page we wrote.
    expect(isFocusReport({ focused: 'yes' })).toBe(false);
    expect(isFocusReport({})).toBe(false);
    expect(isFocusReport(null)).toBe(false);
    expect(isFocusReport('focused')).toBe(false);
  });
});

describe('startFocusBeacon', () => {
  it('says at once whether it holds the focus, under the name the worker listens for', () => {
    const worker = listen();
    focus(true);

    start();

    expect(worker.reports).toEqual([{ name: FOCUS_PORT, focused: true }]);
  });

  it('says so when the focus arrives and when it leaves', () => {
    const worker = listen();
    focus(false);
    start();

    focus(true);
    window.dispatchEvent(new Event('focus'));
    focus(false);
    window.dispatchEvent(new Event('blur'));

    expect(worker.reports.map((report) => report.focused)).toEqual([false, true, false]);
  });

  /*
   * The reason this is a port and not a message, and the reason a focused page reconnects.
   *
   * MV3 tears the worker down roughly every thirty seconds, taking every port — and every claim —
   * with it. A page that holds the focus and does not say so again is exactly the state that makes
   * the worker lock a vault the user is looking at.
   */
  it('reconnects and re-states its claim when the worker dies under it', () => {
    const worker = listen();
    focus(true);
    start();

    worker.die();

    expect(worker.reports).toEqual([
      { name: FOCUS_PORT, focused: true },
      { name: FOCUS_PORT, focused: true },
    ]);
  });

  it('does not reconnect a page that has nothing to claim', () => {
    const worker = listen();
    focus(false);
    start();

    worker.die();
    window.dispatchEvent(new Event('blur'));

    // A background tab whose port died stays quiet until it is focused again: it has no claim to
    // restate, and keeping the worker alive to say "still not me" is exactly the waste MV3 exists
    // to prevent.
    expect(worker.reports).toEqual([{ name: FOCUS_PORT, focused: false }]);
  });

  it('reconnects when the focus comes back to a page whose port had died', () => {
    const worker = listen();
    focus(false);
    start();
    worker.die();

    focus(true);
    window.dispatchEvent(new Event('focus'));

    expect(worker.reports).toEqual([
      { name: FOCUS_PORT, focused: false },
      { name: FOCUS_PORT, focused: true },
    ]);
  });

  /*
   * The console line this file was extended for: `Unchecked runtime.lastError: Could not establish
   * connection. Receiving end does not exist`, reported from manager.html after a reload of the
   * unpacked build. Chrome reloads the open extension pages a few milliseconds before the new
   * worker has registered `onConnect`, so the page's one connect finds nothing.
   */
  it('retries a connect that found no worker, and states its claim once one is there', async () => {
    vi.useFakeTimers();
    focus(true);
    start();

    // Nothing has listened yet: the connect comes back and drops with `lastError` set.
    await vi.advanceTimersByTimeAsync(0);
    const worker = listen();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(worker.reports).toEqual([{ name: FOCUS_PORT, focused: true }]);
  });

  it('backs off rather than spinning while nothing answers', async () => {
    vi.useFakeTimers();
    const attempts = vi.spyOn(chrome.runtime, 'connect');
    focus(true);
    start();

    await vi.advanceTimersByTimeAsync(0);
    const afterFirstFailure = attempts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    // Ten seconds of an unreachable worker is a handful of attempts, not a task per frame. The
    // exact count is the backoff schedule's business; what matters is that it is bounded.
    expect(afterFirstFailure).toBe(1);
    expect(attempts.mock.calls.length).toBeLessThan(10);
  });

  it('does not retry for a page that has no claim to make', async () => {
    vi.useFakeTimers();
    const attempts = vi.spyOn(chrome.runtime, 'connect');
    focus(false);
    start();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(attempts.mock.calls.length).toBe(1);
  });

  it('reports a tab that was switched away from, which fires no blur of its own', () => {
    const worker = listen();
    focus(true);
    start();

    focus(false);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(worker.reports.map((report) => report.focused)).toEqual([true, false]);
  });
});
