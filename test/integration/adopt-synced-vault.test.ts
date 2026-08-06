/**
 * A second computer joining a vault that is already in sync.
 *
 * Phase 7 made two devices that *both already hold the vault* converge. This is the step before
 * that one, and the step a real second profile actually hits first: a fresh install, an empty
 * `storage.local`, and a vault sitting in `chrome.storage.sync` that Chrome replicated there.
 *
 * Everything needed to open it is in the header the first device pushed — the KDF salt and the
 * wrapped data key — so the master password is the whole of the setup. Nothing is exported, copied
 * or scanned.
 *
 * The shape of the harness is the same as `two-device-sync.test.ts`: two profiles, each with its
 * own `storage.local` and `storage.session`, sharing one sync area.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { UnsupportedSchemaError, WrongPasswordError } from '../../src/crypto/errors.js';
import { LOCAL_KEYS, readSettings, writeSettings } from '../../src/storage/local.js';
import { VaultRepository } from '../../src/storage/repo.js';
import { ChromeSyncProvider } from '../../src/sync/chrome-provider.js';
import { configureSync, resetSync, syncNow } from '../../src/sync/engine.js';
import { WriteBudget, type BudgetStore } from '../../src/sync/rate.js';
import { VaultStateError } from '../../src/vault/errors.js';
import { stampSettings } from '../../src/vault/settings-sync.js';
import { DEFAULT_SETTINGS, type VaultSettings } from '../../src/vault/types.js';
import { createChromeMock, uninstallChromeMock, type ChromeMock } from '../mocks/chrome.js';

const PASSWORD = 'a reasonably long master password';
const OTHER_PASSWORD = 'a completely different master password';

let cloud: ChromeMock;

const roomyBudget: BudgetStore = { read: () => Promise.resolve([]), write: () => Promise.resolve() };

function providerFor(): ChromeSyncProvider {
  return new ChromeSyncProvider({
    budget: new WriteBudget({ store: roomyBudget, perMinute: 1e9, perHour: 1e9 }),
    now: () => cloud.clock.now(),
  });
}

/** A profile: its own local and session storage, the shared sync area, and its own module state. */
function profile(): ChromeMock {
  const mock = createChromeMock({ clock: cloud.clock });
  (mock.chrome.storage as { sync: unknown }).sync = cloud.chrome.storage.sync;
  return mock;
}

function use(mock: ChromeMock): void {
  (globalThis as { chrome?: typeof chrome }).chrome = mock.chrome;
}

/** `session.ts` reads the ambient `chrome`, so it is imported fresh per profile. */
async function sessionFor(mock: ChromeMock): Promise<typeof import('../../src/background/session.js')> {
  use(mock);
  return await import('../../src/background/session.js');
}

function configure(repo: VaultRepository | null): void {
  const provider = providerFor();
  configureSync({
    repository: () => Promise.resolve(repo),
    provider: () => provider,
    now: () => cloud.clock.now(),
  });
}

let first: ChromeMock;
let second: ChromeMock;

beforeAll(() => {
  cloud = createChromeMock();
});

afterAll(() => {
  resetSync();
  uninstallChromeMock();
});

/**
 * A first profile with a vault and three bookmarks in it, pushed to sync.
 *
 * Rebuilt per test rather than shared, because adoption is a one-way door: once the second profile
 * has joined there is no "not joined yet" to go back to.
 */
async function seedFirstProfile(password = PASSWORD): Promise<VaultRepository> {
  first = profile();
  use(first);
  const repo = new VaultRepository();
  await repo.create(password);
  await repo.apply([
    { kind: 'add', input: { type: 'folder', id: 'f', title: 'Reading' } },
    {
      kind: 'add',
      input: { type: 'bookmark', id: 'a', url: 'https://example.com/a', title: 'Alpha', parentId: 'f' },
    },
    {
      kind: 'add',
      input: {
        type: 'bookmark',
        id: 'b',
        url: 'https://example.com/b',
        title: 'Beta',
        tags: ['later'],
        note: 'worth a second look',
      },
    },
  ]);
  await repo.flush();

  configure(repo);
  await syncNow();
  return repo;
}

/**
 * Change a preference on the first profile, the way `session.updateSettings` does.
 *
 * The local file *and* the synced record: the first is what this device reads, the second is what
 * travels. Written here rather than driven through the worker because this suite has no worker.
 */
async function preferOnFirst(patch: Partial<VaultSettings>, repo: VaultRepository): Promise<void> {
  use(first);
  const previous = await readSettings();
  const next = { ...previous, ...patch };
  await writeSettings(next);
  await repo.setSyncedSettings(
    stampSettings(repo.syncedSettings(), previous, next, cloud.clock.now()),
  );
  await repo.flush();
  configure(repo);
  await syncNow();
}

beforeEach(() => {
  resetSync();
  cloud = createChromeMock({ clock: cloud.clock });
});

/* ------------------------------------------------------------------ the flow */

describe('a second profile with a synced vault waiting', () => {
  it('is offered the password rather than the create form', async () => {
    await seedFirstProfile();

    second = profile();
    const session = await sessionFor(second);
    configure(null);

    const state = await session.state();
    expect(state.exists).toBe(false);
    expect(state.adoptable).toBe(true);
  }, 60_000);

  it('offers the create form when the sync area is genuinely empty', async () => {
    second = profile();
    const session = await sessionFor(second);
    configure(null);

    const state = await session.state();
    expect(state.exists).toBe(false);
    expect(state.adoptable).toBe(false);
  }, 30_000);

  it('joins the vault with the master password, and gets every bookmark', async () => {
    await seedFirstProfile();

    second = profile();
    const session = await sessionFor(second);
    const joined = new VaultRepository();
    configure(joined);

    await session.unlock(PASSWORD);

    const repo = await session.currentRepository();
    expect(repo).not.toBeNull();
    const titles = repo!.getAll().map((item) => item.title).sort();
    expect(titles).toEqual(['Alpha', 'Beta', 'Reading']);

    // Structure, tags and notes survive — this is a whole vault, not a list of links.
    const beta = repo!.getItem('b');
    expect(beta?.type === 'bookmark' && beta.tags).toEqual(['later']);
    expect(beta?.type === 'bookmark' && beta.note).toBe('worth a second look');
    expect(repo!.getItem('a')?.parentId).toBe('f');
  }, 60_000);

  it('takes a device identity of its own rather than the one it joined', async () => {
    const origin = await seedFirstProfile();
    const originDevice = origin.header().deviceId;

    second = profile();
    const session = await sessionFor(second);
    await session.unlock(PASSWORD);
    const repo = await session.currentRepository();

    // `deviceId` labels the sides of a conflict. Two devices claiming to be the same one would
    // mislabel every disagreement they ever had.
    expect(repo!.header().deviceId).not.toBe(originDevice);
  }, 60_000);

  it('writes nothing at all when the password is wrong', async () => {
    await seedFirstProfile();

    second = profile();
    const session = await sessionFor(second);
    configure(null);

    await expect(session.unlock(OTHER_PASSWORD)).rejects.toBeInstanceOf(WrongPasswordError);

    // Not a half-adopted vault, not a header without buckets — as empty as before the attempt.
    expect(Object.keys(second.storage.local.snapshot())).toEqual([]);
    expect(Object.keys(second.storage.session.snapshot())).toEqual([]);
    expect((await session.state()).exists).toBe(false);
  }, 60_000);

  it('says there is nothing to unlock when there is neither a local nor a synced vault', async () => {
    second = profile();
    const session = await sessionFor(second);
    configure(null);
    await expect(session.unlock(PASSWORD)).rejects.toBeInstanceOf(VaultStateError);
  }, 30_000);

  it('records the merge base, so joining does not push the vault straight back', async () => {
    await seedFirstProfile();

    second = profile();
    const session = await sessionFor(second);
    await session.unlock(PASSWORD);
    const repo = await session.currentRepository();
    configure(repo);

    expect(Object.keys(second.storage.local.snapshot())).toContain(LOCAL_KEYS.base);

    // The first sync after joining has nothing to do: same items, same revision, same remote.
    const before = JSON.stringify(cloud.storage.sync.snapshot());
    const status = await syncNow();
    expect(status.error).toBeNull();
    expect(JSON.stringify(cloud.storage.sync.snapshot())).toBe(before);
  }, 60_000);

  it('syncs both ways from then on, like any other pair of devices', async () => {
    const origin = await seedFirstProfile();

    second = profile();
    const session = await sessionFor(second);
    await session.unlock(PASSWORD);
    const joined = (await session.currentRepository())!;

    // The joined profile adds something and pushes it.
    use(second);
    await joined.apply([
      { kind: 'add', input: { type: 'bookmark', id: 'c', url: 'https://example.com/c', title: 'Gamma' } },
    ]);
    await joined.flush();
    configure(joined);
    await syncNow();

    // The original picks it up.
    use(first);
    configure(origin);
    await syncNow();
    expect(origin.getAll().map((item) => item.id).sort()).toEqual(['a', 'b', 'c', 'f']);
  }, 60_000);
});

/* ------------------------------------------------------------------ guards */

describe('adopting is refused when it would be wrong', () => {
  it('will not adopt onto a profile that already holds a vault', async () => {
    await seedFirstProfile();
    const pulled = await providerFor().pullLight();

    second = profile();
    use(second);
    const repo = new VaultRepository();
    await repo.create(OTHER_PASSWORD);
    await repo.flush();

    // Adoption is for an empty profile. Overwriting a vault that is already here is what
    // `destroy()` is for, and it is not something a password prompt should do by accident.
    await expect(repo.adopt(pulled!, PASSWORD)).rejects.toBeInstanceOf(VaultStateError);
  }, 60_000);

  it('will not adopt a vault written by a newer VaultaMark', async () => {
    await seedFirstProfile();
    const pulled = await providerFor().pullLight();

    second = profile();
    use(second);
    const repo = new VaultRepository();
    const fromTheFuture = {
      ...pulled!,
      header: { ...pulled!.header, schemaVersion: pulled!.header.schemaVersion + 1 },
    };
    // Told to update rather than told the password is wrong — and, crucially, before any key is
    // derived, so the message is not a guess.
    await expect(repo.adopt(fromTheFuture, PASSWORD)).rejects.toBeInstanceOf(UnsupportedSchemaError);
    expect(Object.keys(second.storage.local.snapshot())).toEqual([]);
  }, 60_000);
});

/* ------------------------------------------------------------------ the collision */

describe('a second vault created beside a synced one', () => {
  it('reports a mismatch instead of retrying forever, and damages neither side', async () => {
    const origin = await seedFirstProfile();
    const originalRemote = JSON.stringify(cloud.storage.sync.snapshot());

    // The escape hatch: someone declines to join and creates their own vault instead.
    second = profile();
    use(second);
    const separate = new VaultRepository();
    await separate.create(OTHER_PASSWORD);
    await separate.apply([
      { kind: 'add', input: { type: 'bookmark', id: 'z', url: 'https://example.com/z', title: 'Zeta' } },
    ]);
    await separate.flush();

    configure(separate);
    const status = await syncNow();

    // Named, so the status line can say something true rather than "it will be retried".
    expect(status.error).toBe('VAULT_MISMATCH');
    // And nothing was pushed: the first profile's synced copy is exactly as it was.
    expect(JSON.stringify(cloud.storage.sync.snapshot())).toBe(originalRemote);

    use(first);
    configure(origin);
    await syncNow();
    expect(origin.getAll().map((item) => item.id).sort()).toEqual(['a', 'b', 'f']);
  }, 60_000);
});

/* ------------------------------------------------------------------ settings (Phase 10) */

describe('the preferences that come with the vault', () => {
  it('arrives with the first profile’s settings, and keeps its own screen and its own backend', async () => {
    const repo = await seedFirstProfile();
    await preferOnFirst({ theme: 'dark', idleTimeoutMinutes: 30, quickClose: true }, repo);

    second = profile();
    use(second);
    // This profile has already been used: someone has dragged its columns and it is on Drive.
    await writeSettings({
      ...DEFAULT_SETTINGS,
      sidebarWidth: 420,
      detailWidth: 300,
      providerId: 'drive',
    });

    const session = await sessionFor(second);
    configure(null);
    await session.unlock(PASSWORD);

    const settings = await readSettings();
    // What travelled.
    expect(settings.theme).toBe('dark');
    expect(settings.idleTimeoutMinutes).toBe(30);
    expect(settings.quickClose).toBe(true);
    // What did not, and must not: a laptop is not a desktop, and this profile's Drive connection is
    // its own — syncing it would tell a profile with no token to use Drive.
    expect(settings.sidebarWidth).toBe(420);
    expect(settings.detailWidth).toBe(300);
    expect(settings.providerId).toBe('drive');
  }, 60_000);

  it('leaves an untouched preference alone rather than imposing a default', async () => {
    const repo = await seedFirstProfile();
    await preferOnFirst({ theme: 'dark' }, repo);

    second = profile();
    use(second);
    // Nobody has ever changed `sortBy` on the first profile, so the record has nothing to say about
    // it — and this profile's own choice survives.
    await writeSettings({ ...DEFAULT_SETTINGS, sortBy: 'title' });

    const session = await sessionFor(second);
    configure(null);
    await session.unlock(PASSWORD);

    const settings = await readSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.sortBy).toBe('title');
  }, 60_000);
});
