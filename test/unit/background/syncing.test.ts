/**
 * The sync surface the UI talks to, driven over the real message router.
 *
 * The interesting half of this file is conflict resolution. A conflict is settled by making a
 * *normal local edit* — the same mutations the manager would produce if a person had typed the
 * answer — so the assertions are about the vault afterwards rather than about the record: what
 * "keep theirs" leaves behind is an item that looks exactly like theirs, and what "keep both"
 * leaves behind is two items.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Conflict } from '../../../src/sync/merge.js';
import type { VaultItem } from '../../../src/vault/types.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

const PASSWORD = 'a reasonably long master password';

let mock: ChromeMock;

async function startWorker(): Promise<void> {
  mock.terminateWorker();
  vi.resetModules();
  await import('../../../src/background/index.js');
}

async function send(message: unknown): Promise<Record<string, unknown>> {
  return (await mock.sendMessage(message)) as Record<string, unknown>;
}

/** The unlocked repository this worker is using, for seeding state the wire cannot express. */
async function repository(): Promise<
  NonNullable<Awaited<ReturnType<typeof import('../../../src/background/session.js').currentRepository>>>
> {
  const session = await import('../../../src/background/session.js');
  const repo = await session.currentRepository();
  if (repo === null) throw new Error('the vault is locked');
  return repo;
}

/**
 * Plant a conflict record, as a merge against a divergent remote would have left one.
 *
 * Reaching for `sync/base.ts` rather than staging a second device: what is under test here is what
 * *resolution* does, and the merge that produces a conflict has its own suite.
 */
async function plantConflict(id: string, theirs: Partial<VaultItem> & { title: string }): Promise<void> {
  const repo = await repository();
  const mine = repo.getItem(id);
  if (mine === undefined) throw new Error(`no item ${id}`);
  const base = await import('../../../src/sync/base.js');

  const conflict: Conflict = {
    id,
    kind: theirs.deleted === true ? 'edit-delete' : 'field',
    fields: theirs.deleted === true ? [] : ['title'],
    mine,
    theirs: { ...mine, ...theirs } as VaultItem,
    base: mine,
    detectedAt: Date.now(),
    remoteDevice: 'the-other-device',
  };
  await base.saveConflicts(repo.cipher(), [conflict]);
}

async function addBookmark(url: string, title: string): Promise<string> {
  const response = await send({ type: 'ADD_URL', url, title });
  return (response['item'] as { id: string }).id;
}

async function itemsOf(): Promise<VaultItem[]> {
  return [...(await repository()).getAll()];
}

beforeAll(() => {
  // PBKDF2 at 600,000 iterations is half a second; each test creates its own vault, so the file
  // stays honest about a cold start at the cost of a few seconds.
  vi.setConfig({ testTimeout: 30_000 });
});

beforeEach(async () => {
  mock = installChromeMock();
  await startWorker();
  await send({ type: 'CREATE_VAULT', password: PASSWORD });
});

afterEach(async () => {
  const { resetSync } = await import('../../../src/sync/engine.js');
  resetSync();
  mock.terminateWorker();
  uninstallChromeMock();
});

/* ------------------------------------------------------------------ status */

describe('sync status', () => {
  it('answers with a provider, a quota and no conflicts on a fresh vault', async () => {
    const status = await send({ type: 'GET_SYNC_STATUS' });
    expect(status['type']).toBe('SYNC_STATUS');
    expect(status['providerId']).toBe('chrome');
    expect(status['conflicts']).toBe(0);
    expect(status['quotaBytes']).toBe(102_400);
    expect(status['lastSyncedAt']).toBeNull();
  });

  it('answers while the vault is locked, without a key and without failing', async () => {
    await send({ type: 'LOCK' });
    const status = await send({ type: 'GET_SYNC_STATUS' });
    expect(status['phase']).toBe('locked');
    expect(status['conflicts']).toBe(0);
  });

  it('pushes on demand and records when it last succeeded', async () => {
    await addBookmark('https://example.com/one', 'One');
    const status = await send({ type: 'SYNC_NOW' });

    expect(status['error']).toBeNull();
    expect(status['lastSyncedAt']).toEqual(expect.any(Number));
    expect(Object.keys(mock.storage.sync.snapshot())).toContain('vm.s.meta');
  });

  it('puts no readable vault content into storage.sync (INV-6)', async () => {
    await addBookmark('https://very-private.example/path', 'Secret bookmark title');
    await send({ type: 'SYNC_NOW' });

    const synced = JSON.stringify(mock.storage.sync.snapshot());
    expect(synced).not.toContain('Secret bookmark title');
    expect(synced).not.toContain('very-private.example');
  });
});

/* ------------------------------------------------------------------ conflicts */

describe('listing conflicts', () => {
  it('is empty when nothing is disputed', async () => {
    expect(await send({ type: 'LIST_CONFLICTS' })).toEqual({ type: 'CONFLICTS', conflicts: [] });
  });

  it('sends both versions, the fields that disagree, and whether both can be kept', async () => {
    const id = await addBookmark('https://example.com/one', 'Mine');
    await plantConflict(id, { title: 'Theirs' });

    const response = await send({ type: 'LIST_CONFLICTS' });
    const [conflict] = response['conflicts'] as Record<string, unknown>[];
    expect(conflict?.['id']).toBe(id);
    expect(conflict?.['fields']).toEqual(['title']);
    expect((conflict?.['mine'] as { title: string }).title).toBe('Mine');
    expect((conflict?.['theirs'] as { title: string }).title).toBe('Theirs');
    expect(conflict?.['canKeepBoth']).toBe(true);
  });

  it('does not offer "keep both" when one side is a deletion', async () => {
    const id = await addBookmark('https://example.com/one', 'Mine');
    await plantConflict(id, { title: 'Mine', deleted: true, deletedAt: Date.now() });

    const response = await send({ type: 'LIST_CONFLICTS' });
    const [conflict] = response['conflicts'] as Record<string, unknown>[];
    expect(conflict?.['canKeepBoth']).toBe(false);
    expect((conflict?.['theirs'] as { deleted: boolean }).deleted).toBe(true);
  });

  it('reports the conflict count in the status, so the banner needs no second request', async () => {
    const id = await addBookmark('https://example.com/one', 'Mine');
    await plantConflict(id, { title: 'Theirs' });
    const status = await send({ type: 'GET_SYNC_STATUS' });
    expect(status['conflicts']).toBe(1);
    expect(status['phase']).toBe('conflict');
  });
});

describe('resolving a conflict', () => {
  it('keeps this device’s version, and changes nothing about the item', async () => {
    const id = await addBookmark('https://example.com/one', 'Mine');
    await plantConflict(id, { title: 'Theirs' });

    expect(await send({ type: 'RESOLVE_CONFLICTS', ids: [id], resolution: 'mine' })).toEqual({
      type: 'COUNT',
      count: 1,
    });
    expect((await itemsOf()).map((item) => item.title)).toEqual(['Mine']);
    expect(await send({ type: 'LIST_CONFLICTS' })).toEqual({ type: 'CONFLICTS', conflicts: [] });
  });

  it('adopts the other version in full', async () => {
    const id = await addBookmark('https://example.com/one', 'Mine');
    await plantConflict(id, {
      title: 'Theirs',
      url: 'https://example.com/theirs',
      note: 'their note',
      tags: ['theirs'],
    });

    await send({ type: 'RESOLVE_CONFLICTS', ids: [id], resolution: 'theirs' });

    const [item] = await itemsOf();
    expect(item?.title).toBe('Theirs');
    expect(item?.type === 'bookmark' && item.url).toBe('https://example.com/theirs');
    expect(item?.type === 'bookmark' && item.note).toBe('their note');
    expect(item?.type === 'bookmark' && item.tags).toEqual(['theirs']);
  });

  it('applies their deletion when theirs is a tombstone', async () => {
    const id = await addBookmark('https://example.com/one', 'Mine');
    await plantConflict(id, { title: 'Mine', deleted: true, deletedAt: Date.now() });

    await send({ type: 'RESOLVE_CONFLICTS', ids: [id], resolution: 'theirs' });
    expect(await itemsOf()).toEqual([]);
  });

  it('keeps both, as two items, and discards nothing', async () => {
    const id = await addBookmark('https://example.com/one', 'Mine');
    await plantConflict(id, { title: 'Theirs' });

    await send({ type: 'RESOLVE_CONFLICTS', ids: [id], resolution: 'both' });

    const titles = (await itemsOf()).map((item) => item.title).sort();
    expect(titles).toHaveLength(2);
    expect(titles).toContain('Mine');
    // `chrome.i18n.getMessage` in the mock answers with the key, which is what makes the suffix
    // visible here at all — and asserting on the key rather than on English is the point.
    expect(titles.find((title) => title !== 'Mine')).toBe('Theirs conflictCopySuffix');
  });

  it('settles a whole batch in one request', async () => {
    const first = await addBookmark('https://example.com/one', 'One');
    const second = await addBookmark('https://example.com/two', 'Two');
    const repo = await repository();
    const base = await import('../../../src/sync/base.js');
    await base.saveConflicts(
      repo.cipher(),
      [first, second].map((id) => ({
        id,
        kind: 'field' as const,
        fields: ['title'],
        mine: repo.getItem(id)!,
        theirs: { ...repo.getItem(id)!, title: 'Theirs' },
        base: repo.getItem(id)!,
        detectedAt: Date.now(),
      })),
    );

    expect(
      await send({ type: 'RESOLVE_CONFLICTS', ids: [first, second], resolution: 'theirs' }),
    ).toEqual({ type: 'COUNT', count: 2 });
    expect((await itemsOf()).map((item) => item.title)).toEqual(['Theirs', 'Theirs']);
  });

  it('refuses an id that is not in conflict rather than reporting success', async () => {
    const response = await send({
      type: 'RESOLVE_CONFLICTS',
      ids: ['not-a-conflict'],
      resolution: 'mine',
    });
    expect(response).toEqual({ type: 'ERROR', code: 'ITEM_NOT_FOUND' });
  });

  it('rejects a resolution that is not one of the three', async () => {
    expect(
      await mock.sendMessage({ type: 'RESOLVE_CONFLICTS', ids: ['a'], resolution: 'whatever' }),
    ).toBeUndefined();
    expect(await mock.sendMessage({ type: 'RESOLVE_CONFLICTS', ids: [], resolution: 'mine' })).toBeUndefined();
  });

  it('needs an unlocked vault', async () => {
    await send({ type: 'LOCK' });
    expect(await send({ type: 'LIST_CONFLICTS' })).toEqual({
      type: 'ERROR',
      code: 'VAULT_LOCKED',
    });
  });
});
