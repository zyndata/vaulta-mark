/**
 * The service worker as a whole: the message router, the error-code mapping, the listeners it
 * registers during initial evaluation, and the cold-start budget.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTOLOCK_ALARM,
  BLUR_SETTLE_MS,
  HOUSEKEEPING_ALARM,
} from '../../../src/background/autolock.js';
import { VaultRepository } from '../../../src/storage/repo.js';
import { DEFAULT_SETTINGS, ROOT_ID } from '../../../src/vault/types.js';
import { budgetMs } from '../../helpers/budget.js';
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
 * The spec's 50 ms is the number that matters, because it is the one on the user's hardware. It is
 * tripled rather than dropped whenever this run cannot measure it honestly — a CI runner is about
 * 3× slower, and so, in effect, is a laptop running ninety-five test files at once. Which of the
 * two applies is decided in one place: see `test/helpers/budget.ts`.
 */
const COLD_START_BUDGET_MS = budgetMs(50, 150);

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

afterEach(async () => {
  // The worker schedules a wake probe on every evaluation (§13.4). Cancelling it here is the same
  // hygiene `terminateWorker()` provides for listeners: a timer from a torn-down registry firing
  // into the next test's browser is the documented way this suite goes mysteriously wrong.
  (await import('../../../src/sync/engine.js')).resetSync();
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
      adoptable: false,
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
    const add = await import('../../../src/background/add.js');

    expect(worker.toErrorCode(new crypto.WrongPasswordError())).toBe('WRONG_PASSWORD');
    expect(worker.toErrorCode(new crypto.CorruptVaultError())).toBe('CORRUPT_VAULT');
    expect(worker.toErrorCode(new crypto.UnsupportedSchemaError(3, 2))).toBe('UNSUPPORTED_SCHEMA');
    expect(worker.toErrorCode(new vault.WeakPasswordError(10))).toBe('PASSWORD_TOO_SHORT');
    expect(worker.toErrorCode(new vault.VaultLockedError('reading'))).toBe('VAULT_LOCKED');
    expect(worker.toErrorCode(new vault.VaultStateError('nope'))).toBe('VAULT_STATE');
    expect(worker.toErrorCode(new vault.ItemNotFoundError('x'))).toBe('ITEM_NOT_FOUND');
    expect(worker.toErrorCode(new vault.UnsupportedUrlError('internal-page'))).toBe(
      'URL_INTERNAL_PAGE',
    );
    expect(worker.toErrorCode(new vault.UnsupportedUrlError('local-file'))).toBe('URL_LOCAL_FILE');
    expect(worker.toErrorCode(new vault.UnsupportedUrlError('unsupported-scheme'))).toBe(
      'URL_UNSUPPORTED_SCHEME',
    );
    expect(worker.toErrorCode(new add.NoActiveTabError())).toBe('NO_ACTIVE_TAB');
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

  it('creates the context menus on install and on browser start', async () => {
    mock.triggerInstalled();
    await vi.waitFor(() => {
      expect(mock.menus.size).toBe(2);
    });

    // `contextMenus.create` throws on a duplicate id, and the worker restarts constantly — so a
    // second start has to be a no-op rather than an exception nobody sees.
    mock.triggerStartup();
    await vi.waitFor(() => {
      expect(mock.menus.size).toBe(2);
    });
  });

  it('vaults the active tab from the keyboard shortcut and says so on the badge', async () => {
    await mock.sendMessage({ type: 'UNLOCK', password: PASSWORD });
    mock.openTabs.push({ id: 1, url: 'https://example.com/x', title: 'X', active: true });

    mock.triggerCommand('add-current-tab');

    await vi.waitFor(() => {
      expect(mock.badgeText()).toBe('✓');
    });
    const listed = (await mock.sendMessage({ type: 'LIST_ITEMS' })) as { total: number };
    expect(listed.total).toBe(2);
  }, 30_000);

  it('says on the badge that the vault is locked, since a shortcut has no window', async () => {
    mock.openTabs.push({ id: 1, url: 'https://example.com/x', title: 'X', active: true });
    mock.triggerCommand('add-current-tab');

    await vi.waitFor(() => {
      expect(mock.badgeText()).toBe('🔒');
    });
  });

  it('vaults a link from the context menu', async () => {
    await mock.sendMessage({ type: 'UNLOCK', password: PASSWORD });
    mock.triggerMenuClick({ menuItemId: 'vm.add-link', linkUrl: 'https://example.com/linked' });

    await vi.waitFor(() => {
      expect(mock.badgeText()).toBe('✓');
    });
    const listed = (await mock.sendMessage({ type: 'LIST_ITEMS', query: 'linked' })) as {
      total: number;
    };
    expect(listed.total).toBe(1);
  }, 30_000);

  it('flags a page it will not vault, rather than failing silently', async () => {
    await mock.sendMessage({ type: 'UNLOCK', password: PASSWORD });
    mock.openTabs.push({ id: 1, url: 'chrome://settings/', title: 'Settings', active: true });

    mock.triggerMenuClick({ menuItemId: 'vm.add-page' });

    await vi.waitFor(() => {
      expect(mock.badgeText()).toBe('!');
    });
  }, 30_000);

  it('locks on blur only once the setting is on', async () => {
    // A window for the session to belong to. Chrome always has one; the mock does not until asked.
    const home = await chrome.windows.create({ url: 'https://example.com/', focused: true });
    await mock.sendMessage({ type: 'UNLOCK', password: PASSWORD });

    // Default is off, so losing focus changes nothing. Give the handler a turn to prove it.
    mock.triggerFocusChanged(chrome.windows.WINDOW_ID_NONE);
    await Promise.resolve();
    expect(mock.storage.session.snapshot()['vm.session']).toBeDefined();

    mock.triggerFocusChanged(home?.id ?? 0);
    await mock.sendMessage({ type: 'SET_SETTINGS', settings: { lockOnBrowserBlur: true } });

    // Fake timers for the settle, so the file does not spend real seconds waiting for it — and so
    // no stray timer of the worker's own outlives the mock this test installed.
    vi.useFakeTimers();
    try {
      // The focus coming back to the window the session belongs to is not a blur, whatever
      // `onFocusChanged` says on the way: the popup opening and closing is exactly this pair.
      mock.triggerFocusChanged(chrome.windows.WINDOW_ID_NONE);
      mock.triggerFocusChanged(home?.id ?? 0);
      await vi.advanceTimersByTimeAsync(BLUR_SETTLE_MS + 250);
      expect(mock.storage.session.snapshot()['vm.session']).toBeDefined();

      // Leaving that window is what locks — here by leaving Chrome altogether.
      mock.triggerFocusChanged(chrome.windows.WINDOW_ID_NONE);
      await vi.advanceTimersByTimeAsync(BLUR_SETTLE_MS + 250);
      expect(mock.storage.session.snapshot()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  /*
   * The other Chrome window is not an exception, which is the whole difference from how this
   * behaved before 2026-08-22: the setting says "lock when the current window loses focus", and a
   * second Chrome window is something the current window lost focus to.
   */
  it('locks when the focus moves to another Chrome window', async () => {
    const home = await chrome.windows.create({ url: 'https://example.com/', focused: true });
    await mock.sendMessage({ type: 'UNLOCK', password: PASSWORD });
    mock.triggerFocusChanged(home?.id ?? 0);
    await mock.sendMessage({ type: 'SET_SETTINGS', settings: { lockOnBrowserBlur: true } });

    vi.useFakeTimers();
    try {
      const other = await chrome.windows.create({ incognito: true, focused: true });
      mock.triggerFocusChanged(other?.id ?? 0);
      await vi.advanceTimersByTimeAsync(BLUR_SETTLE_MS + 250);
      expect(mock.storage.session.snapshot()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});

describe('cold start', () => {
  it('answers its first message inside the budget, without reading storage', async () => {
    uninstallChromeMock();
    mock = installChromeMock({ manifestVersion: '1.2.3' });
    const localGet = vi.spyOn(mock.storage.local, 'get');
    const sessionGet = vi.spyOn(mock.storage.session, 'get');

    /**
     * The **best** of several cold starts, not a single one.
     *
     * The number this is guarding is a property of the code — how much work the entry point does
     * before it can answer — and a single sample in a suite that runs sixty files in parallel
     * measures the machine's scheduler as much as the worker. Anything that genuinely made startup
     * expensive would be in every sample, so the minimum still catches it, while a run that lost its
     * timeslice to another worker's PBKDF2 no longer fails the build.
     *
     * The first sample also pays for Vite transforming the module graph, which Chrome never does:
     * the extension ships one already-bundled file. Later samples re-evaluate from a warm transform
     * cache, which is the closer analogue of a service worker waking up.
     */
    let best = Number.POSITIVE_INFINITY;
    let readsBeforeFirstAnswer = 0;
    for (let sample = 0; sample < 5; sample++) {
      vi.resetModules();
      const started = performance.now();
      await import('../../../src/background/index.js');
      const response = await mock.sendMessage({ type: 'PING' });
      best = Math.min(best, performance.now() - started);
      if (sample === 0) {
        readsBeforeFirstAnswer = localGet.mock.calls.length + sessionGet.mock.calls.length;
      }
      expect(response).toEqual({ type: 'PONG', version: '1.2.3' });
      mock.terminateWorker();
    }

    // The real guarantee behind the budget: the entry registers listeners and returns. Every
    // storage read, key derivation and decryption is lazy, so this holds however slow the runner is.
    //
    // Counted **up to the first answer** rather than over the whole test, because the entry does
    // schedule one thing: the wake probe (§13.4), three seconds out and deliberately after this.
    expect(readsBeforeFirstAnswer).toBe(0);
    expect(best).toBeLessThan(COLD_START_BUDGET_MS);
  }, 30_000);
});
