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
import { FOCUS_PORT, isFocusReport } from '../shared/focus-beacon.js';
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
 * The alarm that samples the focus state while "lock when this window loses focus" is on.
 *
 * Periodic, and armed only while the vault is unlocked and the setting is on, because the state it
 * samples is one Chrome never announces (see {@link sampleFocus}). Half a minute is Chrome's floor
 * for an alarm, so it is also the longest the vault can stay unlocked after someone walks away from
 * a screen showing an ordinary web page. Leaving with one of our own pages in front is prompt
 * instead — the popup and the manager report their own blur, and that lands within
 * {@link BLUR_SETTLE_MS}.
 */
export const FOCUS_WATCH_ALARM = 'vm.focuswatch';

/** Chrome's minimum, and so the fastest an alarm can wake a dead worker to go and look. */
export const FOCUS_WATCH_PERIOD_MINUTES = 0.5;

/**
 * How long a sample that found nobody has to stand before it counts as having left.
 *
 * Not a tolerance for switching between windows — under this policy that locks — but the width of a
 * race: opening the popup makes Chrome report no focused window *before* the popup has connected to
 * say it holds it, and a decision taken in that gap would lock a browser that is perfectly in use.
 * Three quarters of a second is orders of magnitude more than that gap, and still a lock the user
 * cannot perceive as late.
 */
export const BLUR_SETTLE_MS = 750;

/**
 * Arm or clear the focus watch from the settings and the session of the moment.
 *
 * Checked rather than recreated, for the reason {@link armHousekeeping} explains: `alarms.create`
 * on a name that already exists resets its schedule, so re-arming on every worker start would be an
 * alarm that never fires.
 */
export async function armFocusWatch(settings: VaultSettings): Promise<void> {
  if (!settings.lockOnBrowserBlur) {
    await clearFocusWatch();
    return;
  }
  const existing = await chrome.alarms.get(FOCUS_WATCH_ALARM);
  if (existing !== undefined) return;
  await chrome.alarms.create(FOCUS_WATCH_ALARM, {
    delayInMinutes: FOCUS_WATCH_PERIOD_MINUTES,
    periodInMinutes: FOCUS_WATCH_PERIOD_MINUTES,
  });
}

export async function clearFocusWatch(): Promise<void> {
  await chrome.alarms.clear(FOCUS_WATCH_ALARM);
}

/**
 * Every open focus beacon, and the subset of them that claim the keyboard focus
 * (`shared/focus-beacon.ts`).
 *
 * Module scope, so a claim lives exactly as long as the worker — which is the safe direction: a
 * page that really is focused reconnects and says so again within milliseconds, while a claim that
 * outlived its page would keep a vault unlocked for as long as the browser ran.
 */
const beacons = new Set<chrome.runtime.Port>();
const focusedPages = new Set<chrome.runtime.Port>();

/**
 * Throw away every claim and ask for it again.
 *
 * **A claim can go stale without the page ever being told.** Minimising a window does not fire
 * `blur` in the page inside it (measured 2026-08-22, which is how this was found: the vault stayed
 * unlocked behind a minimised browser because the manager tab was still claiming the focus it had
 * lost). So a claim is never trusted at the moment a lock is being decided — it is re-asked for,
 * and the settle that follows is the window in which the answers arrive.
 */
function refreshClaims(): void {
  focusedPages.clear();
  for (const port of beacons) {
    try {
      port.postMessage({ ping: true });
    } catch {
      // The page went away between the two. Its `onDisconnect` will tidy up.
    }
  }
}

/**
 * The window types Chrome will admit to. `getAll` filters to `normal` and `popup` by default, and
 * an undocked DevTools window the user is typing in is neither.
 */
const FOCUSABLE_WINDOW_TYPES = ['normal', 'popup', 'panel', 'app', 'devtools'] as const;

/** Which window holds the focus right now, or `null` when none of Chrome's does. */
async function focusedWindowId(): Promise<number | null> {
  try {
    const windows = await chrome.windows.getAll({ windowTypes: [...FOCUSABLE_WINDOW_TYPES] });
    return windows.find((window_) => window_.focused)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The window a session unlocked now belongs to.
 *
 * `getLastFocused` rather than {@link focusedWindowId}, because unlocking happens in the toolbar
 * popup — and while a popup is open Chrome reports *no* focused window at all. The window behind it
 * is the one the user is in, and the one they will still be in when the popup closes.
 */
export async function owningWindowId(): Promise<number | null> {
  try {
    return (await chrome.windows.getLastFocused()).id ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the window in front is the one the unlocked session belongs to.
 *
 * Anything else — another Chrome window, or no window at all — is the user having left it, which is
 * the whole of what the setting promises. The holder is seeded when the session opens and never
 * moves afterwards: under this policy the focus leaving that window ends the session, so there is
 * nothing to move it to. A session that somehow has no holder recorded adopts the window it finds,
 * rather than locking on a fact it has never observed.
 *
 * This deliberately knows nothing about the toolbar popup. Chrome's window model has no entry for
 * one, so while a popup is open *no* window is focused and this returns false — see
 * {@link sampleFocus} for the half of the answer that only the page itself can give.
 */
async function windowStillOurs(deps: LifecycleDeps): Promise<boolean> {
  const focused = await focusedWindowId();
  if (focused === null) return false;
  const holder = await deps.focusHolder();
  if (holder === null) {
    await deps.rememberFocusHolder(focused);
    return true;
  }
  return focused === holder;
}

/** One sample at a time. A second trigger during the settle would only ask the same question. */
let sampling = false;

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Look at where the focus is, and lock if it has left the window this session belongs to.
 *
 * **Focus is sampled here, never awaited, and that is the whole design.** `onFocusChanged` does not
 * report the thing this setting is about: measured 2026-08-22 on Windows 10 against the real
 * `dist/`, switching to another application fires no event whatsoever, while opening the toolbar
 * popup fires one and leaves Chrome reporting no focused window — the same state, arrived at from
 * the two situations the user most wants told apart. Hanging a lock on that event is why the quick
 * menu locked the vault behind itself, and why leaving Chrome sometimes locked nothing at all.
 *
 * So every trigger — a focus event, a page reporting its own blur, the watch alarm — leads here,
 * and the decision is made from state. The settle is not a tolerance for switching windows: it is
 * there because the popup's claim and Chrome's focus event are two messages in flight at once, and
 * a sample taken between them would read "nobody has it" for a browser that is perfectly in use.
 */
export async function sampleFocus(deps: LifecycleDeps): Promise<void> {
  if (sampling) return;
  sampling = true;
  try {
    // Read the setting on every sample, not at registration: the listeners are registered
    // synchronously at worker start (below), which is before any storage read has resolved.
    if (!(await deps.settings()).lockOnBrowserBlur) return;
    if (!(await deps.unlocked())) return;
    if (await windowStillOurs(deps)) return;
    // No window of ours is in front. Either the user left, or one of our own pages is what is in
    // front of them — which only that page can say, so ask, and give the answers the settle to
    // arrive in.
    refreshClaims();
    await settle(BLUR_SETTLE_MS);
    if (focusedPages.size > 0) return;
    if (await windowStillOurs(deps)) return;
    if (!(await deps.unlocked())) return;
    await deps.lock('blur');
  } finally {
    sampling = false;
  }
}

/** Take a page's word for whether it holds the focus, for as long as the page is there. */
function trackFocusBeacon(port: chrome.runtime.Port, deps: LifecycleDeps): void {
  beacons.add(port);
  const dropped = (): void => {
    // Only a page that *was* claiming the focus changes the answer by stopping.
    if (focusedPages.delete(port)) void sampleFocus(deps);
  };
  port.onMessage.addListener((raw: unknown) => {
    if (!isFocusReport(raw)) return;
    if (raw.focused) focusedPages.add(port);
    else dropped();
  });
  port.onDisconnect.addListener(() => {
    beacons.delete(port);
    dropped();
  });
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
  /** The machine came back from idle: a good moment to ask whether the remote moved. */
  readonly wake: () => Promise<void>;
  readonly lock: (reason: LockReason) => Promise<void>;
  readonly settings: () => Promise<VaultSettings>;
  /** Whether a session is open at all. A blur cannot lock what is already locked. */
  readonly unlocked: () => Promise<boolean>;
  /** The window the open session belongs to, or `null` if none was recorded. */
  readonly focusHolder: () => Promise<number | null>;
  readonly rememberFocusHolder: (windowId: number) => Promise<void>;
}

export async function handleAlarm(name: string, deps: LifecycleDeps): Promise<void> {
  if (name === AUTOLOCK_ALARM) await deps.enforceDeadline();
  else if (name === HOUSEKEEPING_ALARM) await deps.housekeep();
  else if (name === FOCUS_WATCH_ALARM) await sampleFocus(deps);
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

  // The id the event carries goes unread, and deliberately: it describes a transition Chrome only
  // sometimes reports, while `sampleFocus` reads a state that is always true. The event is a reason
  // to go and look, nothing more.
  chrome.windows.onFocusChanged.addListener(() => {
    void sampleFocus(deps);
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === FOCUS_PORT) trackFocusBeacon(port, deps);
  });

  const idle = idleApi();
  if (idle !== undefined) {
    idle.onStateChanged.addListener((state) => {
      if (locksOnSystemIdle(state)) void deps.lock('idle');
      // The other direction: the machine came back, which is one of the wake events a Drive sync
      // has to notice because Drive, unlike `chrome.storage.sync`, cannot tell us it moved
      // (ARCHITECTURE §13.4). Registered here rather than in `index.ts` so that one place knows the
      // namespace may be absent.
      else if (state === 'active') void deps.wake();
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
