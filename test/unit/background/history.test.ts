/**
 * History hygiene where it meets the vault (PLAN §9 Phase 9), driven through the real router.
 *
 * The two Definition-of-done claims are asserted here rather than reasoned about:
 *
 * - **"History cleanup shows an accurate dry-run and deletes only vaulted domains."** The dry run's
 *   count is compared against the number of `deleteUrl` calls the run makes, and the profile is
 *   seeded with sites that are *not* in the vault — including ones whose names contain a vaulted
 *   domain, because `history.search` is a substring match and would return them.
 * - **Optional-permission denial is handled gracefully.** With no grant the preview answers
 *   `granted: false` rather than throwing, and the run refuses with a code rather than deleting
 *   something it should not have been able to see.
 *
 * The vault is created once in `beforeAll` — PBKDF2 at 600,000 iterations is half a second — and
 * both storage areas are restored per test, which is what keeps it unlocked without a second
 * derivation (the worker rehydrates from the DEK exactly as it does after MV3 kills it).
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

/** The vault holds three sites. Everything else the profile has visited is somebody else's. */
const VAULTED: readonly (readonly [string, string])[] = [
  ['https://news.bbc.co.uk/weather', 'Weather'],
  ['https://alice.github.io/notes', 'Notes'],
  ['https://example.com/recipes', 'Recipes'],
];

beforeAll(async () => {
  mock = installChromeMock();
  await startWorker();
  await send({ type: 'CREATE_VAULT', password: PASSWORD });
  for (const [url, title] of VAULTED) await send({ type: 'ADD_URL', url, title });
  await vi.waitFor(async () => {
    const items = (await send({ type: 'LIST_ITEMS' }))['items'] as unknown[];
    expect(items).toHaveLength(VAULTED.length);
  });
  seededLocal = mock.storage.local.snapshot();
  seededSession = mock.storage.session.snapshot();
});

afterAll(() => {
  uninstallChromeMock();
});

beforeEach(async () => {
  uninstallChromeMock();
  mock = installChromeMock({ grantedPermissions: ['history'] });
  await mock.storage.local.set(structuredClone(seededLocal));
  await mock.storage.session.set(structuredClone(seededSession));
  await startWorker();
});

afterEach(() => {
  uninstallChromeMock();
});

/** A profile's browsing history: three vaulted sites, and four that are nothing to do with us. */
function seedHistory(): void {
  mock.historyEntries.push(
    { url: 'https://news.bbc.co.uk/weather' },
    { url: 'https://www.bbc.co.uk/sport' },
    { url: 'https://alice.github.io/notes' },
    { url: 'https://example.com/recipes' },
    { url: 'https://example.com/other-page' },
    // Not vaulted, and every one of these is something `search` returns for a vaulted domain.
    { url: 'https://bob.github.io/blog' },
    { url: 'https://notexample.community/hello' },
    { url: 'https://elsewhere.test/?ref=example.com' },
    { url: 'https://unrelated.test/', title: 'Cooking with example.com' },
  );
}

/** What the cleanup should touch, and nothing else. */
const IN_SCOPE = [
  'https://news.bbc.co.uk/weather',
  'https://www.bbc.co.uk/sport',
  'https://alice.github.io/notes',
  'https://example.com/recipes',
  'https://example.com/other-page',
];

function byDomain(a: { domain: string }, b: { domain: string }): number {
  return a.domain.localeCompare(b.domain);
}

describe('the dry run', () => {
  it('counts only vaulted domains, and searches for exactly those', async () => {
    seedHistory();
    const preview = await send({ type: 'PREVIEW_HISTORY_CLEANUP' });

    expect(preview['type']).toBe('HISTORY_PREVIEW');
    expect(preview['granted']).toBe(true);
    expect(preview['entries']).toBe(IN_SCOPE.length);
    expect(preview['searched']).toBe(3);
    // Sorted here rather than in the code: the order is whatever the vault yields, which is bucket
    // order, and pinning a test to that would be pinning it to the id hash.
    expect([...(preview['domains'] as { domain: string }[])].sort(byDomain)).toEqual([
      { domain: 'alice.github.io', entries: 1 },
      { domain: 'bbc.co.uk', entries: 2 },
      { domain: 'example.com', entries: 2 },
    ]);

    // The exact search list. A domain the vault does not hold must never be asked about, let alone
    // deleted — asking is already a question about somebody else's browsing.
    expect([...mock.historySearches].sort()).toEqual([
      'alice.github.io',
      'bbc.co.uk',
      'example.com',
    ]);
  });

  it('deletes nothing', async () => {
    seedHistory();
    await send({ type: 'PREVIEW_HISTORY_CLEANUP' });
    expect(mock.deletedHistory).toEqual([]);
    expect(mock.historyEntries).toHaveLength(9);
  });

  it('answers granted: false rather than throwing when the permission is absent', async () => {
    mock.grantedPermissions.delete('history');
    const preview = await send({ type: 'PREVIEW_HISTORY_CLEANUP' });

    expect(preview['type']).toBe('HISTORY_PREVIEW');
    expect(preview['granted']).toBe(false);
    expect(preview['entries']).toBe(0);
    expect(preview['domains']).toEqual([]);
  });

  it('needs an unlocked vault', async () => {
    await send({ type: 'LOCK' });
    expect(await send({ type: 'PREVIEW_HISTORY_CLEANUP' })).toEqual({
      type: 'ERROR',
      code: 'VAULT_LOCKED',
    });
  });
});

describe('running the cleanup', () => {
  it('removes exactly what the dry run promised, and nothing else', async () => {
    seedHistory();
    const preview = await send({ type: 'PREVIEW_HISTORY_CLEANUP' });
    const cleared = await send({ type: 'CLEAR_VAULTED_HISTORY' });

    expect(cleared).toEqual({ type: 'COUNT', count: preview['entries'] });
    expect([...mock.deletedHistory].sort()).toEqual([...IN_SCOPE].sort());
    expect(mock.historyEntries.map((entry) => entry.url).sort()).toEqual([
      'https://bob.github.io/blog',
      'https://elsewhere.test/?ref=example.com',
      'https://notexample.community/hello',
      'https://unrelated.test/',
    ]);
  });

  it('refuses without the permission, and deletes nothing', async () => {
    seedHistory();
    mock.grantedPermissions.delete('history');

    expect(await send({ type: 'CLEAR_VAULTED_HISTORY' })).toEqual({
      type: 'ERROR',
      code: 'HISTORY_PERMISSION',
    });
    expect(mock.historyEntries).toHaveLength(9);
  });

  it('does nothing when the vault holds nothing that has been visited', async () => {
    // No history seeded at all.
    expect(await send({ type: 'CLEAR_VAULTED_HISTORY' })).toEqual({ type: 'COUNT', count: 0 });
    expect(mock.deletedHistory).toEqual([]);
  });
});

describe('which bookmarks are still in history', () => {
  /** The ids of the seeded bookmarks, by URL — the answer is a list of ids and nothing else. */
  async function idsByUrl(): Promise<Map<string, string>> {
    const items = (await send({ type: 'LIST_ITEMS' }))['items'] as {
      id: string;
      url?: string;
    }[];
    return new Map(items.filter((item) => item.url !== undefined).map((item) => [item.url ?? '', item.id]));
  }

  async function presence(): Promise<Record<string, unknown>> {
    return await send({ type: 'HISTORY_PRESENCE' });
  }

  it('names the visited ones and no others', async () => {
    seedHistory();
    const ids = await idsByUrl();
    const answer = await presence();

    expect(answer['type']).toBe('HISTORY_PRESENCE');
    expect(answer['granted']).toBe(true);
    // All three seeded bookmarks have an entry for their own page.
    expect([...(answer['ids'] as string[])].sort()).toEqual([...ids.values()].sort());
  });

  it('is about the page, not the site', async () => {
    // One page of `example.com` is in history; the bookmark for another page of it is not.
    mock.historyEntries.push({ url: 'https://example.com/other-page' });
    const ids = await idsByUrl();
    const answer = await presence();

    expect(answer['ids']).toEqual([]);
    expect(ids.has('https://example.com/recipes')).toBe(true);
  });

  it('counts a visit whose address carries tracking parameters the vault stripped', async () => {
    // The default is to strip them, so the stored address and the visited one differ by exactly
    // this. A rule that compared the two strings would say this page had never been opened.
    mock.historyEntries.push({ url: 'https://example.com/recipes?utm_source=newsletter' });
    const ids = await idsByUrl();

    expect((await presence())['ids']).toEqual([ids.get('https://example.com/recipes')]);
  });

  it('does not confuse two pages that differ only in their query', async () => {
    await send({ type: 'ADD_URL', url: 'https://www.youtube.com/watch?v=first', title: 'First' });
    mock.historyEntries.push({ url: 'https://www.youtube.com/watch?v=second' });

    expect((await presence())['ids']).toEqual([]);
  });

  it('answers granted: false rather than throwing when the permission is absent', async () => {
    seedHistory();
    mock.grantedPermissions.delete('history');

    expect(await presence()).toEqual({ type: 'HISTORY_PRESENCE', granted: false, ids: [] });
    expect(mock.historySearches).toEqual([]);
  });

  it('needs an unlocked vault', async () => {
    await send({ type: 'LOCK' });
    expect(await presence()).toEqual({ type: 'ERROR', code: 'VAULT_LOCKED' });
  });
});

describe('forgetting one bookmark', () => {
  async function idOf(url: string): Promise<string> {
    const items = (await send({ type: 'LIST_ITEMS' }))['items'] as { id: string; url?: string }[];
    const found = items.find((item) => item.url === url);
    expect(found).toBeDefined();
    return found?.id ?? '';
  }

  it('deletes that page and leaves the rest of the site alone', async () => {
    seedHistory();
    const id = await idOf('https://example.com/recipes');

    expect(await send({ type: 'FORGET_ITEM_HISTORY', id })).toEqual({ type: 'COUNT', count: 1 });
    expect(mock.deletedHistory).toEqual(['https://example.com/recipes']);
    // The whole point of it being narrower than the cleanup: the other page of the same site, and
    // every other site, are exactly where they were.
    expect(mock.historyEntries.map((entry) => entry.url)).toContain('https://example.com/other-page');
    expect(mock.historyEntries).toHaveLength(8);
  });

  it('takes the other spellings of the same page with it', async () => {
    mock.historyEntries.push(
      { url: 'https://example.com/recipes' },
      { url: 'https://example.com/recipes?utm_campaign=spring' },
      { url: 'https://example.com/recipes/' },
      { url: 'https://example.com/recipes#method' },
      { url: 'https://example.com/recipes-archive' },
    );
    const id = await idOf('https://example.com/recipes');

    const answer = await send({ type: 'FORGET_ITEM_HISTORY', id });
    expect(answer).toEqual({ type: 'COUNT', count: 4 });
    // `recipes-archive` is a different page whose address happens to start with this one's.
    expect(mock.historyEntries.map((entry) => entry.url)).toEqual([
      'https://example.com/recipes-archive',
    ]);
  });

  it('searches only the domain of the bookmark it was asked about', async () => {
    seedHistory();
    await send({ type: 'FORGET_ITEM_HISTORY', id: await idOf('https://example.com/recipes') });
    expect(mock.historySearches).toEqual(['example.com']);
  });

  it('answers zero for a page that has never been visited', async () => {
    seedHistory();
    await send({ type: 'ADD_URL', url: 'https://example.com/unvisited', title: 'Unvisited' });

    expect(await send({ type: 'FORGET_ITEM_HISTORY', id: await idOf('https://example.com/unvisited') })).toEqual({
      type: 'COUNT',
      count: 0,
    });
    expect(mock.deletedHistory).toEqual([]);
  });

  it('refuses without the permission, and deletes nothing', async () => {
    seedHistory();
    const id = await idOf('https://example.com/recipes');
    mock.grantedPermissions.delete('history');

    expect(await send({ type: 'FORGET_ITEM_HISTORY', id })).toEqual({
      type: 'ERROR',
      code: 'HISTORY_PERMISSION',
    });
    expect(mock.deletedHistory).toEqual([]);
  });

  it('does nothing for an id the vault does not hold', async () => {
    seedHistory();
    expect(await send({ type: 'FORGET_ITEM_HISTORY', id: 'not-an-item' })).toEqual({
      type: 'COUNT',
      count: 0,
    });
    expect(mock.deletedHistory).toEqual([]);
  });
});

describe('on lock', () => {
  it('leaves history alone by default', async () => {
    seedHistory();
    await send({ type: 'LOCK' });
    expect(mock.deletedHistory).toEqual([]);
  });

  it('clears every vaulted domain when the setting is on', async () => {
    seedHistory();
    await send({ type: 'SET_SETTINGS', settings: { clearHistoryOnLock: true } });
    await send({ type: 'LOCK' });

    expect([...mock.deletedHistory].sort()).toEqual([...IN_SCOPE].sort());
  });

  it('does not run on a panic-lock — the key goes first', async () => {
    seedHistory();
    await send({ type: 'SET_SETTINGS', settings: { clearHistoryOnLock: true } });
    await send({ type: 'LOCK', panic: true });

    expect(mock.deletedHistory).toEqual([]);
  });

  it('drains the queue the incognito fallback left, whatever the setting says', async () => {
    seedHistory();
    // What `queueHistoryCleanup` writes when the user ticks "clear this domain's history
    // afterwards" in the guided prompt. That tick is a promise about specific pages, so it is kept
    // even though `clearHistoryOnLock` is off.
    await mock.storage.session.set({ 'vm.historyQueue': ['www.bbc.co.uk'] });
    await send({ type: 'LOCK' });

    expect([...mock.deletedHistory].sort()).toEqual([
      'https://news.bbc.co.uk/weather',
      'https://www.bbc.co.uk/sport',
    ]);
  });

  it('does not fail the lock when history deletion is impossible', async () => {
    seedHistory();
    mock.grantedPermissions.delete('history');
    await send({ type: 'SET_SETTINGS', settings: { clearHistoryOnLock: true } });
    await mock.storage.session.set({ 'vm.historyQueue': ['www.bbc.co.uk'] });

    expect(await send({ type: 'LOCK' })).toEqual({ type: 'OK' });
    expect((await send({ type: 'GET_STATE' }))['locked']).toBe(true);
  });
});

describe('quick-close', () => {
  function openTab(url: string): void {
    mock.openTabs.push({ id: 7, url, active: true });
  }

  it('does nothing at all while the setting is off', async () => {
    seedHistory();
    openTab('https://example.com/recipes');
    mock.triggerCommand('quick-close');
    await vi.waitFor(() => {
      expect(mock.deletedHistory).toEqual([]);
    });
    expect(mock.removedTabs).toEqual([]);
  });

  it('closes the tab and clears that site once enabled', async () => {
    seedHistory();
    await send({ type: 'SET_SETTINGS', settings: { quickClose: true } });
    openTab('https://example.com/recipes');

    mock.triggerCommand('quick-close');
    await vi.waitFor(() => {
      expect(mock.removedTabs).toEqual([7]);
    });

    expect([...mock.deletedHistory].sort()).toEqual([
      'https://example.com/other-page',
      'https://example.com/recipes',
    ]);
    // Deliberately domain-wide and deliberately not limited to the vault — see §12.3. Nothing
    // outside the domain is touched.
    expect(mock.historyEntries.map((entry) => entry.url)).toContain('https://bob.github.io/blog');
  });

  it('works on a site that is not in the vault at all', async () => {
    seedHistory();
    await send({ type: 'SET_SETTINGS', settings: { quickClose: true } });
    openTab('https://bob.github.io/blog');

    mock.triggerCommand('quick-close');
    await vi.waitFor(() => {
      expect(mock.removedTabs).toEqual([7]);
    });
    expect(mock.deletedHistory).toEqual(['https://bob.github.io/blog']);
  });

  it('leaves the tab open when the permission is missing', async () => {
    seedHistory();
    await send({ type: 'SET_SETTINGS', settings: { quickClose: true } });
    mock.grantedPermissions.delete('history');
    openTab('https://example.com/recipes');

    mock.triggerCommand('quick-close');
    await vi.waitFor(() => {
      expect(mock.badgeText()).not.toBe('');
    });
    expect(mock.removedTabs).toEqual([]);
    expect(mock.deletedHistory).toEqual([]);
  });

  it('works while the vault is locked — it is about the browser, not the vault', async () => {
    seedHistory();
    await send({ type: 'SET_SETTINGS', settings: { quickClose: true } });
    await send({ type: 'LOCK' });
    openTab('https://example.com/recipes');

    mock.triggerCommand('quick-close');
    await vi.waitFor(() => {
      expect(mock.removedTabs).toEqual([7]);
    });
  });
});
