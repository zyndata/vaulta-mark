/**
 * The service worker as a whole: the message router, the error-code mapping, the listeners it
 * registers during initial evaluation, and the cold-start budget.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTOLOCK_ALARM, HOUSEKEEPING_ALARM } from '../../../src/background/autolock.js';
import { VaultRepository } from '../../../src/storage/repo.js';
import { DEFAULT_SETTINGS, ROOT_ID } from '../../../src/vault/types.js';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
  type StorageSnapshot,
} from '../../mocks/chrome.js';

const PASSWORD = 'correct horse battery staple';

/**
 * The cold-start budget from ARCHITECTURE §7.2, in milliseconds.
 *
 * CI runners are roughly 3× slower than a development machine, and the number that matters is the
 * one on the user's hardware — so the budget is the spec's 50 ms locally and tripled in CI rather
 * than being relaxed to the point where it would stop catching a regression.
 */
const COLD_START_BUDGET_MS = process.env['CI'] === undefined ? 50 : 150;

type WorkerModule = typeof import('../../../src/background/index.js');

let mock: ChromeMock;
let worker: WorkerModule;
let seeded: StorageSnapshot;

async function startWorker(): Promise<WorkerModule> {
  vi.resetModules();
  worker = await import('../../../src/background/index.js');
  return worker;
}

beforeAll(async () => {
  mock = installChromeMock();
  const repo = new VaultRepository({ coalesceMs: 0 });
  await repo.create(PASSWORD);
  await repo.apply([
    { kind: 'add', input: { type: 'bookmark', parentId: ROOT_ID, title: 'Seed', url: 'https://a.invalid/' } },
  ]);
  await repo.flush();
  seeded = structuredClone(mock.storage.local.snapshot());
  uninstallChromeMock();
}, 60_000);

beforeEach(async () => {
  mock = installChromeMock({ manifestVersion: '1.2.3' });
  await mock.storage.local.set(structuredClone(seeded));
  await startWorker();
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallChromeMock();
});

describe('message router', () => {
  it('answers PING with the running version', async () => {
    await expect(mock.sendMessage({ type: 'PING' })).resolves.toEqual({
      type: 'PONG',
      version: '1.2.3',
    });
  });

  it('stays silent for messages that are not ours', async () => {
    for (const message of [null, undefined, 'PING', 42, {}, { type: 'NOT_OURS' }, []]) {
      await expect(mock.sendMessage(message)).resolves.toBeUndefined();
    }
  });

  it('reports a locked vault that exists, with its settings', async () => {
    await expect(mock.sendMessage({ type: 'GET_STATE' })).resolves.toEqual({
      type: 'STATE',
      exists: true,
      locked: true,
      unlockedUntil: null,
      settings: DEFAULT_SETTINGS,
    });
  });

  it('unlocks, touches, reports and locks', async () => {
    await expect(mock.sendMessage({ type: 'UNLOCK', password: PASSWORD })).resolves.toEqual({
      type: 'OK',
    });

    const state = (await mock.sendMessage({ type: 'GET_STATE' })) as { locked: boolean };
    expect(state.locked).toBe(false);

    const touched = (await mock.sendMessage({ type: 'TOUCH' })) as { unlockedUntil: number };
    expect(touched.unlockedUntil).toBeGreaterThan(Date.now());

    await expect(mock.sendMessage({ type: 'LOCK' })).resolves.toEqual({ type: 'OK' });
    expect(mock.storage.session.snapshot()).toEqual({});
  }, 30_000);

  it('panic-locks when asked to', async () => {
    await mock.sendMessage({ type: 'UNLOCK', password: PASSWORD });
    const seen = mock.observeMessages();
    await expect(mock.sendMessage({ type: 'LOCK', panic: true })).resolves.toEqual({ type: 'OK' });
    expect(seen).toContainEqual({ type: 'SESSION_LOCKED', reason: 'panic' });
  }, 30_000);

  it('reads and writes settings', async () => {
    await expect(mock.sendMessage({ type: 'GET_SETTINGS' })).resolves.toEqual({
      type: 'SETTINGS',
      settings: DEFAULT_SETTINGS,
    });
    await expect(
      mock.sendMessage({ type: 'SET_SETTINGS', settings: { idleTimeoutMinutes: 30 } }),
    ).resolves.toEqual({
      type: 'SETTINGS',
      settings: { ...DEFAULT_SETTINGS, idleTimeoutMinutes: 30 },
    });
  });

  it('refuses a settings patch it cannot validate, instead of half-applying it', async () => {
    await expect(
      mock.sendMessage({ type: 'SET_SETTINGS', settings: { theme: 'chartreuse' } }),
    ).resolves.toBeUndefined();
    await expect(mock.sendMessage({ type: 'GET_SETTINGS' })).resolves.toEqual({
      type: 'SETTINGS',
      settings: DEFAULT_SETTINGS,
    });
  });
});

describe('errors on the wire', () => {
  it('reports a wrong password as its own code, not as a generic failure', async () => {
    await expect(mock.sendMessage({ type: 'UNLOCK', password: 'wrong' })).resolves.toEqual({
      type: 'ERROR',
      code: 'WRONG_PASSWORD',
    });
  }, 30_000);

  it('reports creating a vault where one already exists', async () => {
    await expect(
      mock.sendMessage({ type: 'CREATE_VAULT', password: PASSWORD }),
    ).resolves.toEqual({ type: 'ERROR', code: 'VAULT_STATE' });
  });

  it('reports a password below the floor without deriving anything', async () => {
    await mock.storage.local.clear();
    await expect(mock.sendMessage({ type: 'CREATE_VAULT', password: 'short' })).resolves.toEqual({
      type: 'ERROR',
      code: 'PASSWORD_TOO_SHORT',
    });
  });

  it('reports unlocking a profile that has no vault', async () => {
    await mock.storage.local.clear();
    await expect(mock.sendMessage({ type: 'UNLOCK', password: PASSWORD })).resolves.toEqual({
      type: 'ERROR',
      code: 'VAULT_STATE',
    });
  });

  it('maps every error class in the taxonomy', async () => {
    const crypto = await import('../../../src/crypto/errors.js');
    const vault = await import('../../../src/vault/errors.js');

    expect(worker.toErrorCode(new crypto.WrongPasswordError())).toBe('WRONG_PASSWORD');
    expect(worker.toErrorCode(new crypto.CorruptVaultError())).toBe('CORRUPT_VAULT');
    expect(worker.toErrorCode(new crypto.UnsupportedSchemaError(3, 2))).toBe('UNSUPPORTED_SCHEMA');
    expect(worker.toErrorCode(new vault.WeakPasswordError(10))).toBe('PASSWORD_TOO_SHORT');
    expect(worker.toErrorCode(new vault.VaultLockedError('reading'))).toBe('VAULT_LOCKED');
    expect(worker.toErrorCode(new vault.VaultStateError('nope'))).toBe('VAULT_STATE');
    expect(worker.toErrorCode(new vault.ItemNotFoundError('x'))).toBe('UNKNOWN');
    expect(worker.toErrorCode(new Error('something else'))).toBe('UNKNOWN');
    expect(worker.toErrorCode('not even an error')).toBe('UNKNOWN');
  });

  it('carries no message, so nothing sensitive can ride along', async () => {
    const response = await mock.sendMessage({ type: 'UNLOCK', password: 'wrong' });
    expect(Object.keys(response as object).sort()).toEqual(['code', 'type']);
  }, 30_000);
});

describe('listeners registered during initial evaluation', () => {
  it('hardens storage.session and arms housekeeping on install and on browser start', async () => {
    mock.triggerInstalled();
    await vi.waitFor(() => {
      expect(mock.storage.session.accessLevel).toBe('TRUSTED_CONTEXTS');
      expect(mock.alarms.has(HOUSEKEEPING_ALARM)).toBe(true);
    });

    await chrome.alarms.clearAll();
    mock.triggerStartup();
    await vi.waitFor(() => {
      expect(mock.alarms.has(HOUSEKEEPING_ALARM)).toBe(true);
    });
  });

  it('locks on the auto-lock alarm once the deadline has passed', async () => {
    await mock.sendMessage({ type: 'UNLOCK', password: PASSWORD });
    const state = (await mock.sendMessage({ type: 'GET_STATE' })) as { unlockedUntil: number };
    vi.spyOn(Date, 'now').mockReturnValue(state.unlockedUntil + 1);

    mock.triggerAlarm(AUTOLOCK_ALARM);

    await vi.waitFor(() => {
      expect(mock.storage.session.snapshot()).toEqual({});
    });
  }, 30_000);

  it('panic-locks from the keyboard command', async () => {
    await mock.sendMessage({ type: 'UNLOCK', password: PASSWORD });
    mock.triggerCommand('panic-lock');
    await vi.waitFor(() => {
      expect(mock.storage.session.snapshot()).toEqual({});
    });
  }, 30_000);

  it('opens the manager from the keyboard command', async () => {
    mock.triggerCommand('open-manager');
    await vi.waitFor(() => {
      expect(mock.createdTabs).toHaveLength(1);
    });
  });

  it('locks on blur only once the setting is on', async () => {
    await mock.sendMessage({ type: 'UNLOCK', password: PASSWORD });

    // Default is off, so losing focus changes nothing. Give the handler a turn to prove it.
    mock.triggerFocusChanged(chrome.windows.WINDOW_ID_NONE);
    await Promise.resolve();
    expect(mock.storage.session.snapshot()['vm.session']).toBeDefined();

    await mock.sendMessage({ type: 'SET_SETTINGS', settings: { lockOnBrowserBlur: true } });

    // Even switched on, focus moving to another Chrome *window* must not lock, or every
    // open-in-incognito would lock the vault behind it.
    mock.triggerFocusChanged(7);
    await Promise.resolve();
    expect(mock.storage.session.snapshot()['vm.session']).toBeDefined();

    mock.triggerFocusChanged(chrome.windows.WINDOW_ID_NONE);
    await vi.waitFor(() => {
      expect(mock.storage.session.snapshot()).toEqual({});
    });
  }, 30_000);
});

describe('cold start', () => {
  it('answers its first message inside the budget, without reading storage', async () => {
    uninstallChromeMock();
    mock = installChromeMock({ manifestVersion: '1.2.3' });
    const localGet = vi.spyOn(mock.storage.local, 'get');
    const sessionGet = vi.spyOn(mock.storage.session, 'get');
    vi.resetModules();

    const started = performance.now();
    await import('../../../src/background/index.js');
    const response = await mock.sendMessage({ type: 'PING' });
    const elapsed = performance.now() - started;

    expect(response).toEqual({ type: 'PONG', version: '1.2.3' });
    // The real guarantee behind the budget: the entry registers listeners and returns. Every
    // storage read, key derivation and decryption is lazy, so this holds however slow the runner is.
    expect(localGet).not.toHaveBeenCalled();
    expect(sessionGet).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(COLD_START_BUDGET_MS);
  });
});
