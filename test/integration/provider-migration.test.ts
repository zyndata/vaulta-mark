/**
 * Moving a vault between backends, both ways (ARCHITECTURE §6.6).
 *
 * Real repository, real providers, real ciphertext; the browser and `fetch` are mocked. The property
 * every case here is about is the one §6.6 ends on: **if verification fails, the original provider
 * stays active and nothing is flipped.** A migration is allowed to fail; it is not allowed to leave
 * a device pointed at a backend that does not have its bookmarks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSettings, writeSettings } from '../../src/storage/local.js';
import { VaultRepository } from '../../src/storage/repo.js';
import { ChromeSyncProvider } from '../../src/sync/chrome-provider.js';
import { DriveApi } from '../../src/sync/drive/api.js';
import { DriveAuth } from '../../src/sync/drive/auth.js';
import { DriveSyncProvider, VAULT_FILE_NAME } from '../../src/sync/drive/provider.js';
import { configureSync, resetSync, syncNow } from '../../src/sync/engine.js';
import { migrateProvider } from '../../src/sync/migration.js';
import { WriteBudget, type BudgetStore } from '../../src/sync/rate.js';
import type { ProviderId, SyncProvider } from '../../src/sync/provider.js';
import { DEFAULT_SETTINGS } from '../../src/vault/types.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../mocks/chrome.js';
import { DriveMock } from '../mocks/drive.js';

const PASSWORD = 'a reasonably long master password';

const roomyBudget: BudgetStore = { read: () => Promise.resolve([]), write: () => Promise.resolve() };

let mock: ChromeMock;
let drive: DriveMock;
let repo: VaultRepository;
let drives: DriveSyncProvider;

function providers(): (id: ProviderId) => SyncProvider {
  return (id) =>
    id === 'drive'
      ? drives
      : new ChromeSyncProvider({
          budget: new WriteBudget({ store: roomyBudget, perMinute: 1e9, perHour: 1e9 }),
        });
}

function migrate(
  to: ProviderId,
  over: { clearSource?: boolean; replaceExisting?: boolean } = {},
) {
  return migrateProvider(to, {
    repository: () => Promise.resolve(repo),
    provider: providers(),
    ...over,
  });
}

/** Sync through whichever provider the settings now name — the thing a migration hands over to. */
async function sync(): Promise<void> {
  configureSync({ repository: () => Promise.resolve(repo), provider: providers() });
  await syncNow();
}

async function add(id: string, title: string, note = ''): Promise<void> {
  await repo.apply([
    {
      kind: 'add',
      input: {
        type: 'bookmark',
        id,
        url: `https://example.com/${id}`,
        title,
        ...(note === '' ? {} : { note }),
      },
    },
  ]);
  await repo.flush();
}

function titles(): Record<string, string> {
  return Object.fromEntries(repo.getAll().map((item) => [item.id, item.title]));
}

beforeEach(async () => {
  resetSync();
  mock = installChromeMock({ grantedPermissions: ['identity'] });
  drive = new DriveMock();
  const auth = new DriveAuth({ clientId: 'test-client', fetch: drive.fetch });
  drives = new DriveSyncProvider({
    auth,
    api: new DriveApi({ auth, fetch: drive.fetch, sleep: () => Promise.resolve() }),
  });
  repo = new VaultRepository();
  await repo.create(PASSWORD);
  await repo.flush();
}, 30_000);

afterEach(() => {
  resetSync();
  uninstallChromeMock();
});

describe('chrome → drive', () => {
  it('carries every item, verifies it, and flips only then', async () => {
    await add('a', 'Alpha');
    await add('b', 'Beta');
    await sync();
    expect(Object.keys(mock.storage.sync.snapshot())).toContain('vm.s.meta');

    const result = await migrate('drive');
    expect(result).toEqual({ ok: true, providerId: 'drive' });
    expect((await readSettings()).providerId).toBe('drive');

    const pulled = await drives.pullLight();
    expect(pulled).not.toBeNull();
    expect([...(await repo.openEncrypted(pulled!)).keys()].sort()).toEqual(['a', 'b']);
  }, 30_000);

  it('reports where it got to, so a slow upload is not a frozen screen', async () => {
    await add('a', 'Alpha');
    const phases: string[] = [];
    await migrateProvider('drive', {
      repository: () => Promise.resolve(repo),
      provider: providers(),
      onPhase: (phase) => phases.push(phase),
    });
    expect(phases).toEqual(['authorizing', 'uploading', 'verifying', 'switching', 'cleaning', 'done']);
  }, 30_000);

  /**
   * §6.6 step 4, and the reason the two disconnects differ.
   *
   * `storage.sync` is a shared area. A copy left there is a second system of record that every other
   * device on the profile keeps pulling, and a vault two systems both claim to own is how a merge
   * loses an edit.
   */
  it('takes the vault out of chrome.storage.sync', async () => {
    await add('a', 'Alpha');
    await sync();
    expect(Object.keys(mock.storage.sync.snapshot())).toContain('vm.s.meta');

    await migrate('drive');
    expect(Object.keys(mock.storage.sync.snapshot())).not.toContain('vm.s.meta');
  }, 30_000);

  it('leaves the base describing Drive, so the next sync has nothing to say', async () => {
    await add('a', 'Alpha');
    await migrate('drive');

    const before = drive.vaultFile()?.version;
    await sync();
    expect(drive.vaultFile()?.version).toBe(before);
  }, 30_000);

  /**
   * Someone else's vault, under a different key, already sitting in the folder we are about to use.
   *
   * Built against a second browser profile because a repository refuses to create a vault on a
   * profile that already holds one — which is exactly the situation being modelled.
   */
  async function strandAForeignVault(): Promise<void> {
    const stranger = new VaultRepository();
    installChromeMock({ grantedPermissions: ['identity'] });
    await stranger.create('an entirely different master password');
    await stranger.apply([
      { kind: 'add', input: { type: 'bookmark', id: 'z', url: 'https://elsewhere.test/', title: 'Theirs' } },
    ]);
    await stranger.flush();
    const theirs = await stranger.sealSnapshot(stranger.items(), 9);
    (globalThis as { chrome?: typeof chrome }).chrome = mock.chrome;

    await drives.pushLight(theirs, null);
  }

  it('refuses, and changes nothing, when Drive already holds a different vault', async () => {
    await add('a', 'Alpha');
    await strandAForeignVault();

    const result = await migrate('drive');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('mismatch');
    expect((await readSettings()).providerId).toBe('chrome');
  }, 60_000);

  it('takes the folder over when that refusal has been answered', async () => {
    await add('a', 'Alpha');
    await strandAForeignVault();

    // The one thing that turns the refusal into an action, and it can only arrive from a person who
    // was shown it: this discards the other vault's only synced copy.
    const result = await migrate('drive', { replaceExisting: true });
    expect(result).toEqual({ ok: true, providerId: 'drive' });
    expect((await readSettings()).providerId).toBe('drive');

    // What is in Drive now is this vault, readable by this key — and the stranger's bookmark is not
    // in it. The push had to start from an empty backend for this to work at all: a compare-and-swap
    // against the stamp of a file that had just been deleted would have failed its own precondition.
    const pulled = await drives.pullLight();
    expect([...(await repo.openEncrypted(pulled!)).keys()]).toEqual(['a']);
  }, 60_000);

  it('changes nothing when the copy does not read back as what was sent', async () => {
    await add('a', 'Alpha');
    const result = await migrateProvider('drive', {
      repository: () => Promise.resolve(repo),
      provider: (id) =>
        id === 'drive'
          ? ({
              id: 'drive' as const,
              capabilities: drives.capabilities,
              init: () => Promise.resolve(),
              peek: () => drives.peek(),
              // A backend that took the bytes and gives back something else. Nobody would notice
              // until the other device stopped seeing changes, which is why this step exists.
              pullLight: () => Promise.resolve(null),
              pushLight: (vault, expect_) => drives.pushLight(vault, expect_),
              getThumb: () => Promise.resolve(null),
              putThumb: () => Promise.resolve(),
              deleteThumb: () => Promise.resolve(),
              usage: () => drives.usage(),
              disconnect: () => Promise.resolve(),
            } satisfies SyncProvider)
          : new ChromeSyncProvider(),
    });
    expect(result).toEqual({ ok: false, providerId: 'chrome', reason: 'verify' });
    expect((await readSettings()).providerId).toBe('chrome');
  }, 30_000);

  it('refuses when the vault is locked', async () => {
    const result = await migrateProvider('drive', { repository: () => Promise.resolve(null) });
    expect(result).toEqual({ ok: false, providerId: 'chrome', reason: 'locked' });
  });
});

describe('drive → chrome', () => {
  it('brings every item back, and leaves the Drive file alone', async () => {
    await add('a', 'Alpha');
    await add('b', 'Beta');
    await migrate('drive');

    const result = await migrate('chrome');
    expect(result.ok).toBe(true);
    expect((await readSettings()).providerId).toBe('chrome');
    expect(Object.keys(mock.storage.sync.snapshot())).toContain('vm.s.meta');
    // §6.6 step 4: the user's own file, untouched, unless they ask for it to go.
    expect(drive.byName(VAULT_FILE_NAME)).toBeDefined();
  }, 30_000);

  it('round-trips: chrome → drive → chrome preserves every item', async () => {
    await add('a', 'Alpha');
    await add('b', 'Beta');
    await add('c', 'Gamma');
    const before = titles();

    await migrate('drive');
    await sync();
    await migrate('chrome');
    await sync();

    // Read it back through a *different* repository, so this proves what reached storage rather
    // than what is still in memory.
    const reopened = new VaultRepository();
    await reopened.unlock(PASSWORD);
    expect(Object.fromEntries(reopened.getAll().map((item) => [item.id, item.title]))).toEqual(before);
  }, 60_000);

  /**
   * The refusal that matters.
   *
   * A vault that grew on Drive may simply not fit in 100 KB, and the only useful answer is a number.
   * Migrating the part of it that fits is not a thing anyone wants.
   */
  it('refuses when the vault no longer fits, and says how much would', async () => {
    const note = 'x'.repeat(4_000);
    for (let index = 0; index < 60; index++) {
      await add(`big-${String(index)}`, `Bookmark ${String(index)}`, note);
    }
    await writeSettings({ ...DEFAULT_SETTINGS, providerId: 'drive' });

    const result = await migrate('chrome');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('too-large');
    expect(result.items).toBe(60);
    expect(result.fits).toBeGreaterThan(0);
    expect(result.fits).toBeLessThan(60);
    // Nothing flipped: the vault is still on Drive, where it fits.
    expect((await readSettings()).providerId).toBe('drive');
  }, 60_000);
});
