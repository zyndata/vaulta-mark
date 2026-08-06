/**
 * Two devices, one sync backend (ARCHITECTURE §6).
 *
 * Two `VaultRepository` instances, each with its own `storage.local` and `storage.session`, sharing
 * one remote — which is exactly the shape of a Chrome profile signed in on a laptop and a desktop.
 * Everything below runs through the real engine, the real provider and the real merge: the only
 * thing faked is the browser, and — on the Drive tier — `fetch`.
 *
 * **This is a suite, not a test file.** It is parameterised by a {@link Backend} and run twice, once
 * per provider (`test/integration/two-device-*.test.ts`). That is the payoff the `SyncProvider`
 * interface was built for: if the abstraction holds, the same forty assertions pass over
 * `chrome.storage.sync` and over a Drive file without one of them knowing which it is on.
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
import { configureSync, forgetConflicts, listConflicts, resetSync, syncNow } from '../../src/sync/engine.js';
import type { SyncProvider } from '../../src/sync/provider.js';
import { ROOT_ID, type VaultHeader } from '../../src/vault/types.js';
import {
  createChromeMock,
  uninstallChromeMock,
  type ChromeMock,
  type Clock,
} from '../mocks/chrome.js';
import { seededRandom } from './items.js';

const PASSWORD = 'a reasonably long master password';

/**
 * One backend, as the suite needs to see it.
 *
 * Three of the five members exist because two of the scenarios are genuinely about the transport
 * rather than about the merge: "nothing was written" has to look at the remote, and "a torn push"
 * has to *produce* one, and the two backends tear in completely different ways — `storage.sync` can
 * be left holding parts under a stale header, while a Drive file is replaced in one request and can
 * only be torn by something outside our code truncating it.
 */
export interface Backend {
  readonly name: string;
  /**
   * Called before every case: throw away the remote and start again.
   *
   * The clock is the one every device shares. A backend that keeps state charged against time —
   * `storage.sync` simulates Chrome's write-rate ceilings — has to be on it, or the fuzz's own
   * fast-forward leaves the remote thinking a hundred writes arrived in the same second.
   */
  reset(clock: Clock): void;
  /** Called for each device, so a backend that lives in `chrome.storage` can share an area. */
  attach(mock: ChromeMock): void;
  provider(): SyncProvider;
  /** Something that changes when, and only when, the remote is written. */
  remoteFingerprint(): string;
  /** Leave the remote in the state a push interrupted half way would leave it in. */
  tear(push: () => Promise<void>): Promise<void>;
}

/** The clock every device and every backend shares. Advanced by the fuzz, never by the wall. */
let clock: Clock;
let backend: Backend;
let template: VaultHeader;
let dek: Bytes;

export interface Device {
  readonly name: string;
  readonly mock: ChromeMock;
  readonly repo: VaultRepository;
}

function useDevice(device: Device): void {
  (globalThis as { chrome?: typeof chrome }).chrome = device.mock.chrome;
}

async function makeDevice(name: string): Promise<Device> {
  const mock = createChromeMock({ clock, grantedPermissions: ['identity'] });
  backend.attach(mock);

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
  const provider = backend.provider();
  configureSync({
    repository: () => Promise.resolve(device.repo),
    provider: () => provider,
    now: () => clock.now(),
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

let alice: Device;
let bob: Device;

/**
 * The whole suite, run against one backend.
 *
 * Called from a `.test.ts` per provider rather than looping here, so a failure names the transport
 * in its file path and so the two can be given different timeouts.
 */
export function describeTwoDeviceSync(chosen: Backend): void {
  beforeAll(async () => {
    // One PBKDF2 derivation for the whole file: 600,000 iterations is half a second, and every
    // device in here is the *same vault* on another machine, which `unlockWithDek` models exactly.
    backend = chosen;
    const origin = createChromeMock();
    clock = origin.clock;
    (globalThis as { chrome?: typeof chrome }).chrome = origin.chrome;
    const repo = new VaultRepository();
    await repo.create(PASSWORD);
    await repo.flush();
    template = repo.header();
    dek = repo.exportDek();
  }, 30_000);

  afterAll(() => {
    resetSync();
    uninstallChromeMock();
  });

  beforeEach(async () => {
    resetSync();
    backend.reset(clock);
    alice = await makeDevice('alice');
    bob = await makeDevice('bob');
  });

  scenarios();
}

/* ---------------------------------------------------------------- the scripted runs */

function scenarios(): void {
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

  it('recovers from a remote left half-written by an interrupted push', async () => {
    await add(alice, 'a', 'Alpha');
    await settle([alice, bob]);

    await add(alice, 'b', 'Beta');
    // The remote is left holding a header that promises bucket contents which are not there. A
    // device pulling now must *notice* — that is what the tags are for — rather than merge a
    // half-vault and push the result back as the truth.
    await backend.tear(() => sync(alice));

    await sync(bob);
    await settle([alice, bob]);

    expect(liveIds(alice)).toEqual(['a', 'b']);
    expect(liveIds(bob)).toEqual(['a', 'b']);
    expect(fingerprint(alice)).toEqual(fingerprint(bob));
  }, 60_000);

  it('does nothing, and writes nothing, when neither side has moved', async () => {
    await add(alice, 'a', 'Alpha');
    await settle([alice, bob]);

    const before = backend.remoteFingerprint();
    await sync(alice);
    await sync(bob);
    expect(backend.remoteFingerprint()).toBe(before);
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
      clock.advance(60_000);
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
}
