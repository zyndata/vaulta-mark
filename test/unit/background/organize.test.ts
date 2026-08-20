/**
 * The manager's vault operations (PLAN §9 Phase 6), driven the way the manager drives them:
 * everything over `chrome.runtime.sendMessage`, through the real router.
 *
 * The theme running through this file is **atomicity**. Every bulk operation is one `repo.apply()`
 * call, and `apply` only commits if the whole batch validated — so the assertion that matters for
 * each of them is not "it moved forty bookmarks" but "when one of the forty was impossible, none of
 * them moved". A half-applied batch leaves an inconsistent tree behind a perfectly valid GCM tag,
 * which nothing downstream detects.
 *
 * PBKDF2 at 600,000 iterations is half a second, so the vault is created once in `beforeAll` and
 * both storage areas are restored per test. Restoring `storage.session` as well as `storage.local`
 * is what keeps the vault *unlocked* without a second derivation — the worker rehydrates from the
 * DEK exactly as it does after MV3 kills it (D14).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseResponse } from '../../../src/shared/messages.js';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
  type StorageSnapshot,
} from '../../mocks/chrome.js';

const PASSWORD = 'a reasonably long master password';

let mock: ChromeMock;
let seededLocal: StorageSnapshot;
let seededSession: StorageSnapshot;

async function startWorker(): Promise<void> {
  mock.terminateWorker();
  vi.resetModules();
  await import('../../../src/background/index.js');
}

/**
 * Send a request through the real router, and check the answer would survive the wire.
 *
 * `parseResponse` is the second half of the transport and it guards a **hand-maintained set** of
 * response type names (`RESPONSE_TYPES`). A worker that answers correctly with a type missing from
 * that set is turned into `ERROR/UNKNOWN` in every UI, and nothing in this file would notice —
 * these tests read the worker's answer directly, which is how Phase 16 shipped a new response type
 * with green unit tests and a screen that said "Something went wrong."
 */
async function send(message: unknown): Promise<Record<string, unknown>> {
  const raw = await mock.sendMessage(message);
  expect(parseResponse(raw), `unparseable answer to ${JSON.stringify(message)}`).not.toBeNull();
  return raw as Record<string, unknown>;
}

/**
 * Assert that the wire refused a request outright.
 *
 * A message `parseRequest` does not recognise gets **no answer at all** — the router returns
 * `false` and leaves the channel to whoever else might be listening, because another extension's
 * message is not ours to reply to. `send()` in `shared/messages.ts` is what turns that silence into
 * `ERROR/UNKNOWN` for the UI; at this level it is `undefined`, and the thing worth asserting
 * alongside it is that nothing happened.
 */
async function expectRejected(message: unknown): Promise<void> {
  expect(await mock.sendMessage(message), JSON.stringify(message)).toBeUndefined();
}

/* ---------------------------------------------------------------- shorthands */

interface Row {
  id: string;
  type: 'bookmark' | 'folder';
  parentId: string;
  title: string;
  url?: string;
  tags: string[];
  hasNote: boolean;
  descendants?: number;
}

async function addBookmark(url: string, title: string): Promise<string> {
  const response = await send({ type: 'ADD_URL', url, title });
  return (response['item'] as { id: string }).id;
}

async function addFolder(title: string, parentId?: string): Promise<string> {
  const response = await send({
    type: 'CREATE_FOLDER',
    title,
    ...(parentId === undefined ? {} : { parentId }),
  });
  expect(response['type'], JSON.stringify(response)).toBe('CREATED');
  return response['id'] as string;
}

async function view(options: Record<string, unknown> = {}): Promise<Row[]> {
  const response = await send({ type: 'LIST_VIEW', ...options });
  expect(response['type'], JSON.stringify(response)).toBe('VIEW');
  return response['items'] as Row[];
}

async function titles(options: Record<string, unknown> = {}): Promise<string[]> {
  return (await view(options)).map((row) => row.title);
}

async function detail(id: string): Promise<Record<string, unknown> | null> {
  const response = await send({ type: 'GET_ITEM', id });
  return response['item'] as Record<string, unknown> | null;
}

async function tree(): Promise<Record<string, unknown>> {
  return await send({ type: 'GET_TREE' });
}

interface DupeGroup {
  key: string;
  items: { id: string; title: string; url?: string; path: { title: string }[]; hasNote: boolean }[];
}

async function duplicates(): Promise<DupeGroup[]> {
  const response = await send({ type: 'LIST_DUPLICATES' });
  expect(response['type'], JSON.stringify(response)).toBe('DUPLICATES');
  return response['groups'] as DupeGroup[];
}

/**
 * The copies in a group, by id, **sorted** — and the sort is the point.
 *
 * Everything this file adds is stamped by the worker's own clock, so four bookmarks added in a loop
 * routinely share a millisecond. `duplicateGroups` orders copies oldest first and tie-breaks on the
 * id, which is a random uuid — so insertion order is not what comes back, and a positional
 * assertion here would pass or fail on which uuid was minted. The ordering itself is pinned where
 * the clock can be held still: `test/unit/vault/duplicates.test.ts`.
 */
function idsIn(group: DupeGroup | undefined): string[] {
  return (group?.items ?? []).map((item) => item.id).sort();
}

/** The same sort, for the expected side. */
function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/**
 * The vault's current revision, read off the plaintext header the way the sync engine does.
 *
 * Flushed first: the repository coalesces writes for 300 ms, so the number in storage lags the one
 * in memory by up to that long, and a test asserting "exactly one revision" against a lagging
 * header would be asserting nothing at all.
 */
async function rev(): Promise<number> {
  const worker = await import('../../../src/background/session.js');
  await (await worker.currentRepository())?.flush();
  const meta = mock.storage.local.snapshot()['vm.meta'] as { vaultRev: number };
  return meta.vaultRev;
}

/**
 * Save the same page twice.
 *
 * The add path refuses a second copy outright, so this is the route a real vault takes to one: the
 * tracking strip switched off, a page saved from two different mailings, and the campaign parameter
 * left in the address of each. Turning the strip back on is what a user does when they finally
 * notice — and it changes nothing about what is already saved, which is the whole reason the
 * duplicates screen exists.
 */
async function addDuplicatePair(path: string): Promise<[string, string]> {
  await send({ type: 'SET_SETTINGS', settings: { stripTrackingParams: false } });
  const first = await addBookmark(`https://example.com/${path}?utm_source=one`, `${path} from one`);
  const second = await addBookmark(`https://example.com/${path}?utm_source=two`, `${path} from two`);
  await send({ type: 'SET_SETTINGS', settings: { stripTrackingParams: true } });
  return [first, second];
}

/* ---------------------------------------------------------------- harness */

beforeAll(async () => {
  mock = installChromeMock();
  await startWorker();
  await send({ type: 'CREATE_VAULT', password: PASSWORD });
  seededLocal = structuredClone(mock.storage.local.snapshot());
  seededSession = structuredClone(mock.storage.session.snapshot());
  mock.terminateWorker();
  uninstallChromeMock();
}, 60_000);

beforeEach(async () => {
  mock = installChromeMock();
  await mock.storage.local.set(structuredClone(seededLocal));
  await mock.storage.session.set(structuredClone(seededSession));
  await startWorker();
});

afterEach(async () => {
  // Drain before tearing the browser down.
  //
  // The repository coalesces writes for 300 ms and the sync engine debounces for 3 s, and
  // `terminateWorker()` clears listeners but not timers — so a test that ends mid-window leaves a
  // write that lands in the *next* test's storage mock, on top of its seed. That is the mechanism
  // behind every "a bookmark from another test appeared in this list" failure this file has ever
  // produced.
  const session = await import('../../../src/background/session.js');
  await (await session.currentRepository())?.flush();
  (await import('../../../src/sync/engine.js')).resetSync();
  uninstallChromeMock();
});

afterAll(() => {
  uninstallChromeMock();
});

/* ------------------------------------------------------------------ folders */

describe('folders', () => {
  it('creates one, nests another inside it, and lists both in place', async () => {
    const work = await addFolder('Work');
    await addFolder('Roadmaps', work);
    await addBookmark('https://example.com/top', 'Top level');

    expect(await titles()).toEqual(['Work', 'Top level']);
    expect(await titles({ folderId: work })).toEqual(['Roadmaps']);
  });

  it('puts folders above bookmarks whatever the sort order says', async () => {
    // The folder is created first and so is the *oldest* item; "newest first" would bury it.
    const work = await addFolder('Work');
    await addBookmark('https://example.com/a', 'A bookmark');
    const rows = await view({ sort: 'added' });
    expect(rows.map((row) => row.type)).toEqual(['folder', 'bookmark']);
    expect(rows[0]!.id).toBe(work);
  });

  it('counts the bookmarks in a subtree, not only the direct children', async () => {
    const work = await addFolder('Work');
    const inner = await addFolder('Roadmaps', work);
    await send({ type: 'ADD_URL', url: 'https://example.com/1', title: 'One' });
    await send({ type: 'MOVE_ITEMS', ids: [(await view())[1]!.id], parentId: inner });

    const rows = await view();
    expect(rows[0]).toMatchObject({ title: 'Work', descendants: 1 });

    const folders = (await tree())['folders'] as { id: string; descendants: number }[];
    expect(folders.find((folder) => folder.id === work)?.descendants).toBe(1);
    expect(folders.find((folder) => folder.id === inner)?.descendants).toBe(1);
  });

  it('gives a nested folder breadcrumbs, and the top level none', async () => {
    const work = await addFolder('Work');
    const inner = await addFolder('Roadmaps', work);

    const response = await send({ type: 'LIST_VIEW', folderId: inner });
    expect(response['path']).toEqual([
      { id: work, title: 'Work' },
      { id: inner, title: 'Roadmaps' },
    ]);
    expect((await send({ type: 'LIST_VIEW' }))['path']).toEqual([]);
  });

  it('renames a folder', async () => {
    const work = await addFolder('Work');
    expect(await send({ type: 'UPDATE_ITEM', id: work, patch: { title: 'Projects' } })).toEqual({
      type: 'OK',
    });
    expect(await titles()).toEqual(['Projects']);
  });

  it('refuses to move a folder inside itself', async () => {
    const work = await addFolder('Work');
    const inner = await addFolder('Roadmaps', work);
    expect(await send({ type: 'MOVE_ITEMS', ids: [work], parentId: inner })).toEqual({
      type: 'ERROR',
      code: 'INVALID_MUTATION',
    });
    // …and nothing moved.
    expect((await detail(work))!['parentId']).toBe('root');
  });

  it('refuses to move an item into a bookmark', async () => {
    const target = await addBookmark('https://example.com/a', 'A');
    const moving = await addBookmark('https://example.com/b', 'B');
    expect(await send({ type: 'MOVE_ITEMS', ids: [moving], parentId: target })).toMatchObject({
      code: 'INVALID_MUTATION',
    });
  });

  describe('deleting one', () => {
    async function seedFolderWithChild(): Promise<{ folder: string; child: string }> {
      const folder = await addFolder('Work');
      const child = await addBookmark('https://example.com/inside', 'Inside');
      await send({ type: 'MOVE_ITEMS', ids: [child], parentId: folder });
      return { folder, child };
    }

    it('takes the subtree with it when asked to', async () => {
      const { folder, child } = await seedFolderWithChild();
      expect(await send({ type: 'DELETE_FOLDER', id: folder, mode: 'recursive' })).toEqual({
        type: 'OK',
      });
      expect(await detail(folder)).toBeNull();
      expect(await detail(child)).toBeNull();
    });

    it('lifts the children to the parent when asked to', async () => {
      const { folder, child } = await seedFolderWithChild();
      await send({ type: 'DELETE_FOLDER', id: folder, mode: 'reparent' });
      expect(await detail(folder)).toBeNull();
      expect((await detail(child))!['parentId']).toBe('root');
      expect(await titles()).toEqual(['Inside']);
    });

    it('has no default mode — the wire refuses a request without one', async () => {
      // One answer loses a subtree and the other rearranges the tree. Picking either silently is
      // a way to lose someone's bookmarks, so the absence of a mode is a malformed request.
      const { folder, child } = await seedFolderWithChild();
      await expectRejected({ type: 'DELETE_FOLDER', id: folder });
      await expectRejected({ type: 'DELETE_FOLDER', id: folder, mode: 'whatever' });
      expect(await detail(folder)).not.toBeNull();
      expect(await detail(child)).not.toBeNull();
    });

    it('refuses to treat a bookmark as a folder', async () => {
      const bookmark = await addBookmark('https://example.com/a', 'A');
      expect(await send({ type: 'DELETE_FOLDER', id: bookmark, mode: 'recursive' })).toMatchObject({
        code: 'INVALID_MUTATION',
      });
    });
  });
});

/* ------------------------------------------------------------------ editing */

describe('editing an item', () => {
  it('changes the title, the URL and the note', async () => {
    const id = await addBookmark('https://example.com/before', 'Before');
    await send({
      type: 'UPDATE_ITEM',
      id,
      patch: { title: 'After', url: 'https://example.com/after', note: 'Read this first' },
    });
    expect(await detail(id)).toMatchObject({
      title: 'After',
      url: 'https://example.com/after',
      note: 'Read this first',
      hasNote: true,
    });
  });

  it('clears a note with null, which is the only way to express it', async () => {
    const id = await addBookmark('https://example.com/a', 'A');
    await send({ type: 'UPDATE_ITEM', id, patch: { note: 'temporary' } });
    await send({ type: 'UPDATE_ITEM', id, patch: { note: null } });
    expect(await detail(id)).toMatchObject({ note: '', hasNote: false });
  });

  it('truncates a note at the 4 KB cap rather than refusing it', async () => {
    // Nobody should lose what they typed to a limit they could not see coming.
    const id = await addBookmark('https://example.com/a', 'A');
    await send({ type: 'UPDATE_ITEM', id, patch: { note: 'x'.repeat(5_000) } });
    expect((await detail(id))!['note']).toHaveLength(4_096);
  });

  it('refuses a URL the add pipeline would have refused', async () => {
    // The edit box is a second door into the vault. A `javascript:` bookmark must not be reachable
    // through it just because the add path was not used.
    const id = await addBookmark('https://example.com/a', 'A');
    for (const [url, code] of [
      ['javascript:alert(1)', 'URL_UNSUPPORTED_SCHEME'],
      ['file:///etc/passwd', 'URL_LOCAL_FILE'],
      ['chrome://settings', 'URL_INTERNAL_PAGE'],
      ['not a url', 'URL_UNSUPPORTED_SCHEME'],
    ] as const) {
      expect(await send({ type: 'UPDATE_ITEM', id, patch: { url } }), url).toEqual({
        type: 'ERROR',
        code,
      });
    }
    expect((await detail(id))!['url']).toBe('https://example.com/a');
  });

  it('reports an unknown id instead of silently doing nothing', async () => {
    expect(await send({ type: 'UPDATE_ITEM', id: 'nope', patch: { title: 'x' } })).toEqual({
      type: 'ERROR',
      code: 'ITEM_NOT_FOUND',
    });
  });

  it('refuses to give a folder a URL', async () => {
    const folder = await addFolder('Work');
    expect(
      await send({ type: 'UPDATE_ITEM', id: folder, patch: { url: 'https://example.com/' } }),
    ).toMatchObject({ code: 'INVALID_MUTATION' });
  });
});

/* ------------------------------------------------------------------ tags */

describe('tags', () => {
  it('adds and removes across a selection, normalizing as it goes', async () => {
    const a = await addBookmark('https://example.com/a', 'A');
    const b = await addBookmark('https://example.com/b', 'B');

    expect(await send({ type: 'TAG_ITEMS', ids: [a, b], add: ['  Reading LIST '] })).toEqual({
      type: 'COUNT',
      count: 2,
    });
    expect((await detail(a))!['tags']).toEqual(['reading list']);

    expect(await send({ type: 'TAG_ITEMS', ids: [a], remove: ['READING list'] })).toEqual({
      type: 'COUNT',
      count: 1,
    });
    expect((await detail(a))!['tags']).toEqual([]);
    expect((await detail(b))!['tags']).toEqual(['reading list']);
  });

  it('counts only the items it actually changed', async () => {
    const a = await addBookmark('https://example.com/a', 'A');
    const b = await addBookmark('https://example.com/b', 'B');
    await send({ type: 'TAG_ITEMS', ids: [a], add: ['dev'] });
    // `a` already has it; only `b` changes.
    expect(await send({ type: 'TAG_ITEMS', ids: [a, b], add: ['dev'] })).toEqual({
      type: 'COUNT',
      count: 1,
    });
  });

  it('renames a tag everywhere it appears', async () => {
    const a = await addBookmark('https://example.com/a', 'A');
    const b = await addBookmark('https://example.com/b', 'B');
    const c = await addBookmark('https://example.com/c', 'C');
    await send({ type: 'TAG_ITEMS', ids: [a, b], add: ['dev'] });

    expect(await send({ type: 'RENAME_TAG', from: 'dev', to: 'Engineering' })).toEqual({
      type: 'COUNT',
      count: 2,
    });
    expect((await detail(a))!['tags']).toEqual(['engineering']);
    expect((await detail(b))!['tags']).toEqual(['engineering']);
    expect((await detail(c))!['tags']).toEqual([]);
  });

  it('deletes a tag off everything, leaving the bookmarks and their other tags', async () => {
    const a = await addBookmark('https://example.com/a', 'A');
    const b = await addBookmark('https://example.com/b', 'B');
    const c = await addBookmark('https://example.com/c', 'C');
    await send({ type: 'TAG_ITEMS', ids: [a, b], add: ['dev'] });
    await send({ type: 'TAG_ITEMS', ids: [a], add: ['papers'] });

    expect(await send({ type: 'DELETE_TAG', tag: 'DEV' })).toEqual({ type: 'COUNT', count: 2 });
    expect((await detail(a))!['tags']).toEqual(['papers']);
    expect((await detail(b))!['tags']).toEqual([]);
    // Three bookmarks in, three bookmarks out: this deletes a tag, not what wears it.
    expect([...(await titles({}))].sort()).toEqual(['A', 'B', 'C']);
    expect((await detail(c))!['tags']).toEqual([]);
    // And the tag is gone from the cloud, which is the whole of a tag ceasing to exist.
    expect((await tree())['tags']).toEqual([{ tag: 'papers', count: 1 }]);
  });

  it('reports the tag cloud with use counts, most used first', async () => {
    const a = await addBookmark('https://example.com/a', 'A');
    const b = await addBookmark('https://example.com/b', 'B');
    await send({ type: 'TAG_ITEMS', ids: [a, b], add: ['dev'] });
    await send({ type: 'TAG_ITEMS', ids: [a], add: ['papers'] });

    expect((await tree())['tags']).toEqual([
      { tag: 'dev', count: 2 },
      { tag: 'papers', count: 1 },
    ]);
  });

  it('counts the untagged bookmarks and can list exactly them', async () => {
    const a = await addBookmark('https://example.com/a', 'A');
    await addBookmark('https://example.com/b', 'B');
    await addFolder('Work');
    await send({ type: 'TAG_ITEMS', ids: [a], add: ['dev'] });

    expect(await tree()).toMatchObject({ total: 2, untagged: 1 });
    // Folders are not untagged bookmarks; they are not bookmarks.
    expect(await titles({ untagged: true })).toEqual(['B']);
  });
});

/* ------------------------------------------------------------------ bulk operations */

describe('bulk operations', () => {
  async function seedThree(): Promise<string[]> {
    return [
      await addBookmark('https://example.com/1', 'One'),
      await addBookmark('https://example.com/2', 'Two'),
      await addBookmark('https://example.com/3', 'Three'),
    ];
  }

  it('moves a whole selection in one go', async () => {
    const ids = await seedThree();
    const work = await addFolder('Work');
    expect(await send({ type: 'MOVE_ITEMS', ids, parentId: work })).toEqual({
      type: 'COUNT',
      count: 3,
    });
    expect((await titles({ folderId: work })).toSorted()).toEqual(['One', 'Three', 'Two']);
    expect(await titles()).toEqual(['Work']);
  });

  /*
   * Positioned moves (Phase 12). `moveItem` has taken an `afterId` since Phase 3; until the manager
   * grew a manual sort order there was no view in which the answer was visible, so the wire never
   * carried it and nothing exercised it end to end.
   */
  describe('to a position', () => {
    it('tells "append", "put it first" and "after that one" apart', async () => {
      const ids = await seedThree();
      const order = async (): Promise<string[]> => await titles({ sort: 'manual' });
      expect(await order()).toEqual(['One', 'Two', 'Three']);

      // `null` is the top. Absent would have appended, which is what a drop *onto* a folder does,
      // and collapsing the two is the bug the wire parser is written to prevent.
      await send({ type: 'MOVE_ITEMS', ids: [ids[2]!], parentId: 'root', afterId: null });
      expect(await order()).toEqual(['Three', 'One', 'Two']);

      await send({ type: 'MOVE_ITEMS', ids: [ids[2]!], parentId: 'root', afterId: ids[0]! });
      expect(await order()).toEqual(['One', 'Three', 'Two']);

      await send({ type: 'MOVE_ITEMS', ids: [ids[2]!], parentId: 'root' });
      expect(await order()).toEqual(['One', 'Two', 'Three']);
    });

    it('keeps a multiple selection the way round it was picked up', async () => {
      /*
       * The chained-anchor rule. `moveItem` inserts *immediately* after its anchor, so giving all
       * three the same `afterId` lands each one on top of the last and the block arrives reversed.
       * This is the assertion that would fail against the obvious implementation.
       */
      const ids = await seedThree();
      const fourth = await addBookmark('https://example.com/4', 'Four');
      await send({ type: 'MOVE_ITEMS', ids, parentId: 'root', afterId: fourth });
      expect(await titles({ sort: 'manual' })).toEqual(['Four', 'One', 'Two', 'Three']);
    });

    it('leaves every other order alone, because a position is not a date', async () => {
      const ids = await seedThree();
      const before = { added: await titles({ sort: 'added' }), title: await titles({ sort: 'title' }) };

      await send({ type: 'MOVE_ITEMS', ids: [ids[2]!], parentId: 'root', afterId: null });

      // Compared with what those orders were rather than with a literal: the point is that a
      // positioned move touches `order` and nothing a derived comparator reads.
      expect(await titles({ sort: 'added' })).toEqual(before.added);
      expect(await titles({ sort: 'title' })).toEqual(before.title);
      expect(await titles({ sort: 'manual' })).toEqual(['Three', 'One', 'Two']);
    });

    it('refuses a malformed position rather than silently appending', async () => {
      const ids = await seedThree();
      await expectRejected({ type: 'MOVE_ITEMS', ids, parentId: 'root', afterId: '' });
      await expectRejected({ type: 'MOVE_ITEMS', ids, parentId: 'root', afterId: 7 });
    });

    it('refuses an anchor that is not a sibling, which would be a position that does not exist', async () => {
      const ids = await seedThree();
      const work = await addFolder('Work');
      expect(
        await send({ type: 'MOVE_ITEMS', ids: [ids[0]!], parentId: work, afterId: ids[1]! }),
      ).toMatchObject({ code: 'INVALID_MUTATION' });
    });
  });

  it('moves nothing at all when one item in the batch is impossible', async () => {
    const ids = await seedThree();
    const work = await addFolder('Work');
    expect(
      await send({ type: 'MOVE_ITEMS', ids: [...ids, 'not-an-item'], parentId: work }),
    ).toMatchObject({ code: 'ITEM_NOT_FOUND' });
    // All three are still where they were. This is the assertion the batching exists for.
    expect((await titles()).toSorted()).toEqual(['One', 'Three', 'Two', 'Work']);
    expect(await titles({ folderId: work })).toEqual([]);
  });

  it('deletes a selection as one revision, and one undo brings all of it back', async () => {
    const ids = await seedThree();
    expect(await send({ type: 'DELETE_ITEMS', ids })).toEqual({ type: 'OK' });
    expect(await titles()).toEqual([]);

    expect(await send({ type: 'RESTORE_ITEMS', ids })).toEqual({ type: 'OK' });
    expect((await titles()).toSorted()).toEqual(['One', 'Three', 'Two']);
  });

  it('deletes nothing when one id in the batch is unknown', async () => {
    const ids = await seedThree();
    expect(await send({ type: 'DELETE_ITEMS', ids: [...ids, 'ghost'] })).toMatchObject({
      code: 'ITEM_NOT_FOUND',
    });
    expect(await titles()).toHaveLength(3);
  });

  it('tags nothing when the batch names something that is not there', async () => {
    const ids = await seedThree();
    // `tagMutations` skips ids it does not recognise rather than failing, because a selection is
    // allowed to contain a folder — so this is the one bulk operation that is best-effort, and
    // the count says exactly what happened.
    expect(await send({ type: 'TAG_ITEMS', ids: [...ids, 'ghost'], add: ['x'] })).toEqual({
      type: 'COUNT',
      count: 3,
    });
  });

  it('refuses an empty or malformed selection rather than answering OK to nothing', async () => {
    const ids = await seedThree();
    for (const type of ['DELETE_ITEMS', 'RESTORE_ITEMS', 'TAG_ITEMS'] as const) {
      await expectRejected({ type, ids: [], add: ['x'] });
      await expectRejected({ type, ids: ['', ...ids], add: ['x'] });
      await expectRejected({ type, ids: 'not-an-array', add: ['x'] });
    }
    await expectRejected({ type: 'MOVE_ITEMS', ids: [], parentId: 'root' });
    await expectRejected({ type: 'MOVE_ITEMS', ids, parentId: '' });
    expect(await titles()).toHaveLength(3);
  });

  it('tells the open UIs once per batch, not once per item', async () => {
    const observed = mock.observeMessages();
    const ids = await seedThree();
    const before = observed.length;
    await send({ type: 'DELETE_ITEMS', ids });
    const broadcasts = observed
      .slice(before)
      .filter((message) => (message as { type?: string }).type === 'VAULT_CHANGED');
    expect(broadcasts).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ views */

describe('the view', () => {
  async function seedForSearch(): Promise<void> {
    const work = await addFolder('Work');
    const planning = await addBookmark('https://intranet.test/planning', 'Quarterly planning');
    await send({ type: 'MOVE_ITEMS', ids: [planning], parentId: work });
    await send({ type: 'TAG_ITEMS', ids: [planning], add: ['ops'] });
    const recipe = await addBookmark('https://cooking.test/risotto', 'Mushroom risotto');
    await send({ type: 'UPDATE_ITEM', id: recipe, patch: { note: 'Toast the rice' } });
  }

  it('searches the whole vault, not only the folder on screen', async () => {
    await seedForSearch();
    expect(await titles({ query: 'planning' })).toEqual(['Quarterly planning']);
  });

  it('scopes a search to a folder when one is open', async () => {
    await seedForSearch();
    const work = (await view()).find((row) => row.type === 'folder')!.id;
    expect(await titles({ query: 'risotto', folderId: work })).toEqual([]);
    expect(await titles({ query: 'planning', folderId: work })).toEqual(['Quarterly planning']);
  });

  it('supports every filter the manager offers', async () => {
    await seedForSearch();
    expect(await titles({ query: 'tag:ops' })).toEqual(['Quarterly planning']);
    expect(await titles({ query: 'folder:work' })).toEqual(['Quarterly planning']);
    expect(await titles({ query: 'host:cooking.test' })).toEqual(['Mushroom risotto']);
    expect(await titles({ query: 'in:note rice' })).toEqual(['Mushroom risotto']);
  });

  it('hands back the folded terms so the list can highlight them', async () => {
    await seedForSearch();
    const response = await send({ type: 'LIST_VIEW', query: 'Planning tag:ops' });
    expect(response['terms']).toEqual(['planning']);
    expect(response['ranked']).toBe(true);
  });

  it('is ranked only when there is something to rank', async () => {
    await seedForSearch();
    // A filter-only query has no relevance to lose, so the sort key still applies.
    expect((await send({ type: 'LIST_VIEW', query: 'tag:ops' }))['ranked']).toBe(false);
    expect((await send({ type: 'LIST_VIEW' }))['ranked']).toBe(false);
    expect((await send({ type: 'LIST_VIEW', query: '   ' }))['ranked']).toBe(false);
  });

  it('sorts alphabetically when asked', async () => {
    await addBookmark('https://example.com/z', 'Zebra');
    await addBookmark('https://example.com/a', 'Apple');
    expect(await titles({ sort: 'title' })).toEqual(['Apple', 'Zebra']);
    expect(await titles({ sort: 'added' })).toEqual(['Apple', 'Zebra']);
  });

  it('remembers the sort order as a setting, so the next window opens the same way', async () => {
    // One order for the whole manager rather than one per folder: a per-folder preference has to be
    // keyed by folder id, and `vm.settings` is plaintext, so it would leak the shape of the tree.
    expect(await send({ type: 'GET_SETTINGS' })).toMatchObject({ settings: { sortBy: 'added' } });

    const saved = await send({ type: 'SET_SETTINGS', settings: { sortBy: 'title' } });
    expect(saved).toMatchObject({ settings: { sortBy: 'title' } });

    await startWorker();
    expect(await send({ type: 'GET_STATE' })).toMatchObject({ settings: { sortBy: 'title' } });
  });

  it('refuses a stored sort key it does not recognise', async () => {
    await expectRejected({ type: 'SET_SETTINGS', settings: { sortBy: 'sideways' } });
    expect(await send({ type: 'GET_SETTINGS' })).toMatchObject({ settings: { sortBy: 'added' } });
  });

  it('rejects a sort key it does not know rather than falling back quietly', async () => {
    await expectRejected({ type: 'LIST_VIEW', sort: 'sideways' });
    await expectRejected({ type: 'LIST_VIEW', folderId: '' });
    await expectRejected({ type: 'LIST_VIEW', untagged: 'yes' });
  });

  it('never carries a note on a list row, however long the note is', async () => {
    // 4 KB per note times five thousand rows is twenty megabytes on the wire to render a boolean.
    const id = await addBookmark('https://example.com/a', 'A');
    await send({ type: 'UPDATE_ITEM', id, patch: { note: 'a secret worth keeping' } });
    const rows = await view();
    expect(rows[0]).toMatchObject({ hasNote: true });
    expect(JSON.stringify(rows)).not.toContain('secret');
  });

  it('answers an unknown id with null rather than an error', async () => {
    expect(await detail('nope')).toBeNull();
  });

  it('never shows a deleted item in any view', async () => {
    const id = await addBookmark('https://example.com/a', 'A');
    await send({ type: 'TAG_ITEMS', ids: [id], add: ['dev'] });
    await send({ type: 'DELETE_ITEMS', ids: [id] });

    expect(await titles()).toEqual([]);
    expect(await titles({ query: 'a' })).toEqual([]);
    expect(await titles({ untagged: true })).toEqual([]);
    expect(await detail(id)).toBeNull();
    expect(await tree()).toMatchObject({ total: 0, tags: [] });
  });
});

/* ------------------------------------------------------------------ the master password */

describe('changing the master password', () => {
  const NEW_PASSWORD = 'an entirely different long passphrase';

  it('keeps the session open, because the data key did not change', async () => {
    // The KEK is re-derived and 32 bytes are re-wrapped; the DEK is the same key it was (D10).
    // Being thrown back to a lock screen for that would be a bug, not a precaution.
    const id = await addBookmark('https://example.com/a', 'A');
    expect(
      await send({ type: 'CHANGE_PASSWORD', currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
    ).toEqual({ type: 'OK' });

    expect(await send({ type: 'GET_STATE' })).toMatchObject({ exists: true, locked: false });
    expect((await detail(id))!['title']).toBe('A');
  }, 30_000);

  it('opens under the new password and refuses the old one', async () => {
    await addBookmark('https://example.com/a', 'A');
    await send({ type: 'CHANGE_PASSWORD', currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    await send({ type: 'LOCK' });

    expect(await send({ type: 'UNLOCK', password: PASSWORD })).toEqual({
      type: 'ERROR',
      code: 'WRONG_PASSWORD',
    });
    expect(await send({ type: 'UNLOCK', password: NEW_PASSWORD })).toEqual({ type: 'OK' });
    expect(await titles()).toEqual(['A']);
  }, 60_000);

  it('refuses a wrong current password, even though the vault is already open', async () => {
    // An unlocked session must not be a way to change the password without knowing it.
    expect(
      await send({ type: 'CHANGE_PASSWORD', currentPassword: 'not it at all', newPassword: NEW_PASSWORD }),
    ).toEqual({ type: 'ERROR', code: 'WRONG_PASSWORD' });

    await send({ type: 'LOCK' });
    expect(await send({ type: 'UNLOCK', password: PASSWORD })).toEqual({ type: 'OK' });
  }, 60_000);

  it('refuses a new password below the hard floor', async () => {
    expect(
      await send({ type: 'CHANGE_PASSWORD', currentPassword: PASSWORD, newPassword: 'short' }),
    ).toEqual({ type: 'ERROR', code: 'PASSWORD_TOO_SHORT' });
  }, 30_000);

  it('refuses a request whose passwords are not strings', async () => {
    await expectRejected({ type: 'CHANGE_PASSWORD', currentPassword: PASSWORD });
    await expectRejected({ type: 'CHANGE_PASSWORD', currentPassword: 1, newPassword: 2 });
  });
});

describe('destroying the vault', () => {
  /** Every key the Chrome sync provider owns. `vm.s.` is its whole namespace. */
  function syncedKeys(): string[] {
    return Object.keys(mock.storage.sync.snapshot()).filter((key) => key.startsWith('vm.s.'));
  }

  it('leaves no vm. key behind, and no key in the session', async () => {
    await addBookmark('https://example.com/a', 'A secret bookmark');
    expect(await send({ type: 'DESTROY_VAULT' })).toEqual({
      type: 'DESTROYED',
      remoteRemoved: true,
    });

    expect(Object.keys(mock.storage.local.snapshot()).filter((key) => key.startsWith('vm.'))).toEqual(
      [],
    );
    expect(mock.storage.session.snapshot()).toEqual({});
    // Not "locked" — gone. The difference is what decides between the unlock and create screens.
    expect(await send({ type: 'GET_STATE' })).toMatchObject({ exists: false, locked: true });
  });

  /*
   * The bug this pair of tests exists for (maintainer-reported after Phase 11).
   *
   * Destroy used to clear `storage.local` and nothing else, so the encrypted copy stayed in
   * `storage.sync`. The profile then came back offering to *adopt* the vault it had just been told
   * to destroy — and a replacement vault created with the same password could never open those
   * bytes, because a new vault is a new random DEK. The two deadlocked on `VAULT_MISMATCH` with
   * nothing on screen able to break the tie.
   */
  it('takes the synced copy with it, so the profile is not offered the vault it just destroyed', async () => {
    await addBookmark('https://example.com/a', 'A secret bookmark');
    await send({ type: 'SYNC_NOW' });
    expect(syncedKeys().length).toBeGreaterThan(0);

    await send({ type: 'DESTROY_VAULT' });

    expect(syncedKeys()).toEqual([]);
    // `adoptable` is what puts the "there is already a vault on your other computer" screen up.
    expect(await send({ type: 'GET_STATE' })).toMatchObject({ exists: false, adoptable: false });
  }, 30_000);

  it('leaves the synced copy alone when explicitly told to', async () => {
    await addBookmark('https://example.com/a', 'A secret bookmark');
    await send({ type: 'SYNC_NOW' });
    const before = syncedKeys();

    expect(await send({ type: 'DESTROY_VAULT', deleteRemote: false })).toEqual({
      type: 'DESTROYED',
      remoteRemoved: null,
    });

    expect(syncedKeys()).toEqual(before);
  }, 30_000);

  it('tells the open UIs, so a second window does not keep showing the vault', async () => {
    const observed = mock.observeMessages();
    await send({ type: 'DESTROY_VAULT' });
    expect(observed).toContainEqual({ type: 'SESSION_LOCKED', reason: 'manual' });
  });

  it('leaves the profile ready to create a new vault', async () => {
    await send({ type: 'DESTROY_VAULT' });
    expect(await send({ type: 'CREATE_VAULT', password: PASSWORD })).toEqual({ type: 'OK' });
    expect(await titles()).toEqual([]);
  }, 30_000);

  /** The whole point: destroy, recreate with the same password, and sync works. */
  it('lets a new vault with the same password sync, rather than deadlocking on a mismatch', async () => {
    await addBookmark('https://example.com/a', 'A secret bookmark');
    await send({ type: 'SYNC_NOW' });

    await send({ type: 'DESTROY_VAULT' });
    await send({ type: 'CREATE_VAULT', password: PASSWORD });
    await addBookmark('https://example.com/b', 'A fresh start');

    expect(await send({ type: 'SYNC_NOW' })).toMatchObject({ error: null });
  }, 60_000);
});

/* ------------------------------------------------------------------ tracking parameters */

/**
 * The clean-up offered when the strip-tracking setting is switched on.
 *
 * Seeded with the setting *off*, because with it on the add pipeline has already cleaned the URL
 * and there would be nothing left for this to find — which is exactly the situation the feature
 * exists for: a vault built before the setting was turned on.
 */
describe('cleaning tracking parameters out of a vault that already has them', () => {
  async function seedDirty(): Promise<{ tracked: string; clean: string }> {
    await send({ type: 'SET_SETTINGS', settings: { stripTrackingParams: false } });
    const tracked = await addBookmark(
      'https://example.com/article?utm_source=news&utm_medium=email&id=7',
      'Article',
    );
    const clean = await addBookmark('https://example.com/plain?id=7', 'Plain');
    await send({ type: 'SET_SETTINGS', settings: { stripTrackingParams: true } });
    return { tracked, clean };
  }

  it('counts only the bookmarks whose address would actually change', async () => {
    await seedDirty();
    expect(await send({ type: 'COUNT_TRACKING_PARAMS' })).toEqual({ type: 'COUNT', count: 1 });
  });

  it('counts nothing on a vault that has none, so nothing is offered', async () => {
    await addBookmark('https://example.com/plain?id=7', 'Plain');
    expect(await send({ type: 'COUNT_TRACKING_PARAMS' })).toEqual({ type: 'COUNT', count: 0 });
  });

  it('strips the campaign tags and leaves every other parameter alone', async () => {
    const { tracked, clean } = await seedDirty();

    expect(await send({ type: 'STRIP_TRACKING_PARAMS' })).toEqual({ type: 'COUNT', count: 1 });
    expect((await detail(tracked))?.['url']).toBe('https://example.com/article?id=7');
    // Untouched, and it must be: a clean bookmark rewritten is a `updatedAt` bump and a sync push
    // for nothing.
    expect((await detail(clean))?.['url']).toBe('https://example.com/plain?id=7');
  });

  it('is idempotent — a second run finds nothing to do', async () => {
    await seedDirty();
    await send({ type: 'STRIP_TRACKING_PARAMS' });

    expect(await send({ type: 'COUNT_TRACKING_PARAMS' })).toEqual({ type: 'COUNT', count: 0 });
    expect(await send({ type: 'STRIP_TRACKING_PARAMS' })).toEqual({ type: 'COUNT', count: 0 });
  });

  it('ignores tombstones, so a deleted bookmark is neither counted nor resurrected', async () => {
    const { tracked } = await seedDirty();
    await send({ type: 'DELETE_ITEMS', ids: [tracked] });

    expect(await send({ type: 'COUNT_TRACKING_PARAMS' })).toEqual({ type: 'COUNT', count: 0 });
    expect(await send({ type: 'STRIP_TRACKING_PARAMS' })).toEqual({ type: 'COUNT', count: 0 });
    expect(await detail(tracked)).toBeNull();
  });

  it('leaves two bookmarks that collapse to the same address as two bookmarks', async () => {
    // Deliberate: this operation was asked for as a clean-up of addresses, and deleting a bookmark
    // someone saved twice is a different decision that nobody made.
    await send({ type: 'SET_SETTINGS', settings: { stripTrackingParams: false } });
    await addBookmark('https://example.com/a?utm_source=one', 'From one');
    await addBookmark('https://example.com/a?utm_source=two', 'From two');
    await send({ type: 'SET_SETTINGS', settings: { stripTrackingParams: true } });

    expect(await send({ type: 'STRIP_TRACKING_PARAMS' })).toEqual({ type: 'COUNT', count: 2 });
    // Sorted newest-first by default; what this asserts is that both are still there.
    expect([...(await titles())].sort()).toEqual(['From one', 'From two']);
  });
});

/* ------------------------------------------------------------------ the locked vault */

describe('a locked vault', () => {
  it('answers every manager request with VAULT_LOCKED and changes nothing', async () => {
    const id = await addBookmark('https://example.com/a', 'A');
    await send({ type: 'LOCK' });

    for (const request of [
      { type: 'GET_TREE' },
      { type: 'LIST_VIEW' },
      { type: 'LIST_DUPLICATES' },
      { type: 'GET_ITEM', id },
      { type: 'CREATE_FOLDER', title: 'Work' },
      { type: 'UPDATE_ITEM', id, patch: { title: 'x' } },
      { type: 'MOVE_ITEMS', ids: [id], parentId: 'root' },
      { type: 'DELETE_FOLDER', id, mode: 'recursive' },
      { type: 'TAG_ITEMS', ids: [id], add: ['x'] },
      { type: 'RENAME_TAG', from: 'a', to: 'b' },
      { type: 'COUNT_TRACKING_PARAMS' },
      { type: 'STRIP_TRACKING_PARAMS' },
      { type: 'DELETE_ITEMS', ids: [id] },
      { type: 'RESTORE_ITEMS', ids: [id] },
      { type: 'CHANGE_PASSWORD', currentPassword: PASSWORD, newPassword: 'another long one' },
      { type: 'DESTROY_VAULT' },
    ]) {
      expect(await send(request), JSON.stringify(request)).toEqual({
        type: 'ERROR',
        code: 'VAULT_LOCKED',
      });
    }
  });
});

/* ------------------------------------------------------------------ duplicates (Phase 16) */

/**
 * The cleanup half of Phase 16, driven over the wire.
 *
 * The theme is the same as everywhere else in this file — **one batch, one revision** — with one
 * addition that only this screen has: what it groups is a *proposal*, so the assertions about what
 * is *not* grouped (tombstones, singletons) matter as much as the ones about what is. A screen
 * whose only verb is delete must not propose deleting something twice.
 */
describe('duplicates', () => {
  it('finds an address saved twice, each copy with its own folder path', async () => {
    const work = await addFolder('Work');
    const [first, second] = await addDuplicatePair('a');
    await send({ type: 'MOVE_ITEMS', ids: [second], parentId: work });
    await addBookmark('https://example.com/only-once', 'Once');

    const groups = await duplicates();
    expect(groups).toHaveLength(1);
    expect(idsIn(groups[0])).toEqual(sorted([first, second]));

    // Each copy carries its own path, which is one of the few things that tells two copies apart —
    // and the reason it is on the row rather than fetched per item the way the detail pane does it.
    const byId = new Map((groups[0]?.items ?? []).map((item) => [item.id, item]));
    expect(byId.get(first)?.path).toEqual([]);
    expect(byId.get(second)?.path.map((crumb) => crumb.title)).toEqual(['Work']);
  });

  it('says nothing about a vault in which every address is saved once', async () => {
    await addBookmark('https://example.com/a', 'A');
    await addBookmark('https://example.com/b', 'B');
    expect(await duplicates()).toEqual([]);
    expect((await tree())['duplicates']).toBe(0);
  });

  it('counts addresses rather than copies on the tree', async () => {
    await addDuplicatePair('a');
    await addDuplicatePair('b');
    await addBookmark('https://example.com/c', 'C');

    // Four bookmarks are involved, and the sidebar says 2: two addresses to look at.
    expect((await tree())['duplicates']).toBe(2);
    expect(await duplicates()).toHaveLength(2);
  });

  it('never groups a tombstone', async () => {
    const [first, second] = await addDuplicatePair('a');
    await send({ type: 'DELETE_ITEMS', ids: [second] });

    // One live copy left, so there is nothing to compare it with — and offering to remove the
    // tombstone would be offering to delete what is already deleted.
    expect(await duplicates()).toEqual([]);
    expect((await tree())['duplicates']).toBe(0);

    await send({ type: 'RESTORE_ITEMS', ids: [second] });
    expect(idsIn((await duplicates())[0])).toEqual(sorted([first, second]));
  });

  /**
   * The assertion the phase was written around.
   *
   * Removal reuses `DELETE_ITEMS`, so a group of *n* costs exactly one revision however many copies
   * are ticked — one write, one thing for the merge engine to carry, one undo. A per-copy delete
   * would pass every other test in this file and fail this one.
   */
  it('removes a whole group in exactly one revision, and the undo puts it back', async () => {
    await send({ type: 'SET_SETTINGS', settings: { stripTrackingParams: false } });
    const ids: string[] = [];
    for (const source of ['one', 'two', 'three', 'four']) {
      ids.push(await addBookmark(`https://example.com/a?utm_source=${source}`, `From ${source}`));
    }
    await send({ type: 'SET_SETTINGS', settings: { stripTrackingParams: true } });

    const group = (await duplicates())[0];
    expect(group?.items).toHaveLength(4);

    // Three of the four, which is the shape "Tick all but the oldest" leaves behind.
    const doomed = ids.slice(1);
    const before = await rev();
    expect(await send({ type: 'DELETE_ITEMS', ids: doomed })).toEqual({ type: 'OK' });
    expect(await rev()).toBe(before + 1);

    expect(await duplicates()).toEqual([]);
    expect(await titles()).toEqual(['From one']);

    // And the undo is one revision too, restoring under the same ids rather than adding new ones.
    const afterDelete = await rev();
    expect(await send({ type: 'RESTORE_ITEMS', ids: doomed })).toEqual({ type: 'OK' });
    expect(await rev()).toBe(afterDelete + 1);
    expect(idsIn((await duplicates())[0])).toEqual(sorted(ids));
  });

  it('rejects the whole removal when one of the ids is gone', async () => {
    const [first, second] = await addDuplicatePair('a');
    const before = await rev();

    expect(await send({ type: 'DELETE_ITEMS', ids: [second, 'no-such-item'] })).toEqual({
      type: 'ERROR',
      code: 'ITEM_NOT_FOUND',
    });
    // Nothing moved, not even the id that was real. A screen working from a stale list is told,
    // not half-obeyed.
    expect(await rev()).toBe(before);
    expect(idsIn((await duplicates())[0])).toEqual(sorted([first, second]));
  });

  it('groups two bookmarks edited into the same address', async () => {
    // The other way a vault grows a duplicate: the add path refuses one, but nothing stops the
    // detail pane from pointing an existing bookmark at an address another one already holds.
    const first = await addBookmark('https://example.com/a', 'A');
    const second = await addBookmark('https://example.com/b', 'B');
    await send({ type: 'UPDATE_ITEM', id: second, patch: { url: 'https://example.com/a' } });

    const groups = await duplicates();
    expect(groups).toHaveLength(1);
    expect(idsIn(groups[0])).toEqual(sorted([first, second]));
  });

  it('reports which copy carries a note, because that is often why it is the one to keep', async () => {
    const [, second] = await addDuplicatePair('a');
    await send({ type: 'UPDATE_ITEM', id: second, patch: { note: 'the good one' } });

    const items = (await duplicates())[0]?.items ?? [];
    expect(items.find((item) => item.id === second)?.hasNote).toBe(true);
    expect(items.filter((item) => item.hasNote)).toHaveLength(1);
  });
});
