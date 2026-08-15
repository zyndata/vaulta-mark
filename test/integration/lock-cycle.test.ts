/**
 * The full lock lifecycle through the service worker, as a UI would drive it: create → use →
 * idle-expire → unlock again, with the worker being killed at the points where MV3 actually kills
 * it.
 *
 * Everything goes over `chrome.runtime.sendMessage`, so this exercises the message contract, the
 * router, session custody and the alarm together. A test that reached into `session.ts` directly
 * would pass while the popup was unusable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTOLOCK_ALARM } from '../../src/background/autolock.js';
import { ROOT_ID } from '../../src/vault/types.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../mocks/chrome.js';

const PASSWORD = 'a reasonably long master password';
const TITLE = 'Vaulted while unlocked';
const URL = 'https://example.invalid/private';

let mock: ChromeMock;

/**
 * Import the worker as a cold MV3 start does: the old worker's listeners go with it, the module
 * registry is fresh, and `storage.local` is exactly as the previous worker left it.
 */
async function startWorker(): Promise<void> {
  mock.terminateWorker();
  vi.resetModules();
  await import('../../src/background/index.js');
}

/** The unlocked repository the worker is holding, for the steps a UI cannot do yet (Phase 5). */
async function repository(): Promise<import('../../src/storage/repo.js').VaultRepository> {
  const session = await import('../../src/background/session.js');
  const repo = await session.currentRepository();
  if (repo === null) throw new Error('expected an unlocked vault');
  return repo;
}

async function stateOf(): Promise<{ exists: boolean; locked: boolean; unlockedUntil: number | null }> {
  return (await mock.sendMessage({ type: 'GET_STATE' })) as {
    exists: boolean;
    locked: boolean;
    unlockedUntil: number | null;
  };
}

beforeEach(async () => {
  mock = installChromeMock();
  await startWorker();
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallChromeMock();
});

describe('create → unlock → idle-expire → unlock again', () => {
  it('walks the whole cycle over the message contract', async () => {
    // A fresh profile: no vault, so the popup shows the create screen.
    await expect(stateOf()).resolves.toMatchObject({
      exists: false,
      locked: true,
      unlockedUntil: null,
    });

    await expect(mock.sendMessage({ type: 'CREATE_VAULT', password: PASSWORD })).resolves.toEqual({
      type: 'OK',
    });

    const created = await stateOf();
    expect(created).toMatchObject({ exists: true, locked: false });
    expect(created.unlockedUntil).toBeGreaterThan(Date.now());
    expect(mock.alarms.has(AUTOLOCK_ALARM)).toBe(true);

    // Save something, so the reopened vault has to actually decrypt.
    const repo = await repository();
    await repo.apply([
      { kind: 'add', input: { type: 'bookmark', parentId: ROOT_ID, title: TITLE, url: URL } },
    ]);
    await repo.flush();

    // The worker dies and restarts — the session survives it and no password is needed.
    await startWorker();
    await expect(stateOf()).resolves.toMatchObject({ locked: false });
    expect((await repository()).getAll().map((item) => item.title)).toEqual([TITLE]);

    // The user walks away. The alarm fires after the deadline, and the vault locks itself.
    const deadline = (await stateOf()).unlockedUntil!;
    vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
    mock.triggerAlarm(AUTOLOCK_ALARM);
    await vi.waitFor(async () => {
      await expect(stateOf()).resolves.toMatchObject({ exists: true, locked: true });
    });
    expect(mock.storage.session.snapshot()).toEqual({});
    expect(mock.alarms.has(AUTOLOCK_ALARM)).toBe(false);

    // A wrong password does not reopen it, and does not leave a session behind either.
    await expect(mock.sendMessage({ type: 'UNLOCK', password: 'not it' })).resolves.toEqual({
      type: 'ERROR',
      code: 'WRONG_PASSWORD',
    });
    expect(mock.storage.session.snapshot()).toEqual({});

    // The right one does, and the bookmark is still there.
    await expect(mock.sendMessage({ type: 'UNLOCK', password: PASSWORD })).resolves.toEqual({
      type: 'OK',
    });
    await expect(stateOf()).resolves.toMatchObject({ locked: false });
    expect((await repository()).getAll().map((item) => item.title)).toEqual([TITLE]);
  }, 120_000);

  it('locks on a restart that finds an expired session, with no alarm involved at all', async () => {
    await mock.sendMessage({ type: 'CREATE_VAULT', password: PASSWORD });
    const deadline = (await stateOf()).unlockedUntil!;

    // Suppress every alarm, the way a suspended laptop or a killed worker does, and come back
    // after the deadline. The `unlockedUntil` check is the authority (ARCHITECTURE §7.3).
    await chrome.alarms.clearAll();
    await startWorker();
    vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);

    await expect(stateOf()).resolves.toMatchObject({ exists: true, locked: true });
    expect(mock.storage.session.snapshot()).toEqual({});
  }, 120_000);

  it('never writes vault plaintext anywhere, unlocked or locked (INV-6)', async () => {
    await mock.sendMessage({ type: 'CREATE_VAULT', password: PASSWORD });
    const repo = await repository();
    await repo.apply([
      {
        kind: 'add',
        input: {
          type: 'bookmark',
          parentId: ROOT_ID,
          title: TITLE,
          url: URL,
          tags: ['secret-tag'],
          note: 'a private note',
        },
      },
    ]);
    await repo.flush();

    const stored = (): string =>
      JSON.stringify([
        mock.storage.local.snapshot(),
        mock.storage.sync.snapshot(),
        mock.storage.session.snapshot(),
      ]);

    for (const token of [TITLE, URL, 'secret-tag', 'a private note', PASSWORD]) {
      expect(stored()).not.toContain(token);
    }

    await mock.sendMessage({ type: 'LOCK' });
    for (const token of [TITLE, URL, 'secret-tag', 'a private note', PASSWORD]) {
      expect(stored()).not.toContain(token);
    }
  }, 120_000);
});
