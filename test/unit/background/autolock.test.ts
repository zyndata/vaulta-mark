import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTOLOCK_ALARM,
  HOUSEKEEPING_ALARM,
  HOUSEKEEPING_PERIOD_MINUTES,
  MIN_ALARM_DELAY_MINUTES,
  NEVER_EXPIRES,
  applyIdleDetection,
  armAutolock,
  armHousekeeping,
  clearAutolock,
  deadlineFrom,
  handleAlarm,
  handleFocusChange,
  locksOnBlur,
  locksOnSystemIdle,
  neverExpires,
  registerLifecycleListeners,
  type LifecycleDeps,
} from '../../../src/background/autolock.js';
import { DEFAULT_SETTINGS, type VaultSettings } from '../../../src/vault/types.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

const NOW = 1_750_000_000_000;

let mock: ChromeMock;

function settings(patch: Partial<VaultSettings> = {}): VaultSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

function deps(override: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    enforceDeadline: vi.fn(() => Promise.resolve()),
    housekeep: vi.fn(() => Promise.resolve()),
    lock: vi.fn(() => Promise.resolve()),
    settings: vi.fn(() => Promise.resolve(DEFAULT_SETTINGS)),
    ...override,
  };
}

beforeEach(() => {
  mock = installChromeMock({ grantedPermissions: ['idle'] });
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
  it('locks on blur only when Chrome itself lost focus, and only when the setting is on', () => {
    const on = settings({ lockOnBrowserBlur: true });
    expect(locksOnBlur(chrome.windows.WINDOW_ID_NONE, on)).toBe(true);
    // Focus moving to another Chrome window must not lock, or every "open in incognito" would
    // lock the vault behind it.
    expect(locksOnBlur(7, on)).toBe(false);
    // Spelled out rather than relying on the default, which is now `true` — the assertion is about
    // the setting being honoured, not about what it happens to be set to.
    expect(locksOnBlur(chrome.windows.WINDOW_ID_NONE, settings({ lockOnBrowserBlur: false }))).toBe(
      false,
    );
  });

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
});

describe('handleFocusChange', () => {
  it('reads the setting when the event fires, not when the listener was registered', async () => {
    let lockOnBrowserBlur = false;
    const d = deps({ settings: () => Promise.resolve(settings({ lockOnBrowserBlur })) });

    await handleFocusChange(chrome.windows.WINDOW_ID_NONE, d);
    expect(d.lock).not.toHaveBeenCalled();

    lockOnBrowserBlur = true;
    await handleFocusChange(chrome.windows.WINDOW_ID_NONE, d);
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

    mock.triggerFocusChanged(chrome.windows.WINDOW_ID_NONE);
    await vi.waitFor(() => {
      expect(d.lock).toHaveBeenCalledWith('blur');
    });

    mock.triggerIdleState('locked');
    await vi.waitFor(() => {
      expect(d.lock).toHaveBeenCalledWith('idle');
    });
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
