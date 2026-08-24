import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTOLOCK_ALARM,
  BLUR_SETTLE_MS,
  FOCUS_WATCH_ALARM,
  FOCUS_WATCH_PERIOD_MINUTES,
  HOUSEKEEPING_ALARM,
  HOUSEKEEPING_PERIOD_MINUTES,
  MIN_ALARM_DELAY_MINUTES,
  NEVER_EXPIRES,
  applyIdleDetection,
  armAutolock,
  armFocusWatch,
  armHousekeeping,
  clearAutolock,
  clearFocusWatch,
  deadlineFrom,
  handleAlarm,
  locksOnSystemIdle,
  neverExpires,
  registerLifecycleListeners,
  sampleFocus,
  type LifecycleDeps,
} from '../../../src/background/autolock.js';
import { FOCUS_PORT } from '../../../src/shared/focus-beacon.js';
import { DEFAULT_SETTINGS, type VaultSettings } from '../../../src/vault/types.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

const NOW = 1_750_000_000_000;

let mock: ChromeMock;

function settings(patch: Partial<VaultSettings> = {}): VaultSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

/**
 * The window an open session belongs to, as `session.ts` would remember it.
 *
 * A `let` rather than a stub returning a constant, because two of the tests below are about the
 * value being written: a session that has no window recorded adopts the one it finds.
 */
let heldWindow: number | null = null;

function deps(override: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    enforceDeadline: vi.fn(() => Promise.resolve()),
    housekeep: vi.fn(() => Promise.resolve()),
    wake: vi.fn(() => Promise.resolve()),
    lock: vi.fn(() => Promise.resolve()),
    settings: vi.fn(() => Promise.resolve(DEFAULT_SETTINGS)),
    unlocked: vi.fn(() => Promise.resolve(true)),
    focusHolder: vi.fn(() => Promise.resolve(heldWindow)),
    rememberFocusHolder: vi.fn((windowId: number) => {
      heldWindow = windowId;
      return Promise.resolve();
    }),
    ...override,
  };
}

beforeEach(() => {
  mock = installChromeMock({ grantedPermissions: ['idle'] });
  heldWindow = null;
});

afterEach(() => {
  uninstallChromeMock();
});

describe('deadlineFrom', () => {
  it('is the idle window from now', () => {
    expect(deadlineFrom(settings({ idleTimeoutMinutes: 10 }), NOW)).toBe(NOW + 600_000);
    expect(deadlineFrom(settings({ idleTimeoutMinutes: 1 }), NOW)).toBe(NOW + 60_000);
  });

  it('maps "never" to a finite sentinel, because Infinity does not survive JSON', () => {
    const deadline = deadlineFrom(settings({ idleTimeoutMinutes: 0 }), NOW);
    expect(deadline).toBe(NEVER_EXPIRES);
    expect(Number.isFinite(deadline)).toBe(true);
    expect(JSON.parse(JSON.stringify({ deadline }))).toEqual({ deadline: NEVER_EXPIRES });
    expect(neverExpires(deadline)).toBe(true);
    expect(neverExpires(NOW + 600_000)).toBe(false);
  });
});

describe('armAutolock', () => {
  it('arms an alarm for the remaining window', async () => {
    await armAutolock(NOW + 600_000, NOW);
    expect(mock.alarms.get(AUTOLOCK_ALARM)?.scheduledTime).toBe(mock.clock.now() + 600_000);
  });

  it('never asks for less than Chrome will honour', async () => {
    await armAutolock(NOW + 1_000, NOW);
    expect(mock.alarms.get(AUTOLOCK_ALARM)?.scheduledTime).toBe(
      mock.clock.now() + MIN_ALARM_DELAY_MINUTES * 60_000,
    );
  });

  it('clears the alarm for a session that never expires', async () => {
    await armAutolock(NOW + 600_000, NOW);
    await armAutolock(NEVER_EXPIRES, NOW);
    expect(mock.alarms.has(AUTOLOCK_ALARM)).toBe(false);
  });

  it('clearAutolock is safe when nothing is armed', async () => {
    await expect(clearAutolock()).resolves.toBeUndefined();
  });
});

describe('armHousekeeping', () => {
  it('arms a periodic alarm', async () => {
    await armHousekeeping();
    expect(mock.alarms.get(HOUSEKEEPING_ALARM)?.periodInMinutes).toBe(HOUSEKEEPING_PERIOD_MINUTES);
  });

  it('leaves an existing alarm alone, so a busy profile still gets a housekeeping run', async () => {
    await armHousekeeping();
    const first = mock.alarms.get(HOUSEKEEPING_ALARM)?.scheduledTime;
    mock.clock.advance(60_000);
    await armHousekeeping();
    expect(mock.alarms.get(HOUSEKEEPING_ALARM)?.scheduledTime).toBe(first);
  });
});

describe('lock policy', () => {
  it('locks on system idle and on a screen lock, but not on becoming active', () => {
    expect(locksOnSystemIdle('idle')).toBe(true);
    expect(locksOnSystemIdle('locked')).toBe(true);
    expect(locksOnSystemIdle('active')).toBe(false);
  });
});

describe('handleAlarm', () => {
  it('routes each alarm to its handler and ignores the rest', async () => {
    const d = deps();
    await handleAlarm(AUTOLOCK_ALARM, d);
    expect(d.enforceDeadline).toHaveBeenCalledTimes(1);

    await handleAlarm(HOUSEKEEPING_ALARM, d);
    expect(d.housekeep).toHaveBeenCalledTimes(1);

    await handleAlarm('somebody.elses.alarm', d);
    expect(d.enforceDeadline).toHaveBeenCalledTimes(1);
    expect(d.housekeep).toHaveBeenCalledTimes(1);
  });

  it('samples the focus state when the watch alarm fires', async () => {
    const d = deps({ settings: () => Promise.resolve(settings({ lockOnBrowserBlur: true })) });
    vi.useFakeTimers();
    try {
      const pending = handleAlarm(FOCUS_WATCH_ALARM, d);
      await vi.advanceTimersByTimeAsync(BLUR_SETTLE_MS);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(d.lock).toHaveBeenCalledWith('blur');
  });
});

describe('armFocusWatch', () => {
  it('runs only while the setting is on', async () => {
    await armFocusWatch(settings({ lockOnBrowserBlur: false }));
    expect(mock.alarms.get(FOCUS_WATCH_ALARM)).toBeUndefined();

    await armFocusWatch(settings({ lockOnBrowserBlur: true }));
    const alarm = mock.alarms.get(FOCUS_WATCH_ALARM);
    expect(alarm?.periodInMinutes).toBe(FOCUS_WATCH_PERIOD_MINUTES);

    // Turning it back off is what a lock and a settings change both do.
    await armFocusWatch(settings({ lockOnBrowserBlur: false }));
    expect(mock.alarms.get(FOCUS_WATCH_ALARM)).toBeUndefined();
  });

  it('keeps the schedule it already has, rather than resetting it on every worker start', async () => {
    await armFocusWatch(settings({ lockOnBrowserBlur: true }));
    const first = mock.alarms.get(FOCUS_WATCH_ALARM)?.scheduledTime;
    mock.clock.advance(20_000);
    await armFocusWatch(settings({ lockOnBrowserBlur: true }));
    expect(mock.alarms.get(FOCUS_WATCH_ALARM)?.scheduledTime).toBe(first);
  });

  it('clears', async () => {
    await armFocusWatch(settings({ lockOnBrowserBlur: true }));
    await clearFocusWatch();
    expect(mock.alarms.get(FOCUS_WATCH_ALARM)).toBeUndefined();
  });
});

/*
 * What Chrome actually reports, measured 2026-08-22 on Windows 10 against the real `dist/` with a
 * listener in the service worker, and the reason this file no longer tests an event handler:
 *
 * - Switching to another *application* fires **no** `onFocusChanged` at all. `getAll()` quietly
 *   stops reporting a focused window, and nothing wakes the worker to notice.
 * - Opening the toolbar popup **does** fire — and leaves no window focused, because Chrome's window
 *   model has no entry for a popup. Identical, from the worker's side, to the case above.
 * - `WINDOW_ID_NONE` also arrives while a window is focused, e.g. on restoring a minimised one.
 *
 * So the decision is made from sampled state, and the two situations are told apart by the popup
 * saying so itself over the focus port.
 */
describe('sampleFocus', () => {
  /** Run a sample to completion, settle included. Fake timers, so the wait costs nothing. */
  async function sample(d: LifecycleDeps): Promise<void> {
    const pending = sampleFocus(d);
    await vi.advanceTimersByTimeAsync(BLUR_SETTLE_MS);
    await pending;
  }

  function blurDeps(): LifecycleDeps {
    return deps({ settings: () => Promise.resolve(settings({ lockOnBrowserBlur: true })) });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the setting on every sample, not when the listener was registered', async () => {
    let lockOnBrowserBlur = false;
    const d = deps({ settings: () => Promise.resolve(settings({ lockOnBrowserBlur })) });

    await sample(d);
    expect(d.lock).not.toHaveBeenCalled();

    lockOnBrowserBlur = true;
    await sample(d);
    expect(d.lock).toHaveBeenCalledWith('blur');
  });

  it('does not lock a vault that is already locked', async () => {
    const d = deps({
      settings: () => Promise.resolve(settings({ lockOnBrowserBlur: true })),
      unlocked: () => Promise.resolve(false),
    });

    await sample(d);

    expect(d.lock).not.toHaveBeenCalled();
  });

  it('locks only once the blur has stood for the settle', async () => {
    const d = blurDeps();

    const pending = sampleFocus(d);
    await vi.advanceTimersByTimeAsync(BLUR_SETTLE_MS - 1);
    expect(d.lock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(d.lock).toHaveBeenCalledWith('blur');
  });

  it('does not lock while the window the session belongs to still holds the focus', async () => {
    const d = blurDeps();
    const window_ = await chrome.windows.create({ focused: true });
    heldWindow = window_?.id ?? 0;

    await sample(d);

    expect(d.lock).not.toHaveBeenCalled();
  });

  it('adopts the window it finds when the session has none recorded', async () => {
    const d = blurDeps();
    const window_ = await chrome.windows.create({ focused: true });

    await sample(d);

    expect(d.lock).not.toHaveBeenCalled();
    expect(heldWindow).toBe(window_?.id);
  });

  /*
   * The policy in one test: the setting locks on the *current window* losing the focus, and another
   * Chrome window is not an exception to that. It is the deliberate cost of the promise — opening a
   * bookmark in incognito moves the focus to a new window, and with this setting on that locks the
   * vault behind it.
   */
  it('locks when the focus moves to another Chrome window', async () => {
    const d = blurDeps();
    const first = await chrome.windows.create({ focused: true });
    heldWindow = first?.id ?? 0;
    await chrome.windows.create({ incognito: true, focused: true });

    await sample(d);

    expect(d.lock).toHaveBeenCalledWith('blur');
  });

  it('locks when the window it can still see has stopped holding the focus', async () => {
    const d = blurDeps();
    const window_ = await chrome.windows.create({ focused: true });
    heldWindow = window_?.id ?? 0;
    mock.triggerFocusChanged(chrome.windows.WINDOW_ID_NONE);

    await sample(d);

    expect(d.lock).toHaveBeenCalledWith('blur');
  });

  it('locks when there is no window left to ask about', async () => {
    const d = blurDeps();

    await sample(d);

    expect(d.lock).toHaveBeenCalledWith('blur');
  });

  it('takes one sample at a time', async () => {
    const d = blurDeps();

    const first = sampleFocus(d);
    const second = sampleFocus(d);
    await vi.advanceTimersByTimeAsync(BLUR_SETTLE_MS);
    await Promise.all([first, second]);

    expect(d.lock).toHaveBeenCalledTimes(1);
  });
});

/*
 * The reported bug, in the two shapes it was reported in (2026-08-22):
 *
 *   1. open the quick menu, close it, open it again — and the vault has locked itself,
 *   2. leave the quick menu open and click another application — and the vault stays unlocked,
 *      with the bookmarks still on screen.
 *
 * Both are the same missing fact: Chrome does not tell the worker that an open popup is where the
 * user is. The popup does.
 */
describe('the focus beacon', () => {
  function unlockedWithBlurLock(): LifecycleDeps {
    return deps({ settings: () => Promise.resolve(settings({ lockOnBrowserBlur: true })) });
  }

  /*
   * Every port this file opens, closed again on the way out.
   *
   * The claims live in module scope in `autolock.ts`, which in the browser means "for as long as
   * the worker" — and in a test file means "for as long as the run", because the module is imported
   * once. A page that never disconnects would keep the next test's vault unlocked.
   */
  const ports: chrome.runtime.Port[] = [];

  /**
   * A page with a beacon on it, as `shared/focus-beacon.ts` behaves.
   *
   * `announce` is the page noticing its own focus change and saying so; `quietly` is the page's
   * focus changing with nothing fired at all, which is what minimising a window does. The port
   * answers the worker's "say it again" either way — that answer is what tells the two apart.
   */
  function connectPage(name: string = FOCUS_PORT): {
    announce: (focused: boolean) => void;
    quietly: (focused: boolean) => void;
    port: chrome.runtime.Port;
  } {
    const port = chrome.runtime.connect({ name });
    ports.push(port);
    let focused = false;
    port.onMessage.addListener(() => {
      port.postMessage({ focused });
    });
    return {
      port,
      announce: (next) => {
        focused = next;
        port.postMessage({ focused: next });
      },
      quietly: (next) => {
        focused = next;
      },
    };
  }

  /**
   * Let a sample that is already running reach its end.
   *
   * `sampleFocus` takes one sample at a time, and the flag that enforces that lives in module scope
   * — so a sample abandoned mid-settle by `vi.useRealTimers()` would silently switch the policy off
   * for every test after it. Draining is how this file stays honest about that.
   */
  async function drain(): Promise<void> {
    for (let round = 0; round < 4; round += 1) {
      await vi.advanceTimersByTimeAsync(BLUR_SETTLE_MS);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    while (ports.length > 0) ports.pop()?.disconnect();
    await drain();
    vi.useRealTimers();
  });

  it('does not lock the vault behind an open quick menu', async () => {
    const d = unlockedWithBlurLock();
    registerLifecycleListeners(d);

    // The popup opens: Chrome reports a focus change and stops reporting a focused window, and the
    // popup says it has the user.
    connectPage().announce(true);
    mock.triggerFocusChanged(chrome.windows.WINDOW_ID_NONE);

    await vi.advanceTimersByTimeAsync(BLUR_SETTLE_MS * 4);

    expect(d.lock).not.toHaveBeenCalled();
  });

  it('locks when the quick menu loses the focus to another application', async () => {
    const d = unlockedWithBlurLock();
    registerLifecycleListeners(d);
    const page = connectPage();
    page.announce(true);

    page.announce(false);
    await drain();

    expect(d.lock).toHaveBeenCalledWith('blur');
  });

  it('locks when the page holding the focus goes away without a word', async () => {
    const d = unlockedWithBlurLock();
    registerLifecycleListeners(d);
    const page = connectPage();
    page.announce(true);

    page.port.disconnect();
    await drain();

    expect(d.lock).toHaveBeenCalledWith('blur');
  });

  it('does not lock when the page that went away was a background tab', async () => {
    const d = unlockedWithBlurLock();
    registerLifecycleListeners(d);
    const window_ = await chrome.windows.create({ focused: true });
    heldWindow = window_?.id ?? 0;
    const page = connectPage();
    page.announce(false);

    page.port.disconnect();
    await drain();

    expect(d.lock).not.toHaveBeenCalled();
  });

  it("ignores ports opened under someone else's name", async () => {
    const d = unlockedWithBlurLock();
    registerLifecycleListeners(d);
    connectPage('not.ours').announce(true);

    const pending = sampleFocus(d);
    await drain();
    await pending;

    expect(d.lock).toHaveBeenCalledWith('blur');
  });

  /*
   * The second half of the reported bug, and the reason a claim is re-asked for rather than
   * trusted: minimising a window fires no `blur` in the page inside it, so the manager tab went on
   * claiming a focus it had lost and the vault stayed unlocked behind a minimised browser.
   */
  it('locks when a page has silently stopped holding the focus it claimed', async () => {
    const d = unlockedWithBlurLock();
    registerLifecycleListeners(d);
    const page = connectPage();
    page.announce(true);

    page.quietly(false);
    const pending = sampleFocus(d);
    await drain();
    await pending;

    expect(d.lock).toHaveBeenCalledWith('blur');
  });

  it('ignores a message that is not a focus report', async () => {
    const d = unlockedWithBlurLock();
    registerLifecycleListeners(d);
    const port = chrome.runtime.connect({ name: FOCUS_PORT });
    ports.push(port);
    port.postMessage({ focused: 'yes' });

    const pending = sampleFocus(d);
    await drain();
    await pending;

    expect(d.lock).toHaveBeenCalledWith('blur');
  });
});

describe('registerLifecycleListeners', () => {
  it('wires alarms, blur and system idle', async () => {
    const d = deps({ settings: () => Promise.resolve(settings({ lockOnBrowserBlur: true })) });
    registerLifecycleListeners(d);

    await armAutolock(NOW + 600_000, NOW);
    mock.triggerAlarm(AUTOLOCK_ALARM);
    await vi.waitFor(() => {
      expect(d.enforceDeadline).toHaveBeenCalled();
    });

    // Real timers here, so the wait has to cover the blur settle rather than a microtask. The id
    // is irrelevant — the event is only ever a reason to go and sample the state.
    mock.triggerFocusChanged(chrome.windows.WINDOW_ID_NONE);
    await vi.waitFor(
      () => {
        expect(d.lock).toHaveBeenCalledWith('blur');
      },
      { timeout: BLUR_SETTLE_MS + 2_000 },
    );

    mock.triggerIdleState('locked');
    await vi.waitFor(() => {
      expect(d.lock).toHaveBeenCalledWith('idle');
    });
  });

  it('asks whether the remote moved when the machine comes back, and does not lock', async () => {
    const d = deps();
    registerLifecycleListeners(d);

    mock.triggerIdleState('active');
    await vi.waitFor(() => {
      expect(d.wake).toHaveBeenCalled();
    });
    expect(d.lock).not.toHaveBeenCalled();
  });

  it('does not touch chrome.idle when the optional permission is absent', () => {
    uninstallChromeMock();
    mock = installChromeMock();
    expect(() => {
      registerLifecycleListeners(deps());
    }).not.toThrow();
    expect(() => {
      mock.triggerIdleState('idle');
    }).toThrow(/optional "idle" permission/);
  });
});

describe('applyIdleDetection', () => {
  it('matches the detection interval to the idle window', () => {
    applyIdleDetection(settings({ idleTimeoutMinutes: 10 }));
    expect(mock.idleDetectionInterval()).toBe(600);
  });

  it('respects Chrome\'s 15-second floor', () => {
    applyIdleDetection(settings({ idleTimeoutMinutes: 0.1 }));
    expect(mock.idleDetectionInterval()).toBe(15);
  });

  it('does nothing for "never", and nothing without the permission', () => {
    applyIdleDetection(settings({ idleTimeoutMinutes: 0 }));
    expect(mock.idleDetectionInterval()).toBeUndefined();

    uninstallChromeMock();
    mock = installChromeMock();
    expect(() => {
      applyIdleDetection(settings({ idleTimeoutMinutes: 10 }));
    }).not.toThrow();
  });
});
