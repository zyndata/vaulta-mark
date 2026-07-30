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

async function send(message: unknown): Promise<Record<string, unknown>> {
  return (await mock.sendMessage(message)) as Record<string, unknown>;
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

afterEach(() => {
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
  it('leaves no vm. key behind, and no key in the session', async () => {
    await addBookmark('https://example.com/a', 'A secret bookmark');
    expect(await send({ type: 'DESTROY_VAULT' })).toEqual({ type: 'OK' });

    expect(Object.keys(mock.storage.local.snapshot()).filter((key) => key.startsWith('vm.'))).toEqual(
      [],
    );
    expect(mock.storage.session.snapshot()).toEqual({});
    // Not "locked" — gone. The difference is what decides between the unlock and create screens.
    expect(await send({ type: 'GET_STATE' })).toMatchObject({ exists: false, locked: true });
  });

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
});

/* ------------------------------------------------------------------ the locked vault */

describe('a locked vault', () => {
  it('answers every manager request with VAULT_LOCKED and changes nothing', async () => {
    const id = await addBookmark('https://example.com/a', 'A');
    await send({ type: 'LOCK' });

    for (const request of [
      { type: 'GET_TREE' },
      { type: 'LIST_VIEW' },
      { type: 'GET_ITEM', id },
      { type: 'CREATE_FOLDER', title: 'Work' },
      { type: 'UPDATE_ITEM', id, patch: { title: 'x' } },
      { type: 'MOVE_ITEMS', ids: [id], parentId: 'root' },
      { type: 'DELETE_FOLDER', id, mode: 'recursive' },
      { type: 'TAG_ITEMS', ids: [id], add: ['x'] },
      { type: 'RENAME_TAG', from: 'a', to: 'b' },
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
