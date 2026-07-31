/**
 * Two devices, one `chrome.storage.sync` (ARCHITECTURE §6).
 *
 * Two `VaultRepository` instances, each with its own `storage.local` and `storage.session`, sharing
 * one sync area — which is exactly the shape of a Chrome profile signed in on a laptop and a
 * desktop. Everything below runs through the real engine, the real provider and the real merge: the
 * only thing faked is the browser.
 *
 * **What "converged" means here.** Ciphertext cannot be compared: every seal draws a fresh IV, so
 * two devices holding identical bookmarks hold completely different bytes. The header's bucket tags
 * can be — they are HMACs over each bucket's canonical *plaintext*, so equal tags mean equal
 * contents, keyed so that nobody without the vault key could have computed them. Equal tag tables
 * is the assertion, and it is a stronger one than comparing item lists: it is the thing the sync
 * layer itself uses to decide whether a bucket needs writing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Bytes } from '../../src/crypto/codec.js';
import { writeHeader } from '../../src/storage/local.js';
import { VaultRepository } from '../../src/storage/repo.js';
import { ChromeSyncProvider } from '../../src/sync/chrome-provider.js';
import { configureSync, forgetConflicts, listConflicts, resetSync, syncNow } from '../../src/sync/engine.js';
import { WriteBudget, type BudgetStore } from '../../src/sync/rate.js';
import { ROOT_ID, type VaultHeader } from '../../src/vault/types.js';
import { createChromeMock, uninstallChromeMock, type ChromeMock } from '../mocks/chrome.js';
import { seededRandom } from '../helpers/items.js';

const PASSWORD = 'a reasonably long master password';

/** The shared `chrome.storage.sync`, and the clock the write-rate budget is measured against. */
let cloud: ChromeMock;
let template: VaultHeader;
let dek: Bytes;

interface Device {
  readonly name: string;
  readonly mock: ChromeMock;
  readonly repo: VaultRepository;
}

/**
 * A budget with room for a simulation.
 *
 * The governor itself is proven against Chrome's real ceilings in `test/unit/sync/rate.test.ts`;
 * here it would only mean a test that fails because it ran too many scenarios too fast.
 */
const roomyBudget: BudgetStore = { read: () => Promise.resolve([]), write: () => Promise.resolve() };

function providerFor(): ChromeSyncProvider {
  return new ChromeSyncProvider({
    budget: new WriteBudget({ store: roomyBudget, perMinute: 1e9, perHour: 1e9 }),
    now: () => cloud.clock.now(),
  });
}

function useDevice(device: Device): void {
  (globalThis as { chrome?: typeof chrome }).chrome = device.mock.chrome;
}

async function makeDevice(name: string): Promise<Device> {
  const mock = createChromeMock({ clock: cloud.clock });
  // One sync area between them: this is the whole of Chrome's built-in replication, and the reason
  // the provider needs no configuration at all.
  (mock.chrome.storage as { sync: unknown }).sync = cloud.chrome.storage.sync;

  const device: Device = { name, mock, repo: new VaultRepository() };
  useDevice(device);
  // The vault is the same vault: same salt, same wrapped DEK, same schema. Only `deviceId` differs,
  // which is the one header field that describes the install rather than the vault.
  await writeHeader({ ...template, deviceId: name });
  await device.repo.unlockWithDek(dek);
  return device;
}

async function sync(device: Device, options: { force?: boolean } = {}): Promise<void> {
  useDevice(device);
  const provider = providerFor();
  configureSync({
    repository: () => Promise.resolve(device.repo),
    provider: () => provider,
    now: () => cloud.clock.now(),
  });
  await syncNow(options);
}

/** Sync each device twice, round-robin, which is what it takes for two peers to agree (§6.3). */
async function settle(devices: readonly Device[]): Promise<void> {
  for (let round = 0; round < 2; round++) {
    for (const device of devices) await sync(device);
  }
}

/* ---------------------------------------------------------------- shorthands */

async function add(device: Device, id: string, title: string, url = `https://example.com/${id}`): Promise<void> {
  useDevice(device);
  await device.repo.apply([{ kind: 'add', input: { type: 'bookmark', id, url, title } }]);
  await device.repo.flush();
}

async function edit(
  device: Device,
  id: string,
  patch: { title?: string; note?: string; tags?: string[] },
): Promise<void> {
  useDevice(device);
  await device.repo.apply([{ kind: 'update', id, patch }]);
  await device.repo.flush();
}

async function remove(device: Device, id: string): Promise<void> {
  useDevice(device);
  await device.repo.apply([{ kind: 'delete', id }]);
  await device.repo.flush();
}

async function restore(device: Device, id: string): Promise<void> {
  useDevice(device);
  await device.repo.apply([{ kind: 'restore', id }]);
  await device.repo.flush();
}

function titles(device: Device): Record<string, string> {
  useDevice(device);
  return Object.fromEntries(device.repo.getAll().map((item) => [item.id, item.title]));
}

function liveIds(device: Device): string[] {
  useDevice(device);
  return device.repo.getAll().map((item) => item.id).sort();
}

/** The bucket tag table — the comparable, keyed fingerprint of a vault's whole contents. */
function fingerprint(device: Device): string[] {
  useDevice(device);
  return device.repo.header().buckets.map((meta) => `${String(meta.i)}:${meta.tag}`);
}

async function conflictCount(device: Device): Promise<number> {
  useDevice(device);
  return (await listConflicts(device.repo)).length;
}

/* ---------------------------------------------------------------- setup */

beforeAll(async () => {
  // One PBKDF2 derivation for the whole file: 600,000 iterations is half a second, and every device
  // in here is the *same vault* on another machine, which is exactly what `unlockWithDek` models.
  cloud = createChromeMock();
  (globalThis as { chrome?: typeof chrome }).chrome = cloud.chrome;
  const origin = new VaultRepository();
  await origin.create(PASSWORD);
  await origin.flush();
  template = origin.header();
  dek = origin.exportDek();
}, 30_000);

afterAll(() => {
  resetSync();
  uninstallChromeMock();
});

let alice: Device;
let bob: Device;

beforeEach(async () => {
  resetSync();
  cloud = createChromeMock({ clock: cloud.clock });
  alice = await makeDevice('alice');
  bob = await makeDevice('bob');
});

/* ---------------------------------------------------------------- the scripted runs */

describe('two devices, one vault', () => {
  it('carries an add from one device to the other', async () => {
    await add(alice, 'a', 'Alpha');
    await add(alice, 'b', 'Beta');
    await sync(alice);

    await sync(bob);
    expect(liveIds(bob)).toEqual(['a', 'b']);
    expect(titles(bob)['a']).toBe('Alpha');
    expect(fingerprint(bob)).toEqual(fingerprint(alice));
  }, 30_000);

  it('carries an edit back the other way', async () => {
    await add(alice, 'a', 'Alpha');
    await settle([alice, bob]);

    await edit(bob, 'a', { title: 'Edited on Bob' });
    await settle([bob, alice]);

    expect(titles(alice)['a']).toBe('Edited on Bob');
    expect(fingerprint(alice)).toEqual(fingerprint(bob));
  }, 30_000);

  it('merges disjoint edits made while both were offline', async () => {
    await add(alice, 'a', 'Alpha');
    await settle([alice, bob]);

    // Neither device syncs until both have edited: this is the case a 3-way merge exists for.
    await edit(alice, 'a', { title: 'Renamed by Alice' });
    await edit(bob, 'a', { note: 'Annotated by Bob' });

    await settle([alice, bob]);

    for (const device of [alice, bob]) {
      useDevice(device);
      const item = device.repo.getItem('a');
      expect(item?.title, device.name).toBe('Renamed by Alice');
      expect(item?.type === 'bookmark' && item.note, device.name).toBe('Annotated by Bob');
    }
    expect(await conflictCount(alice)).toBe(0);
    expect(await conflictCount(bob)).toBe(0);
    expect(fingerprint(alice)).toEqual(fingerprint(bob));
  }, 30_000);

  it('unions tags added on both sides without a prompt', async () => {
    await add(alice, 'a', 'Alpha');
    await edit(alice, 'a', { tags: ['shared'] });
    await settle([alice, bob]);

    await edit(alice, 'a', { tags: ['shared', 'alice'] });
    await edit(bob, 'a', { tags: ['shared', 'bob'] });
    await settle([alice, bob]);

    useDevice(alice);
    const item = alice.repo.getItem('a');
    expect(item?.type === 'bookmark' && [...(item.tags ?? [])].sort()).toEqual([
      'alice',
      'bob',
      'shared',
    ]);
    expect(await conflictCount(alice)).toBe(0);
  }, 30_000);

  it('propagates a delete rather than resurrecting it from the other device', async () => {
    await add(alice, 'a', 'Alpha');
    await add(alice, 'b', 'Beta');
    await settle([alice, bob]);

    await remove(bob, 'a');
    await settle([bob, alice]);

    expect(liveIds(alice)).toEqual(['b']);
    expect(fingerprint(alice)).toEqual(fingerprint(bob));
  }, 30_000);

  it('raises a conflict when both changed the same field, and loses neither version', async () => {
    await add(alice, 'a', 'Alpha');
    await settle([alice, bob]);

    await edit(alice, 'a', { title: 'Alice’s title' });
    await edit(bob, 'a', { title: 'Bob’s title' });

    await sync(alice);
    await sync(bob);

    // Bob is the device that discovered the divergence, so Bob is the one holding the record: the
    // remote still carries Alice's answer untouched, which is what §6.5 means by "nothing is pushed
    // for the conflicted item".
    expect(await conflictCount(bob)).toBe(1);
    useDevice(bob);
    const [conflict] = await listConflicts(bob.repo);
    expect(conflict?.fields).toEqual(['title']);
    expect(conflict?.mine.title).toBe('Bob’s title');
    expect(conflict?.theirs.title).toBe('Alice’s title');
    // Bob keeps working with Bob's version meanwhile.
    expect(titles(bob)['a']).toBe('Bob’s title');

    await sync(alice);
    expect(titles(alice)['a']).toBe('Alice’s title');
  }, 30_000);

  it('keeps the rest of the vault syncing while a conflict is unresolved', async () => {
    await add(alice, 'a', 'Alpha');
    await settle([alice, bob]);

    await edit(alice, 'a', { title: 'Alice’s title' });
    await edit(bob, 'a', { title: 'Bob’s title' });
    await sync(alice);
    await sync(bob);
    expect(await conflictCount(bob)).toBe(1);

    // A bookmark nobody is arguing about crosses the wire exactly as it would have anyway.
    await add(bob, 'c', 'Unrelated');
    await sync(bob);
    await sync(alice);

    expect(liveIds(alice)).toContain('c');
    // And Alice's answer to the contested one is still the one on the remote.
    expect(titles(alice)['a']).toBe('Alice’s title');
  }, 30_000);

  it('converges once the conflict is settled', async () => {
    await add(alice, 'a', 'Alpha');
    await settle([alice, bob]);

    await edit(alice, 'a', { title: 'Alice’s title' });
    await edit(bob, 'a', { title: 'Bob’s title' });
    await sync(alice);
    await sync(bob);

    // Bob keeps Bob's, which is the answer that has to travel *back* over Alice's.
    useDevice(bob);
    const pending = await listConflicts(bob.repo);
    await forgetConflicts(
      bob.repo,
      pending.map((entry) => entry.id),
    );
    await sync(bob, { force: true });
    await settle([alice, bob]);

    expect(titles(alice)['a']).toBe('Bob’s title');
    expect(titles(bob)['a']).toBe('Bob’s title');
    expect(fingerprint(alice)).toEqual(fingerprint(bob));
    expect(await conflictCount(bob)).toBe(0);
  }, 30_000);

  it('raises an edit-versus-delete rather than discarding either', async () => {
    await add(alice, 'a', 'Alpha');
    await settle([alice, bob]);

    await edit(alice, 'a', { title: 'Still wanted' });
    await remove(bob, 'a');

    await sync(alice);
    await sync(bob);

    useDevice(bob);
    const [conflict] = await listConflicts(bob.repo);
    expect(conflict?.kind).toBe('edit-delete');
    expect(conflict?.theirs.title).toBe('Still wanted');
    expect(conflict?.mine.deleted).toBe(true);
  }, 30_000);

  it('recovers from a crash between pushing the buckets and pushing the header', async () => {
    await add(alice, 'a', 'Alpha');
    await settle([alice, bob]);

    await add(alice, 'b', 'Beta');

    // Kill the push after the bucket parts have landed and before the header does — the torn state
    // §5.4.1 orders the writes to survive. The remote is left with new bytes under an old header.
    useDevice(alice);
    const area = cloud.chrome.storage.sync as unknown as {
      set: (items: Record<string, unknown>) => Promise<void>;
    };
    const original = area.set;
    area.set = async (items) => {
      if ('vm.s.meta' in items) throw new Error('the browser went away');
      await original(items);
    };
    await sync(alice);
    area.set = original;

    // A device pulling now finds a header promising bucket contents that are no longer there. It
    // must notice — that is what the tags are for — rather than merge a half-vault.
    await sync(bob);
    await settle([alice, bob]);

    expect(liveIds(alice)).toEqual(['a', 'b']);
    expect(liveIds(bob)).toEqual(['a', 'b']);
    expect(fingerprint(alice)).toEqual(fingerprint(bob));
  }, 60_000);

  it('does nothing, and writes nothing, when neither side has moved', async () => {
    await add(alice, 'a', 'Alpha');
    await settle([alice, bob]);

    const before = JSON.stringify(cloud.storage.sync.snapshot());
    await sync(alice);
    await sync(bob);
    expect(JSON.stringify(cloud.storage.sync.snapshot())).toBe(before);
  }, 30_000);
});

/* ---------------------------------------------------------------- the fuzz */

describe('randomized interleavings', () => {
  it('converges and loses nothing over 200 scripted interleavings', async () => {
    const random = seededRandom(7_310_726);
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    let counter = 0;

    for (let iteration = 0; iteration < 200; iteration++) {
      const device = random() < 0.5 ? alice : bob;
      useDevice(device);
      const id = ids[Math.floor(random() * ids.length)]!;
      const present = device.repo.getItem(id);
      const roll = random();

      if (present === undefined) {
        if (roll < 0.7) await add(device, id, `Title ${String(counter++)}`);
      } else if (present.deleted === true) {
        // A tombstone is still an item, so this is the "undo a delete" path rather than a
        // second add — which is exactly the distinction that keeps a delete-then-undo from
        // arriving on the other device as a duplicate bookmark.
        if (roll < 0.4) await restore(device, id);
      } else if (roll < 0.2) {
        await remove(device, id);
      } else if (roll < 0.6) {
        await edit(device, id, { title: `Title ${String(counter++)}` });
      } else if (roll < 0.8) {
        await edit(device, id, { note: `Note ${String(counter++)}` });
      } else {
        await edit(device, id, { tags: [`tag${String(Math.floor(random() * 4))}`] });
      }

      // Sync sometimes, so the two drift apart for stretches rather than staying in lockstep.
      if (random() < 0.6) await sync(device);
      // Simulated time, so the mock's own write-rate ceilings are not what this test measures.
      cloud.clock.advance(60_000);
    }

    /*
     * Wind down the way a person would: sync, settle whatever is disputed, sync again.
     *
     * It is a *loop* rather than a single pass, and that is worth saying out loud because it looks
     * like a workaround and is not. "Keep mine" on one device pushes a version the other device has
     * also edited, which is a new disagreement — a real one, about a bookmark that genuinely says
     * two different things — and it is raised rather than silently overwritten. Each round strictly
     * reduces the disagreement, so this terminates; the assertion is that it terminates *quickly*.
     */
    let rounds = 0;
    for (; rounds < 6; rounds++) {
      await settle([alice, bob]);
      if ((await conflictCount(alice)) + (await conflictCount(bob)) === 0) break;
      for (const device of [alice, bob]) {
        useDevice(device);
        const pending = await listConflicts(device.repo);
        if (pending.length === 0) continue;
        await forgetConflicts(
          device.repo,
          pending.map((entry) => entry.id),
        );
        await sync(device, { force: true });
      }
    }
    expect(rounds).toBeLessThan(6);
    await settle([alice, bob]);

    expect(liveIds(alice).length).toBeGreaterThan(0);
    expect(liveIds(bob)).toEqual(liveIds(alice));
    expect(fingerprint(bob)).toEqual(fingerprint(alice));
    expect(await conflictCount(alice)).toBe(0);
    expect(await conflictCount(bob)).toBe(0);

    // And the tree is a tree on both of them: nothing ended up under a folder that is not there.
    for (const device of [alice, bob]) {
      useDevice(device);
      for (const item of device.repo.getAll()) {
        expect(item.parentId, `${device.name} ${item.id}`).toBe(ROOT_ID);
      }
    }
  }, 300_000);
});
