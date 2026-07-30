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
import { readHeader, readSettings, writeSettings } from '../storage/local.js';
import { VaultRepository } from '../storage/repo.js';
import type { LockReason, SettingsPatch } from '../shared/messages.js';
import { broadcast } from '../shared/messages.js';
import { VaultLockedError } from '../vault/errors.js';
import type { VaultSettings } from '../vault/types.js';
import {
  applyIdleDetection,
  armAutolock,
  clearAutolock,
  deadlineFrom,
  neverExpires,
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
}

export interface SessionState {
  /** Whether this profile holds a vault at all — the difference between "create" and "unlock". */
  readonly exists: boolean;
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

/** Unlock with the master password. Throws `WrongPasswordError` on a failed DEK unwrap (D12). */
export async function unlock(password: string): Promise<number> {
  const next = new VaultRepository();
  await next.unlock(password);
  repository = next;
  return await startSession(next);
}

async function startSession(repo: VaultRepository): Promise<number> {
  const settings = await readSettings();
  const now = Date.now();
  const unlockedUntil = deadlineFrom(settings, now);

  const dek = repo.exportDek();
  try {
    await writeRecord({ dek: toBase64Url(dek), unlockedUntil, providerId: settings.providerId });
  } finally {
    // The base64url string is what `storage.session` keeps; this buffer was only a courier.
    zero(dek);
  }

  await armAutolock(unlockedUntil, now);
  applyIdleDetection(settings);
  await broadcast({ type: 'SESSION_UNLOCKED', unlockedUntil });
  return unlockedUntil;
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

  const current = repository;
  repository = null;

  if (!flush) await chrome.storage.session.clear();
  if (current !== null) await current.lock({ flush });
  // INV-7 is "empty", not "our key is gone": `clear()` rather than `remove(SESSION_KEY)`, so a key
  // written by a later phase cannot survive a lock by being forgotten here.
  await chrome.storage.session.clear();
  await clearAutolock();
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

  const dek = fromBase64Url(record.dek);
  const next = new VaultRepository();
  try {
    await next.unlockWithDek(dek);
  } finally {
    zero(dek);
  }
  repository = next;
  return next;
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
  const record = await readRecord();
  if (record === null) return { exists, locked: true, unlockedUntil: null };
  if (record.unlockedUntil <= Date.now()) {
    await lock({ reason: 'expired' });
    return { exists, locked: true, unlockedUntil: null };
  }
  return { exists, locked: false, unlockedUntil: record.unlockedUntil };
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

/** Periodic upkeep that needs the key: purge tombstones past the 90-day TTL (D20). */
export async function housekeep(): Promise<void> {
  const repo = await currentRepository();
  if (repo === null) return;
  await repo.purge();
}

/* ------------------------------------------------------------------ settings */

export async function settings(): Promise<VaultSettings> {
  return await readSettings();
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
  };
  await writeSettings(next);
  applyIdleDetection(next);

  const record = await readRecord();
  if (record !== null) {
    const now = Date.now();
    const unlockedUntil = deadlineFrom(next, now);
    await writeRecord({ ...record, unlockedUntil, providerId: next.providerId });
    await armAutolock(unlockedUntil, now);
  }

  await broadcast({ type: 'SETTINGS_CHANGED', settings: next });
  return next;
}
