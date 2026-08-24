/**
 * Key custody: the only place in the extension that decides whether the vault is unlocked.
 *
 * MV3 terminates the service worker after roughly 30 seconds of inactivity, so a DEK held only in
 * a module-scope variable would mean a password prompt every time the user opened the popup. The
 * unlocked DEK therefore lives in `chrome.storage.session` (D14, ARCHITECTURE §5.5), which is
 * memory-backed, never written to disk, cleared when the browser exits, and restricted to trusted
 * contexts. The tradeoff is documented in the threat model and in `SECURITY.md`.
 *
 * Two consequences shape this file:
 *
 * - **The module-scope `repository` is a cache, not the state.** `chrome.storage.session` is the
 *   state. A cold worker rebuilds the repository from it; a locked vault has neither.
 * - **`unlockedUntil` is checked on every read, not only when the alarm fires** (§7.3). An attacker
 *   who suppresses alarms still cannot use an expired session, and a worker that was asleep across
 *   the deadline locks the moment it wakes.
 *
 * INV-7: after {@link lock}, `chrome.storage.session` is empty and no variable here holds the DEK
 * or a decrypted item.
 */

import { fromBase64Url, toBase64Url } from '../crypto/codec.js';
import { zero } from '../crypto/wipe.js';
import {
  readHeader,
  readOnboarding,
  readSettings,
  writeOnboarding,
  writeSettings,
} from '../storage/local.js';
import { VaultRepository } from '../storage/repo.js';
import { fetchRemote, hasRemoteVault, markAdopted, scheduleSync } from '../sync/engine.js';
import type { LockReason, OnboardingPatch, SettingsPatch } from '../shared/messages.js';
import { broadcast } from '../shared/messages.js';
import { VaultLockedError, VaultStateError } from '../vault/errors.js';
import { applyToolbarAppearance } from './appearance.js';
import { applySyncedSettings, stampSettings } from '../vault/settings-sync.js';
import type { EncryptedVault, OnboardingRecord, VaultSettings } from '../vault/types.js';
import {
  applyIdleDetection,
  armAutolock,
  armFocusWatch,
  clearAutolock,
  clearFocusWatch,
  deadlineFrom,
  neverExpires,
  owningWindowId,
} from './autolock.js';
import { forgetIncognitoAccess } from './incognito.js';

/** The single `chrome.storage.session` key VaultaMark owns (ARCHITECTURE §5.5). */
export const SESSION_KEY = 'vm.session';

/** What `vm.session` holds. Never anything derived from vault *content*. */
interface SessionRecord {
  /** base64url of the 32-byte DEK. */
  readonly dek: string;
  readonly unlockedUntil: number;
  readonly providerId: VaultSettings['providerId'];
  /**
   * The window this session was opened in, for "lock when the window loses focus" (§7.3).
   *
   * A browser window id and nothing else — it says where the user was, never anything about what
   * the vault holds. Here rather than in module scope because MV3 kills the worker every thirty
   * seconds and a policy that forgot which window it was watching would have to re-adopt whichever
   * one it woke up to, which is the same as having no policy.
   */
  readonly focusWindowId: number | null;
}

export interface SessionState {
  /** Whether this profile holds a vault at all — the difference between "create" and "unlock". */
  readonly exists: boolean;
  /**
   * There is no vault *here*, but there is one waiting in the sync area.
   *
   * The difference between "create a vault" and "this is a second computer — type the password you
   * already have". Only ever true when {@link exists} is false.
   */
  readonly adoptable: boolean;
  readonly locked: boolean;
  readonly unlockedUntil: number | null;
}

export interface LockOptions {
  readonly reason?: LockReason;
  /** Write pending changes before dropping the key. Defaults to `false` only for a panic-lock. */
  readonly flush?: boolean;
}

/**
 * The decrypted vault, while this particular worker instance is alive.
 *
 * Rebuilt from `storage.session` after every worker restart. Never read directly — go through
 * {@link currentRepository}, which enforces the deadline first.
 */
let repository: VaultRepository | null = null;

/**
 * Work that needs the open vault, run on the way into a lock.
 *
 * Injected from the service-worker entry rather than imported, for the same reason the sync engine's
 * hooks are: `background/history.ts` reaches the vault through `items.ts`, which imports this file,
 * so importing it back would be a cycle. This way the dependency runs one way and a test can lock a
 * vault without a history implementation existing at all.
 */
type BeforeLock = (repo: VaultRepository, settings: VaultSettings) => Promise<void>;

let beforeLock: BeforeLock | null = null;

export function configureLockHooks(hooks: { readonly beforeLock: BeforeLock }): void {
  beforeLock = hooks.beforeLock;
}

/**
 * Make the session area's trusted-contexts restriction explicit rather than implicit.
 *
 * `TRUSTED_CONTEXTS` is already the default, so this changes nothing at runtime today. It is here
 * so that a future Chrome default, or a stray `setAccessLevel` elsewhere, cannot quietly expose the
 * DEK to content scripts.
 */
export async function hardenSessionStorage(): Promise<void> {
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

/* ------------------------------------------------------------------ the record */

async function readRecord(): Promise<SessionRecord | null> {
  const raw = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Partial<SessionRecord>;
  if (typeof record.dek !== 'string' || typeof record.unlockedUntil !== 'number') return null;
  return {
    dek: record.dek,
    unlockedUntil: record.unlockedUntil,
    providerId: record.providerId === 'drive' ? 'drive' : 'chrome',
    focusWindowId: typeof record.focusWindowId === 'number' ? record.focusWindowId : null,
  };
}

async function writeRecord(record: SessionRecord): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: record });
}

/* ------------------------------------------------------------------ lifecycle */

/**
 * Create a vault and open a session on it.
 *
 * There is no recovery of any kind: nothing stored here or anywhere else could be used to get back
 * into this vault without the password (D12). The UI's job is to make sure the user knows that
 * before this runs, which is why the popup asks for a typed confirmation rather than a checkbox.
 */
export async function createVault(password: string): Promise<number> {
  const next = new VaultRepository();
  await next.create(password);
  repository = next;
  return await startSession(next);
}

/**
 * Unlock with the master password.
 *
 * One entry point for two situations that are the same thing to the person typing: a vault that is
 * already on this device, and a vault that is on another one and has been waiting in the sync area
 * since. The second is how a second computer joins — there is nothing to export, copy or scan,
 * because the KDF salt and the wrapped data key are in the header the other device already pushed.
 *
 * Throws `WrongPasswordError` on a failed DEK unwrap either way (D12), and `VaultStateError` when
 * there is no vault in either place.
 */
export async function unlock(password: string): Promise<number> {
  const next = new VaultRepository();
  if (await next.exists()) await next.unlock(password);
  else await adoptSyncedVault(next, password);
  repository = next;
  return await startSession(next);
}

/**
 * Join a vault that is already in the sync area.
 *
 * Ordered so a mistyped password costs nothing: the vault is pulled, then `adopt` derives the key
 * and decrypts it *before* writing anything, so a failure leaves the profile as empty as it was.
 * The merge base is recorded last — without it the first sync would see no base, read every item as
 * a local add, and push the whole vault straight back at the device it just came from.
 */
async function adoptSyncedVault(repo: VaultRepository, password: string): Promise<void> {
  const remote = await fetchRemote();
  if (remote === null) {
    throw new VaultStateError('There is no vault on this profile, and none in sync, to unlock.');
  }
  await repo.adopt(remote.vault, password);
  await markAdopted(repo, repo.items(), remote.stamp, remote.vault.header.vaultRev);
}

/**
 * Join a synced vault **instead of** the one this profile holds, and open a session on it.
 *
 * The end of the "two vaults, one sync area" dead end, from the side that keeps the *other* one.
 * `repo.adoptOver` documents why the ordering makes it safe; what this adds is the part that is
 * about a session rather than about storage.
 *
 * The old repository is stood down first, and **flushed** rather than dropped: its pending edits are
 * about to be erased if this succeeds, but if the password is wrong nothing is erased at all and
 * losing the last thing someone typed to a failed attempt would be a bug. After the erase, the
 * profile's own `vm.settings` is gone with it, so the backend is written back before the session
 * starts — it describes this device, and no vault can carry it.
 *
 * On failure `repository` is left null with the *old* DEK still in `storage.session`, which is what
 * makes a wrong password free: the next `currentRepository()` rebuilds the vault that is still here.
 */
export async function adoptRemoteVault(
  vault: EncryptedVault,
  password: string,
  providerId: VaultSettings['providerId'],
): Promise<number> {
  const previous = repository;
  repository = null;
  if (previous !== null) await previous.lock();

  const next = new VaultRepository();
  await next.adoptOver(vault, password);
  repository = next;

  await writeSettings({ ...(await readSettings()), providerId });
  return await startSession(next);
}

async function startSession(repo: VaultRepository): Promise<number> {
  await adoptVaultSettings(repo);
  const settings = await readSettings();
  const now = Date.now();
  const unlockedUntil = deadlineFrom(settings, now);

  // Which window the vault was unlocked in, asked for before the key is written so the answer is
  // part of the session rather than something bolted on after it (§7.3).
  const focusWindowId = settings.lockOnBrowserBlur ? await owningWindowId() : null;

  const dek = repo.exportDek();
  try {
    await writeRecord({
      dek: toBase64Url(dek),
      unlockedUntil,
      providerId: settings.providerId,
      focusWindowId,
    });
  } finally {
    // The base64url string is what `storage.session` keeps; this buffer was only a courier.
    zero(dek);
  }

  await armAutolock(unlockedUntil, now);
  await armFocusWatch(settings);
  applyIdleDetection(settings);
  await broadcast({ type: 'SESSION_UNLOCKED', unlockedUntil });
  return unlockedUntil;
}

/**
 * Take on the preferences the vault carries (PLAN §9 Phase 10).
 *
 * Run on every unlock, which is also what makes a freshly adopted vault arrive with its theme, its
 * idle timeout and the rest already set — the DoD item this exists for. The two per-device fields
 * are untouched by construction: `applySyncedSettings` only overwrites what travelled, and column
 * widths and the provider id never do.
 *
 * The record is only ever *written* while unlocked, so the vault is the authority here and the
 * local file cannot be holding something newer.
 */
async function adoptVaultSettings(repo: VaultRepository): Promise<void> {
  const record = repo.syncedSettings();
  if (Object.keys(record).length === 0) return;
  const current = await readSettings();
  const next = applySyncedSettings(current, record);
  if (JSON.stringify(next) !== JSON.stringify(current)) await writeSettings(next);
}

/**
 * A merge brought settings across from another device.
 *
 * The engine has already written `vm.settings`; what is left is the part that is not a file — the
 * auto-lock alarm has to be re-armed against a possibly shorter idle window, and every open page
 * has to hear about it.
 */
export async function settingsArrived(): Promise<void> {
  const settings = await readSettings();
  applyIdleDetection(settings);
  const record = await readRecord();
  if (record !== null) {
    const now = Date.now();
    const unlockedUntil = deadlineFrom(settings, now);
    await writeRecord({ ...record, unlockedUntil });
    await armAutolock(unlockedUntil, now);
    await armFocusWatch(settings);
  }
  await broadcast({ type: 'SETTINGS_CHANGED', settings });
}

/**
 * Forget every secret.
 *
 * Pending writes are flushed first, because losing the last thing a user typed to a lock timer is
 * a bug and not a security feature. A panic-lock is the exception: there, immediacy is the whole
 * point, so the key leaves `storage.session` before anything that could await a write.
 */
export async function lock(options: LockOptions = {}): Promise<void> {
  const reason = options.reason ?? 'manual';
  const flush = options.flush ?? reason !== 'panic';

  // **Rehydrated if this worker is cold**, not just read from the cache. MV3 tears the worker down
  // every thirty seconds, so `repository` is null for most locks that matter — the idle alarm, the
  // toolbar button on a popup that just woke us — and a hook that only ran when the cache happened
  // to be warm would run almost never in the field, and always in a test.
  let current = repository;
  if (flush && current === null && beforeLock !== null) current = await rehydrateForLock();
  repository = null;

  // History hygiene runs here or nowhere: it needs the decrypted vault, and one line further down
  // there is no key. Skipped on a panic-lock for the same reason the flush is — someone reaching
  // for that shortcut wants the key gone now, not after a few hundred `deleteUrl` round trips.
  if (flush && current !== null && beforeLock !== null) {
    await beforeLock(current, await readSettings());
  }

  if (!flush) await chrome.storage.session.clear();
  if (current !== null) await current.lock({ flush });
  // INV-7 is "empty", not "our key is gone": `clear()` rather than `remove(SESSION_KEY)`, so a key
  // written by a later phase cannot survive a lock by being forgotten here.
  await chrome.storage.session.clear();
  await clearAutolock();
  await clearFocusWatch();
  // "Cached per session" (§9) means per *unlocked* session: the next unlock re-reads the toggle
  // rather than inheriting an answer from before the user was last sent to fix it.
  forgetIncognitoAccess();
  await broadcast({ type: 'SESSION_LOCKED', reason });
}

/**
 * The unlocked vault, or `null`.
 *
 * Rehydrates a cold worker from `storage.session`, and locks instead if the idle window has
 * expired. Everything above this module that needs the vault goes through here, so there is no
 * path that can read items on an expired session.
 */
export async function currentRepository(): Promise<VaultRepository | null> {
  const record = await readRecord();
  if (record === null) {
    await forget();
    return null;
  }
  if (record.unlockedUntil <= Date.now()) {
    await lock({ reason: 'expired' });
    return null;
  }

  const cached = repository;
  if (cached !== null && !cached.locked) return cached;

  const next = await openFromRecord(record);
  if (next === null) return null;
  repository = next;
  return next;
}

/** Rebuild a repository from a session record. The DEK buffer is a courier and is wiped either way. */
async function openFromRecord(record: SessionRecord): Promise<VaultRepository | null> {
  const dek = fromBase64Url(record.dek);
  const next = new VaultRepository();
  try {
    await next.unlockWithDek(dek);
  } finally {
    zero(dek);
  }
  return next;
}

/**
 * The vault, for the work that happens *during* a lock.
 *
 * Deliberately does not go through {@link currentRepository}: that one locks an expired session,
 * and calling it from inside `lock()` would recurse. It also deliberately does **not** check the
 * deadline. An idle-expiry lock is exactly when "clear vaulted domains from history on every lock"
 * is meant to fire, and the key it would use is the one this call is about to destroy a few lines
 * later — the vault is not being opened, it is being closed with the lid still up.
 *
 * Never throws. A repository that will not rebuild is a lock that proceeds without the hook, which
 * is the right way round to be wrong: the alternative is a key that stays in memory because a
 * history deletion could not be set up.
 */
async function rehydrateForLock(): Promise<VaultRepository | null> {
  try {
    const record = await readRecord();
    return record === null ? null : await openFromRecord(record);
  } catch {
    return null;
  }
}

/**
 * Drop the cached repository without touching storage.
 *
 * Reached when `storage.session` no longer holds a record but this worker still has a decrypted
 * vault in memory — something locked us deliberately, so pending writes are not flushed.
 */
async function forget(): Promise<void> {
  const current = repository;
  repository = null;
  if (current !== null) await current.lock({ flush: false });
}

/* ------------------------------------------------------------------ the idle window */

/** Everything a UI needs to pick a screen. Enforces the deadline as a side effect. */
export async function state(): Promise<SessionState> {
  const exists = (await readHeader()) !== null;
  // Asked only when there is nothing here. A peek is one `storage.sync` read, and a profile that
  // already holds a vault would be paying it on every popup open for an answer nobody looks at.
  const adoptable = exists ? false : await hasRemoteVault();
  const record = await readRecord();
  if (record === null) return { exists, adoptable, locked: true, unlockedUntil: null };
  if (record.unlockedUntil <= Date.now()) {
    await lock({ reason: 'expired' });
    return { exists, adoptable, locked: true, unlockedUntil: null };
  }
  return { exists, adoptable, locked: false, unlockedUntil: record.unlockedUntil };
}

/**
 * Whether a session is open, cheaply.
 *
 * `state()` answers this too, but it pays for a header read and — on an empty profile — a
 * `storage.sync` peek, which is far too much for something the focus watch asks twice a minute.
 * The deadline is honoured rather than enforced: a caller that finds it passed is told "locked",
 * and the lock itself happens on the next `currentRepository()` or alarm, which is where the
 * flushing and the history hygiene belong.
 */
export async function isUnlocked(): Promise<boolean> {
  const record = await readRecord();
  return record !== null && record.unlockedUntil > Date.now();
}

/** The window the open session belongs to, or `null` — including when nothing is open. */
export async function focusHolder(): Promise<number | null> {
  return (await readRecord())?.focusWindowId ?? null;
}

/**
 * Record which window the session belongs to.
 *
 * Only ever called for a session that has none — either because the vault was unlocked while the
 * toolbar popup covered every window, or because the setting was switched on mid-session.
 */
export async function rememberFocusHolder(windowId: number): Promise<void> {
  const record = await readRecord();
  if (record === null || record.focusWindowId === windowId) return;
  await writeRecord({ ...record, focusWindowId: windowId });
}

/**
 * "The user did something": push the deadline out and re-arm the alarm.
 *
 * Returns the new deadline, or `null` if the vault is locked — a touch never unlocks anything.
 */
export async function touch(): Promise<number | null> {
  const record = await readRecord();
  if (record === null) return null;
  const now = Date.now();
  if (record.unlockedUntil <= now) {
    await lock({ reason: 'expired' });
    return null;
  }

  const settings = await readSettings();
  const unlockedUntil = deadlineFrom(settings, now);
  // A "never" session has nothing to extend, and rewriting the record on every user action would
  // be a storage write per keystroke for no benefit.
  if (neverExpires(unlockedUntil)) return record.unlockedUntil;

  await writeRecord({ ...record, unlockedUntil });
  await armAutolock(unlockedUntil, now);
  return unlockedUntil;
}

/**
 * The auto-lock alarm fired. Lock if the deadline really has passed, otherwise re-arm.
 *
 * Chrome clamps and coalesces alarms, so "the alarm fired" and "the deadline passed" are different
 * statements (§7.3). This function is the one that only trusts the second.
 */
export async function enforceDeadline(): Promise<void> {
  const record = await readRecord();
  if (record === null) {
    await forget();
    await clearAutolock();
    return;
  }
  const now = Date.now();
  if (record.unlockedUntil <= now) {
    await lock({ reason: 'expired' });
    return;
  }
  await armAutolock(record.unlockedUntil, now);
}

/* ------------------------------------------------------------------ the master password */

/**
 * Re-wrap the data key under a new password.
 *
 * The session record is left alone on purpose: it holds the **DEK**, and the DEK does not change —
 * that is the entire point of the two-level hierarchy (D10). Thirty-two bytes are re-encrypted, no
 * bucket moves, and the vault stays open under the session it was already open under. A user who
 * changes their password mid-session should not be thrown back to a lock screen for it.
 */
export async function changePassword(current: string, next: string): Promise<void> {
  const repo = await currentRepository();
  if (repo === null) throw new VaultLockedError('changing the master password');
  await repo.changePassword(current, next);
  await touch();
}

/**
 * Erase the vault from this profile, irreversibly.
 *
 * Ordered so that a failure part-way through cannot leave a usable key beside an erased vault: the
 * repository drops its keys and clears `storage.local` first, then the session record goes, then
 * the alarms. The UI is told with `SESSION_LOCKED` — from every open page's point of view the
 * difference between "locked" and "gone" is a `GET_STATE` away, and `exists` will answer it.
 */
export async function destroyVault(): Promise<void> {
  const repo = await currentRepository();
  if (repo === null) throw new VaultLockedError('destroying the vault');
  repository = null;
  await repo.destroy();
  await chrome.storage.session.clear();
  await clearAutolock();
  forgetIncognitoAccess();
  await broadcast({ type: 'SESSION_LOCKED', reason: 'manual' });
}

/**
 * Periodic upkeep that needs the key: purge tombstones past the 90-day TTL (D20), then drop the
 * thumbnails of items that are no longer there and the icons of hosts that are no longer anywhere
 * in the vault (§14.6, §10.1).
 *
 * The sweep is injected for the same reason `beforeLock` is — `background/thumbs.ts` reaches the
 * repository through this file, so importing it back would be a cycle.
 */
export async function housekeep(): Promise<void> {
  const repo = await currentRepository();
  if (repo === null) return;
  await repo.purge();
  if (afterPurge !== null) await afterPurge(repo);
}

type AfterPurge = (repo: VaultRepository) => Promise<unknown>;

let afterPurge: AfterPurge | null = null;

export function configureHousekeeping(hooks: { readonly afterPurge: AfterPurge }): void {
  afterPurge = hooks.afterPurge;
}

/* ------------------------------------------------------------------ settings */

export async function settings(): Promise<VaultSettings> {
  return await readSettings();
}

/* ------------------------------------------------------------------ onboarding */

export async function onboarding(): Promise<OnboardingRecord> {
  return await readOnboarding();
}

/**
 * Record progress through the first-run flow.
 *
 * The completion *timestamp* is stamped here rather than sent by the page — see `OnboardingPatch`.
 * `completed: false` clears it, which is the whole of "Replay onboarding": the flow's own resume
 * logic then sees an unfinished record and starts from the top.
 */
export async function updateOnboarding(patch: OnboardingPatch): Promise<OnboardingRecord> {
  const current = await readOnboarding();
  const next: OnboardingRecord = {
    completedAt:
      patch.completed === undefined
        ? current.completedAt
        : patch.completed
          ? (current.completedAt ?? Date.now())
          : null,
    // A replay starts at the beginning unless the same patch says otherwise, so "run it again" does
    // not drop the user back on the last step they finished.
    step: patch.step ?? (patch.completed === false ? 0 : current.step),
    incognitoSkipped: patch.incognitoSkipped ?? current.incognitoSkipped,
  };
  await writeOnboarding(next);
  return next;
}

/**
 * Apply a settings patch.
 *
 * A shortened idle window takes effect immediately rather than at the next user action: someone who
 * has just moved the timeout from 60 minutes to 1 is asking for the vault to be less exposed *now*.
 */
export async function updateSettings(patch: SettingsPatch): Promise<VaultSettings> {
  const current = await readSettings();
  const next: VaultSettings = {
    theme: patch.theme ?? current.theme,
    idleTimeoutMinutes: patch.idleTimeoutMinutes ?? current.idleTimeoutMinutes,
    providerId: patch.providerId ?? current.providerId,
    lockOnBrowserBlur: patch.lockOnBrowserBlur ?? current.lockOnBrowserBlur,
    stripTrackingParams: patch.stripTrackingParams ?? current.stripTrackingParams,
    reuseIncognitoWindow: patch.reuseIncognitoWindow ?? current.reuseIncognitoWindow,
    clearHistoryOnLock: patch.clearHistoryOnLock ?? current.clearHistoryOnLock,
    quickClose: patch.quickClose ?? current.quickClose,
    localThumbnails: patch.localThumbnails ?? current.localThumbnails,
    thumbnailsOffered: patch.thumbnailsOffered ?? current.thumbnailsOffered,
    sortBy: patch.sortBy ?? current.sortBy,
    toolbarIcon: patch.toolbarIcon ?? current.toolbarIcon,
    // `??` rather than `||`: the empty string is a legal value here — it means "use the manifest's
    // own tooltip" — and clearing the field is the only way back to it.
    toolbarTitle: patch.toolbarTitle ?? current.toolbarTitle,
    sidebarWidth: patch.sidebarWidth ?? current.sidebarWidth,
    detailWidth: patch.detailWidth ?? current.detailWidth,
  };
  await writeSettings(next);
  applyIdleDetection(next);
  // The toolbar is the one setting whose effect is outside any window this page could repaint, so
  // it is applied here rather than left to the `SETTINGS_CHANGED` broadcast — which the worker does
  // not receive from itself in any case.
  await applyToolbarAppearance(next);

  // The synced half goes into the vault, where it is encrypted and where other devices will find
  // it. Stamped rather than replaced wholesale: a field whose value did not change keeps its old
  // timestamp, so opening the settings screen cannot outrank another device's real edit. A width
  // change moves nothing here and therefore costs no sync.
  const repo = await currentRepository();
  if (repo !== null) {
    const stamped = stampSettings(repo.syncedSettings(), current, next, Date.now());
    if (await repo.setSyncedSettings(stamped)) scheduleSync();
  }

  const record = await readRecord();
  if (record !== null) {
    const now = Date.now();
    const unlockedUntil = deadlineFrom(next, now);
    await armAutolock(unlockedUntil, now);
    // Switching the blur lock on has to start the watch that implements it, and bind the session to
    // the window it was switched on in — the toggle is a live one, not something that waits for the
    // next unlock.
    const focusWindowId = next.lockOnBrowserBlur ? await owningWindowId() : null;
    await writeRecord({ ...record, unlockedUntil, providerId: next.providerId, focusWindowId });
    await armFocusWatch(next);
  }

  await broadcast({ type: 'SETTINGS_CHANGED', settings: next });
  return next;
}
