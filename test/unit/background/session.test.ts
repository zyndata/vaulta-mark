/**
 * Key custody, and INV-7 in particular.
 *
 * PBKDF2 at 600,000 iterations is half a second by design, so the suite creates one vault in
 * `beforeAll` and restores its ciphertext into a fresh mock per test. Only the cases that genuinely
 * need a password pay for a derivation; the rest go through `storage.session`, which is the whole
 * point of the module under test.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTOLOCK_ALARM, NEVER_EXPIRES } from '../../../src/background/autolock.js';
import { LOCAL_KEYS, readSettings } from '../../../src/storage/local.js';
import { VaultRepository } from '../../../src/storage/repo.js';
import { ROOT_ID, isDeleted, TOMBSTONE_TTL_MS } from '../../../src/vault/types.js';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
  type StorageSnapshot,
} from '../../mocks/chrome.js';

const PASSWORD = 'correct horse battery staple';
const TITLE = 'A vaulted bookmark';
const URL = 'https://example.invalid/vaulted';

type SessionModule = typeof import('../../../src/background/session.js');
type VaultErrors = typeof import('../../../src/vault/errors.js');
type CryptoErrors = typeof import('../../../src/crypto/errors.js');

let mock: ChromeMock;
let session: SessionModule;
/**
 * The error classes from the *same* module registry as `session`.
 *
 * `vi.resetModules()` gives the re-imported worker a fresh registry, so a class imported statically
 * at the top of this file is a different constructor object than the one the worker throws and
 * `toThrow(SomeError)` would fail for a reason that has nothing to do with the code under test.
 */
let vaultErrors: VaultErrors;
let cryptoErrors: CryptoErrors;
/** `storage.local` for a vault holding one bookmark. */
let seeded: StorageSnapshot;

/** Re-import the module graph, which is what MV3 does when it restarts a dead worker. */
async function restartWorker(): Promise<SessionModule> {
  vi.resetModules();
  session = await import('../../../src/background/session.js');
  vaultErrors = await import('../../../src/vault/errors.js');
  cryptoErrors = await import('../../../src/crypto/errors.js');
  return session;
}

beforeAll(async () => {
  mock = installChromeMock();
  const repo = new VaultRepository({ coalesceMs: 0 });
  await repo.create(PASSWORD);
  await repo.apply([{ kind: 'add', input: { type: 'bookmark', parentId: ROOT_ID, title: TITLE, url: URL } }]);
  await repo.flush();
  seeded = structuredClone(mock.storage.local.snapshot());
  uninstallChromeMock();
}, 60_000);

beforeEach(async () => {
  mock = installChromeMock();
  await mock.storage.local.set(structuredClone(seeded));
  await restartWorker();
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallChromeMock();
});

/** The base64url DEK currently in `storage.session`, or `undefined`. */
function storedDek(): string | undefined {
  const record = mock.storage.session.snapshot()['vm.session'] as { dek?: string } | undefined;
  return record?.dek;
}

/** Every value VaultaMark has stored, as one string, for a "does this leak" scan. */
function everythingStored(): string {
  return JSON.stringify([
    mock.storage.local.snapshot(),
    mock.storage.sync.snapshot(),
    mock.storage.session.snapshot(),
  ]);
}

describe('unlock', () => {
  it('puts the DEK in storage.session with a deadline and arms the alarm', async () => {
    const unlockedUntil = await session.unlock(PASSWORD);

    expect(storedDek()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(unlockedUntil).toBeGreaterThan(Date.now());
    expect(mock.storage.session.snapshot()['vm.session']).toMatchObject({
      unlockedUntil,
      providerId: 'chrome',
    });
    expect(mock.alarms.has(AUTOLOCK_ALARM)).toBe(true);
  }, 30_000);

  it('leaves the session empty after a wrong password', async () => {
    await expect(session.unlock('not the password')).rejects.toThrow(cryptoErrors.WrongPasswordError);
    expect(mock.storage.session.snapshot()).toEqual({});
    await expect(session.currentRepository()).resolves.toBeNull();
  }, 30_000);

  it('broadcasts SESSION_UNLOCKED', async () => {
    const seen = mock.observeMessages();
    const unlockedUntil = await session.unlock(PASSWORD);
    expect(seen).toContainEqual({ type: 'SESSION_UNLOCKED', unlockedUntil });
  }, 30_000);
});

describe('createVault', () => {
  it('refuses a password below the hard floor before writing anything', async () => {
    await mock.storage.local.clear();
    await restartWorker();
    await expect(session.createVault('short')).rejects.toThrow(vaultErrors.WeakPasswordError);
    expect(mock.storage.local.snapshot()).toEqual({});
    expect(mock.storage.session.snapshot()).toEqual({});
  });

  it('creates and opens a vault in one step', async () => {
    await mock.storage.local.clear();
    await restartWorker();
    await session.createVault(PASSWORD);
    expect(storedDek()).toBeDefined();
    const repo = await session.currentRepository();
    expect(repo?.getAll()).toEqual([]);
  }, 60_000);
});

describe('lock — INV-7', () => {
  it('leaves storage.session empty and no reachable key or item behind', async () => {
    await session.unlock(PASSWORD);
    const dek = storedDek();
    expect(dek).toBeDefined();
    const repo = await session.currentRepository();
    expect(repo).not.toBeNull();

    await session.lock();

    expect(mock.storage.session.snapshot()).toEqual({});
    // The key bytes are nowhere in any storage area, under any key.
    expect(everythingStored()).not.toContain(dek);
    // Nothing that held the vault will hand it back.
    await expect(session.currentRepository()).resolves.toBeNull();
    expect(() => repo?.getAll()).toThrow(vaultErrors.VaultLockedError);
    expect(repo?.locked).toBe(true);
    // And the ciphertext never contained the plaintext in the first place (INV-6).
    expect(everythingStored()).not.toContain(TITLE);
    expect(everythingStored()).not.toContain(URL);
  }, 30_000);

  it('clears the auto-lock alarm and broadcasts the reason', async () => {
    await session.unlock(PASSWORD);
    const seen = mock.observeMessages();
    await session.lock({ reason: 'expired' });
    expect(mock.alarms.has(AUTOLOCK_ALARM)).toBe(false);
    expect(seen).toContainEqual({ type: 'SESSION_LOCKED', reason: 'expired' });
  }, 30_000);

  it('is safe on an already-locked vault', async () => {
    await expect(session.lock()).resolves.toBeUndefined();
    expect(mock.storage.session.snapshot()).toEqual({});
  });

  it('flushes pending writes, because a lock timer must not eat the last edit', async () => {
    await session.unlock(PASSWORD);
    const repo = await session.currentRepository();
    const before = mock.storage.local.snapshot()[LOCAL_KEYS.meta];
    await repo?.apply([{ kind: 'update', id: repo.getAll()[0]!.id, patch: { title: 'Renamed' } }]);

    await session.lock();

    expect(mock.storage.local.snapshot()[LOCAL_KEYS.meta]).not.toEqual(before);
  }, 30_000);

  it('panic-locks without flushing — immediacy is the whole point', async () => {
    await session.unlock(PASSWORD);
    const repo = await session.currentRepository();
    const before = mock.storage.local.snapshot()[LOCAL_KEYS.meta];
    await repo?.apply([{ kind: 'update', id: repo.getAll()[0]!.id, patch: { title: 'Renamed' } }]);

    const seen = mock.observeMessages();
    await session.lock({ reason: 'panic', flush: false });

    // By the time `lock()` resolves — no timer, no second tick — the key is gone and the UIs know.
    expect(mock.storage.session.snapshot()).toEqual({});
    expect(seen).toContainEqual({ type: 'SESSION_LOCKED', reason: 'panic' });
    expect(mock.storage.local.snapshot()[LOCAL_KEYS.meta]).toEqual(before);
  }, 30_000);
});

describe('surviving a service-worker restart', () => {
  it('rehydrates the vault from storage.session and still reads it', async () => {
    await session.unlock(PASSWORD);
    const dek = storedDek();

    // MV3 kills the worker: module state is gone, `storage.session` is not.
    await restartWorker();

    expect(storedDek()).toBe(dek);
    const repo = await session.currentRepository();
    expect(repo?.getAll().map((item) => item.title)).toEqual([TITLE]);
    // No password was needed, and no KDF ran.
  }, 30_000);

  it('locks instead of rehydrating once the deadline has passed', async () => {
    const unlockedUntil = await session.unlock(PASSWORD);
    await restartWorker();

    vi.spyOn(Date, 'now').mockReturnValue(unlockedUntil + 1);

    await expect(session.currentRepository()).resolves.toBeNull();
    expect(mock.storage.session.snapshot()).toEqual({});
  }, 30_000);

  it('enforces the deadline on rehydrate even when the alarm never fired', async () => {
    await session.unlock(PASSWORD);
    // Suppress the alarm entirely, the way a killed worker or a suspended laptop does.
    await chrome.alarms.clearAll();
    const expired = { dek: storedDek(), unlockedUntil: Date.now() - 1, providerId: 'chrome' };
    await chrome.storage.session.set({ 'vm.session': expired });
    await restartWorker();

    await expect(session.state()).resolves.toMatchObject({ locked: true, unlockedUntil: null });
    expect(mock.storage.session.snapshot()).toEqual({});
  }, 30_000);

  it('treats an unusable session record as locked', async () => {
    for (const record of [null, 'nope', {}, { dek: 42, unlockedUntil: Date.now() + 1000 }]) {
      await chrome.storage.session.set({ 'vm.session': record });
      await expect(session.currentRepository()).resolves.toBeNull();
    }
  });

  it('drops a cached vault when the session record is cleared underneath it', async () => {
    await session.unlock(PASSWORD);
    const repo = await session.currentRepository();
    expect(repo).not.toBeNull();

    await chrome.storage.session.clear();

    await expect(session.currentRepository()).resolves.toBeNull();
    expect(repo?.locked).toBe(true);
  }, 30_000);
});

describe('touch', () => {
  it('pushes the deadline out and re-arms the alarm', async () => {
    const first = await session.unlock(PASSWORD);
    const firstAlarm = mock.alarms.get(AUTOLOCK_ALARM)?.scheduledTime;

    vi.spyOn(Date, 'now').mockReturnValue(first - 60_000);
    mock.clock.advance(120_000);
    const second = await session.touch();

    expect(second).toBeGreaterThan(first - 60_000);
    expect(mock.alarms.get(AUTOLOCK_ALARM)?.scheduledTime).toBeGreaterThan(firstAlarm!);
  }, 30_000);

  it('survives a worker restart: the alarm and the deadline both outlive the module', async () => {
    await session.unlock(PASSWORD);
    await restartWorker();

    expect(mock.alarms.has(AUTOLOCK_ALARM)).toBe(true);
    await expect(session.touch()).resolves.toBeGreaterThan(Date.now());
    expect(mock.alarms.has(AUTOLOCK_ALARM)).toBe(true);
  }, 30_000);

  it('returns null on a locked vault and never unlocks anything', async () => {
    await expect(session.touch()).resolves.toBeNull();
    expect(mock.storage.session.snapshot()).toEqual({});
  });

  it('locks a session that expired between actions', async () => {
    const unlockedUntil = await session.unlock(PASSWORD);
    vi.spyOn(Date, 'now').mockReturnValue(unlockedUntil + 1);
    await expect(session.touch()).resolves.toBeNull();
    expect(mock.storage.session.snapshot()).toEqual({});
  }, 30_000);

  it('does not rewrite the record for a session that never expires', async () => {
    await session.unlock(PASSWORD);
    await session.updateSettings({ idleTimeoutMinutes: 0 });
    const record = mock.storage.session.snapshot()['vm.session'];

    await expect(session.touch()).resolves.toBe(NEVER_EXPIRES);
    expect(mock.storage.session.snapshot()['vm.session']).toEqual(record);
    expect(mock.alarms.has(AUTOLOCK_ALARM)).toBe(false);
  }, 30_000);
});

describe('enforceDeadline', () => {
  it('re-arms rather than locking when the alarm fired early', async () => {
    const unlockedUntil = await session.unlock(PASSWORD);
    await chrome.alarms.clearAll();

    await session.enforceDeadline();

    expect(mock.alarms.has(AUTOLOCK_ALARM)).toBe(true);
    await expect(session.state()).resolves.toMatchObject({ locked: false, unlockedUntil });
  }, 30_000);

  it('locks once the deadline really has passed', async () => {
    const unlockedUntil = await session.unlock(PASSWORD);
    vi.spyOn(Date, 'now').mockReturnValue(unlockedUntil + 1);

    await session.enforceDeadline();

    expect(mock.storage.session.snapshot()).toEqual({});
    expect(mock.alarms.has(AUTOLOCK_ALARM)).toBe(false);
  }, 30_000);

  it('clears a stale alarm when there is no session at all', async () => {
    await chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: 1 });
    await session.enforceDeadline();
    expect(mock.alarms.has(AUTOLOCK_ALARM)).toBe(false);
  });
});

describe('state', () => {
  it('reports a vault that exists but is locked', async () => {
    await expect(session.state()).resolves.toEqual({
      exists: true,
      adoptable: false,
      locked: true,
      unlockedUntil: null,
    });
  });

  it('reports a profile with no vault', async () => {
    await mock.storage.local.clear();
    await expect(session.state()).resolves.toEqual({
      exists: false,
      adoptable: false,
      locked: true,
      unlockedUntil: null,
    });
  });

  it('does not go looking in sync for a profile that already has a vault', async () => {
    // One `storage.sync` read per popup open, for an answer the create/unlock choice does not need
    // once a local vault exists.
    const reads: unknown[] = [];
    const original = mock.storage.sync.get;
    mock.storage.sync.get = (keys) => {
      reads.push(keys);
      return original(keys);
    };
    await session.state();
    expect(reads).toEqual([]);
    mock.storage.sync.get = original;
  });

  it('reports an open vault', async () => {
    const unlockedUntil = await session.unlock(PASSWORD);
    await expect(session.state()).resolves.toEqual({
      exists: true,
      adoptable: false,
      locked: false,
      unlockedUntil,
    });
  }, 30_000);
});

describe('settings', () => {
  it('merges a patch and leaves the rest alone', async () => {
    const next = await session.updateSettings({ theme: 'dark' });
    expect(next.theme).toBe('dark');
    expect(next.idleTimeoutMinutes).toBe(10);
    expect(await readSettings()).toEqual(next);
    await expect(session.settings()).resolves.toEqual(next);
  });

  it('broadcasts the change', async () => {
    const seen = mock.observeMessages();
    const next = await session.updateSettings({ lockOnBrowserBlur: true });
    expect(seen).toContainEqual({ type: 'SETTINGS_CHANGED', settings: next });
  });

  it('shortens a live idle window immediately, not at the next user action', async () => {
    const before = await session.unlock(PASSWORD);
    await session.updateSettings({ idleTimeoutMinutes: 1 });
    const after = mock.storage.session.snapshot()['vm.session'] as { unlockedUntil: number };
    expect(after.unlockedUntil).toBeLessThan(before);
  }, 30_000);

  it('clears the alarm when the idle window is set to never', async () => {
    await session.unlock(PASSWORD);
    await session.updateSettings({ idleTimeoutMinutes: 0 });
    expect(mock.alarms.has(AUTOLOCK_ALARM)).toBe(false);
    const record = mock.storage.session.snapshot()['vm.session'] as { unlockedUntil: number };
    expect(record.unlockedUntil).toBe(NEVER_EXPIRES);
  }, 30_000);

  it('does not touch the session record while the vault is locked', async () => {
    await session.updateSettings({ idleTimeoutMinutes: 1 });
    expect(mock.storage.session.snapshot()).toEqual({});
  });
});

describe('housekeep', () => {
  it('does nothing while locked', async () => {
    const before = mock.storage.local.snapshot();
    await session.housekeep();
    expect(mock.storage.local.snapshot()).toEqual(before);
  });

  it('purges tombstones past the TTL', async () => {
    await session.unlock(PASSWORD);
    // "Never auto-lock", so pushing the clock forward 90 days does not simply expire the session:
    // the thing under test is the purge, not the deadline.
    await session.updateSettings({ idleTimeoutMinutes: 0 });
    const repo = await session.currentRepository();
    const id = repo!.getAll()[0]!.id;
    await repo!.apply([{ kind: 'delete', id }]);
    await repo!.flush();
    expect(repo!.getAll({ includeDeleted: true }).filter(isDeleted)).toHaveLength(1);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TOMBSTONE_TTL_MS + 1);
    await session.housekeep();

    expect(repo!.getAll({ includeDeleted: true })).toEqual([]);
  }, 30_000);
});

describe('hardenSessionStorage', () => {
  it('pins the session area to trusted contexts', async () => {
    await session.hardenSessionStorage();
    expect(mock.storage.session.accessLevel).toBe('TRUSTED_CONTEXTS');
  });
});
