/**
 * When the vault locks itself: the deadline arithmetic, the alarms, and the blur/idle policy.
 *
 * The division of labour with `session.ts` is deliberate. This module decides *when*; `session.ts`
 * holds the key and does the locking. Nothing here imports it — the listeners take their handlers
 * as arguments — so the two files have one import direction and neither needs the other to be
 * tested.
 *
 * **The alarm is a convenience, not the authority** (ARCHITECTURE §7.3). `chrome.alarms` clamps
 * short delays, fires late after a suspend, and can be missed entirely if the worker is killed at
 * the wrong moment. The authority is the `unlockedUntil` check performed on every session
 * rehydrate, which an attacker cannot suppress by suppressing alarms. This module therefore treats
 * an alarm as "go and check", never as "the deadline has passed".
 */

import { IDLE_TIMEOUT_NEVER, type VaultSettings } from '../vault/types.js';
import type { LockReason } from '../shared/messages.js';

export const AUTOLOCK_ALARM = 'vm.autolock';

/** Tombstone purging (D20) and other cheap upkeep that needs an unlocked vault. */
export const HOUSEKEEPING_ALARM = 'vm.housekeeping';

/** Twice a day. Tombstones expire after 90 days; nothing here is time-critical. */
export const HOUSEKEEPING_PERIOD_MINUTES = 12 * 60;

/**
 * The `unlockedUntil` stamp for "never auto-lock".
 *
 * A finite sentinel rather than `Infinity`, because the stamp is JSON-serialised into
 * `chrome.storage.session` and `Infinity` comes back as `null`.
 */
export const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

/**
 * Chrome refuses alarms below 30 seconds for packed extensions and warns for unpacked ones, so
 * asking for less buys nothing. A too-early alarm is harmless — `enforceDeadline` re-arms.
 */
export const MIN_ALARM_DELAY_MINUTES = 0.5;

/** When the idle window that starts now expires. */
export function deadlineFrom(settings: VaultSettings, now: number): number {
  if (settings.idleTimeoutMinutes <= IDLE_TIMEOUT_NEVER) return NEVER_EXPIRES;
  return now + settings.idleTimeoutMinutes * 60_000;
}

export function neverExpires(unlockedUntil: number): boolean {
  return unlockedUntil >= NEVER_EXPIRES;
}

/** Arm (or re-arm) the auto-lock alarm for a deadline. "Never" clears it instead. */
export async function armAutolock(unlockedUntil: number, now: number): Promise<void> {
  if (neverExpires(unlockedUntil)) {
    await clearAutolock();
    return;
  }
  const delayInMinutes = Math.max((unlockedUntil - now) / 60_000, MIN_ALARM_DELAY_MINUTES);
  await chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes });
}

export async function clearAutolock(): Promise<void> {
  await chrome.alarms.clear(AUTOLOCK_ALARM);
}

/**
 * Arm the housekeeping alarm if it is not already armed.
 *
 * Checked rather than recreated, because `chrome.alarms.create` with an existing name resets the
 * schedule: recreating it on every worker start would mean a periodic alarm that never fires on a
 * profile the user touches often.
 */
export async function armHousekeeping(): Promise<void> {
  const existing = await chrome.alarms.get(HOUSEKEEPING_ALARM);
  if (existing !== undefined) return;
  await chrome.alarms.create(HOUSEKEEPING_ALARM, {
    delayInMinutes: HOUSEKEEPING_PERIOD_MINUTES,
    periodInMinutes: HOUSEKEEPING_PERIOD_MINUTES,
  });
}

/**
 * Whether losing focus should lock (D-setting "lock on browser blur", off by default).
 *
 * `WINDOW_ID_NONE` means no Chrome window has focus at all — the user switched to another
 * application. Focus moving between two Chrome windows reports the new window's id and must not
 * lock, or every "open in incognito" would immediately lock the vault behind it.
 */
export function locksOnBlur(windowId: number, settings: VaultSettings): boolean {
  return settings.lockOnBrowserBlur && windowId === chrome.windows.WINDOW_ID_NONE;
}

/** `locked` is the OS screen lock; `idle` is the detection interval elapsing. Both lock. */
export function locksOnSystemIdle(state: string): boolean {
  return state === 'idle' || state === 'locked';
}

/** Handlers the lifecycle listeners call. Injected so this module never imports `session.ts`. */
export interface LifecycleDeps {
  /** Re-check `unlockedUntil` and either lock or re-arm. */
  readonly enforceDeadline: () => Promise<void>;
  readonly housekeep: () => Promise<void>;
  readonly lock: (reason: LockReason) => Promise<void>;
  readonly settings: () => Promise<VaultSettings>;
}

export async function handleAlarm(name: string, deps: LifecycleDeps): Promise<void> {
  if (name === AUTOLOCK_ALARM) await deps.enforceDeadline();
  else if (name === HOUSEKEEPING_ALARM) await deps.housekeep();
}

export async function handleFocusChange(windowId: number, deps: LifecycleDeps): Promise<void> {
  // Read the setting inside the handler, not at registration: the listener has to be registered
  // synchronously at worker start (below), which is before any storage read has resolved.
  if (locksOnBlur(windowId, await deps.settings())) await deps.lock('blur');
}

/**
 * Register everything that can lock the vault without the user asking.
 *
 * Called synchronously from the service-worker entry. MV3 only delivers an event that *woke* the
 * worker to listeners registered during the initial evaluation, so none of this may sit behind an
 * `await`.
 */
export function registerLifecycleListeners(deps: LifecycleDeps): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    void handleAlarm(alarm.name, deps);
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    void handleFocusChange(windowId, deps);
  });

  const idle = idleApi();
  if (idle !== undefined) {
    idle.onStateChanged.addListener((state) => {
      if (locksOnSystemIdle(state)) void deps.lock('idle');
    });
  }
}

/**
 * Point `chrome.idle`'s detection interval at the configured idle window, when the permission is
 * granted. Best-effort: the alarm covers the same ground without it.
 */
export function applyIdleDetection(settings: VaultSettings): void {
  const idle = idleApi();
  if (idle === undefined) return;
  if (settings.idleTimeoutMinutes <= IDLE_TIMEOUT_NEVER) return;
  // Chrome's floor is 15 seconds.
  idle.setDetectionInterval(Math.max(15, settings.idleTimeoutMinutes * 60));
}

/**
 * `chrome.idle`, or `undefined` when the optional `idle` permission has not been granted (D26).
 *
 * Chrome omits the namespace entirely in that case, while the typings describe the fully-granted
 * API — so this signature, not the typings, is the honest type. A synchronous property read rather
 * than a `chrome.permissions.contains()`: the caller registers a listener, and MV3 only delivers an
 * event that woke the worker to listeners registered before the first `await`.
 */
function idleApi(): typeof chrome.idle | undefined {
  return chrome.idle;
}
