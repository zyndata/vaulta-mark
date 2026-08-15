/**
 * The Phase-5 journey, driven the way the popup drives it: everything over
 * `chrome.runtime.sendMessage`, nothing reaching into the modules underneath.
 *
 * Add the active tab → see it in the list → open it in incognito → delete it → undo. Each of those
 * is a separate unit test somewhere; what this file adds is that they compose over one real vault,
 * through the real router, with the service worker being torn down at the points where MV3 tears it
 * down for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HISTORY_QUEUE_KEY } from '../../src/background/incognito.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../mocks/chrome.js';

const PASSWORD = 'a reasonably long master password';
const PAGE = { id: 1, url: 'https://example.com/an/article', title: 'An article', active: true };

let mock: ChromeMock;

/**
 * Import the worker as a cold MV3 start does: the old worker's listeners go, the module registry
 * is fresh, and `storage.local` is exactly as the previous worker left it.
 */
async function startWorker(): Promise<void> {
  mock.terminateWorker();
  vi.resetModules();
  await import('../../src/background/index.js');
}

async function send(message: unknown): Promise<Record<string, unknown>> {
  return (await mock.sendMessage(message)) as Record<string, unknown>;
}

async function listItems(query?: string): Promise<{ id: string; title: string; url: string }[]> {
  const response = await send({
    type: 'LIST_ITEMS',
    ...(query === undefined ? {} : { query }),
  });
  return response['items'] as { id: string; title: string; url: string }[];
}

beforeEach(async () => {
  mock = installChromeMock();
  await startWorker();
  // Asserted, not fired and forgotten: a stray write from a previous test's dead worker landing in
  // this mock would make CREATE_VAULT fail with VAULT_STATE, and every assertion after it would
  // then fail for a reason that has nothing to do with what it was testing.
  expect(await send({ type: 'CREATE_VAULT', password: PASSWORD })).toEqual({ type: 'OK' });
});

afterEach(() => {
  uninstallChromeMock();
});

describe('adding the active tab', () => {
  it('appears in the list, and opens in an incognito window', async () => {
    mock.openTabs.push(PAGE);
    mock.incognitoAccess = true;

    const added = await send({ type: 'ADD_ACTIVE_TAB' });
    expect(added).toMatchObject({ type: 'ADDED', status: 'added' });

    const items = await listItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'An article', url: PAGE.url });

    const opened = await send({ type: 'OPEN_ITEM', id: items[0]!.id });
    expect(opened).toEqual({ type: 'OPENED', status: 'incognito' });
    expect(mock.createdWindows).toEqual([
      { incognito: true, url: PAGE.url, focused: true },
    ]);
  });

  it('survives the worker being killed between the add and the list', async () => {
    mock.openTabs.push(PAGE);
    await send({ type: 'ADD_ACTIVE_TAB' });

    // MV3 kills the worker after ~30 s idle. The item has to be on disk, not in a module variable.
    await startWorker();

    expect(await listItems()).toHaveLength(1);
  });

  it('answers a second add of the same page with the item that is already there', async () => {
    mock.openTabs.push(PAGE);
    const first = await send({ type: 'ADD_ACTIVE_TAB' });
    const second = await send({ type: 'ADD_ACTIVE_TAB' });

    expect(second['status']).toBe('duplicate');
    expect((second['item'] as { id: string }).id).toBe((first['item'] as { id: string }).id);
    expect(await listItems()).toHaveLength(1);
  });

  it('refuses a browser page with a reason the UI can explain', async () => {
    mock.openTabs.push({ id: 1, url: 'chrome://settings/', title: 'Settings', active: true });
    expect(await send({ type: 'ADD_ACTIVE_TAB' })).toEqual({
      type: 'ERROR',
      code: 'URL_INTERNAL_PAGE',
    });
    expect(await listItems()).toEqual([]);
  });

  it('refuses to add anything at all while locked', async () => {
    mock.openTabs.push(PAGE);
    await send({ type: 'LOCK' });

    expect(await send({ type: 'ADD_ACTIVE_TAB' })).toEqual({
      type: 'ERROR',
      code: 'VAULT_LOCKED',
    });
    expect(await send({ type: 'LIST_ITEMS' })).toEqual({ type: 'ERROR', code: 'VAULT_LOCKED' });
  });

  it('vaults a link from the context menu without opening it', async () => {
    const added = await send({
      type: 'ADD_URL',
      url: 'https://example.org/linked',
      title: 'A link',
    });

    expect(added).toMatchObject({ type: 'ADDED', status: 'added' });
    expect(mock.createdWindows).toEqual([]);
    expect(mock.createdTabs).toEqual([]);
    expect(await listItems()).toHaveLength(1);
  });
});

describe('the list', () => {
  beforeEach(async () => {
    await send({ type: 'ADD_URL', url: 'https://github.com/zyndata', title: 'zyndata on GitHub' });
    await send({ type: 'ADD_URL', url: 'https://example.com/recipes', title: 'Recipes' });
  });

  it('is newest first', async () => {
    expect((await listItems()).map((item) => item.title)).toEqual([
      'Recipes',
      'zyndata on GitHub',
    ]);
  });

  it('filters on a substring of the address, not only on the title', async () => {
    expect((await listItems('github')).map((item) => item.title)).toEqual(['zyndata on GitHub']);
    expect(await listItems('nothing here')).toEqual([]);
  });

  it('trims to a limit the caller asked for, and says how many matched', async () => {
    const response = await send({ type: 'LIST_ITEMS', limit: 1 });
    expect(response['items']).toHaveLength(1);
    expect(response['total']).toBe(2);
  });

  it('returns everything when no limit is asked for', async () => {
    // There is no default row cap: the popup shows the whole vault and scrolls it, because favicons
    // load lazily and rows below the fold cost nothing. A cap here would put a "showing 20 of 143"
    // line between someone and their own bookmarks for no benefit.
    for (let i = 0; i < 60; i++) {
      await send({ type: 'ADD_URL', url: `https://example.com/page-${i}`, title: `Page ${i}` });
    }
    const response = await send({ type: 'LIST_ITEMS' });
    expect(response['items']).toHaveLength(62);
    expect(response['total']).toBe(62);
  }, 30_000);
});

describe('delete and undo', () => {
  it('restores the same bookmark rather than making a second one', async () => {
    await send({ type: 'ADD_URL', url: 'https://example.com/x', title: 'Example' });
    const [item] = await listItems();

    expect(await send({ type: 'DELETE_ITEMS', ids: [item!.id] })).toEqual({ type: 'OK' });
    expect(await listItems()).toEqual([]);

    expect(await send({ type: 'RESTORE_ITEMS', ids: [item!.id] })).toEqual({ type: 'OK' });
    const restored = await listItems();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).toBe(item!.id);
  });

  it('survives a worker restart between the delete and the undo', async () => {
    await send({ type: 'ADD_URL', url: 'https://example.com/x', title: 'Example' });
    const [item] = await listItems();
    await send({ type: 'DELETE_ITEMS', ids: [item!.id] });

    await startWorker();

    expect(await send({ type: 'RESTORE_ITEMS', ids: [item!.id] })).toEqual({ type: 'OK' });
    expect(await listItems()).toHaveLength(1);
  });

  it('reports an id the vault has never held', async () => {
    expect(await send({ type: 'DELETE_ITEMS', ids: ['not-an-item'] })).toEqual({
      type: 'ERROR',
      code: 'ITEM_NOT_FOUND',
    });
  });
});

describe('opening without incognito access', () => {
  let itemId: string;

  beforeEach(async () => {
    await send({ type: 'ADD_URL', url: 'https://example.com/private', title: 'Private' });
    itemId = (await listItems())[0]!.id;
  });

  it('opens nothing and asks for the guided prompt', async () => {
    expect(await send({ type: 'OPEN_ITEM', id: itemId })).toEqual({
      type: 'OPENED',
      status: 'needs-incognito-access',
    });
    expect(mock.createdWindows).toEqual([]);
  });

  it('hands the UI the address it has to tell the user to paste', async () => {
    expect(await send({ type: 'INCOGNITO_ACCESS' })).toEqual({
      type: 'INCOGNITO_ACCESS_STATE',
      allowed: false,
      settingsUrl: `chrome://extensions/?id=${mock.chrome.runtime.id}`,
    });
  });

  it('sees the toggle being turned on, but only on an explicit re-check', async () => {
    await send({ type: 'INCOGNITO_ACCESS' });
    mock.incognitoAccess = true;

    expect((await send({ type: 'INCOGNITO_ACCESS' }))['allowed']).toBe(false);
    expect((await send({ type: 'INCOGNITO_ACCESS', recheck: true }))['allowed']).toBe(true);
    expect(await send({ type: 'OPEN_ITEM', id: itemId })).toEqual({
      type: 'OPENED',
      status: 'incognito',
    });
  });

  it('opens a normal window only on the explicit fallback, and queues the cleanup', async () => {
    const opened = await send({
      type: 'OPEN_ITEM',
      id: itemId,
      force: true,
      clearHistoryAfter: true,
    });

    expect(opened).toEqual({ type: 'OPENED', status: 'normal' });
    expect(mock.createdWindows).toEqual([{ url: 'https://example.com/private', focused: true }]);
    // The queued host is vault content, so it lives in `storage.session` and never on disk (INV-6).
    expect(mock.storage.session.snapshot()[HISTORY_QUEUE_KEY]).toEqual(['example.com']);
    expect(JSON.stringify(mock.storage.local.snapshot())).not.toContain('example.com');
  });

  it('drops the queued cleanup when the vault locks', async () => {
    await send({ type: 'OPEN_ITEM', id: itemId, force: true, clearHistoryAfter: true });
    await send({ type: 'LOCK' });
    expect(mock.storage.session.snapshot()[HISTORY_QUEUE_KEY]).toBe(undefined);
  });
});

describe('INV-6, over the whole Phase-5 journey', () => {
  it('leaves no title, URL or host in the clear in storage.local', async () => {
    mock.openTabs.push({
      id: 1,
      url: 'https://secret-host.invalid/very/private/page',
      title: 'A title nobody should be able to read',
      active: true,
    });
    mock.incognitoAccess = true;

    await send({ type: 'ADD_ACTIVE_TAB' });
    const [item] = await listItems();
    await send({ type: 'OPEN_ITEM', id: item!.id });
    await send({ type: 'DELETE_ITEMS', ids: [item!.id] });
    await send({ type: 'RESTORE_ITEMS', ids: [item!.id] });
    await send({ type: 'LOCK' });

    const stored = JSON.stringify(mock.storage.local.snapshot());
    for (const token of [
      'secret-host',
      'very/private',
      'A title nobody',
      'https://secret-host.invalid/very/private/page',
    ]) {
      expect(stored).not.toContain(token);
    }
    expect(JSON.stringify(mock.storage.session.snapshot())).toBe('{}');
  });
});
