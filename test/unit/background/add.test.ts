/**
 * The add pipeline: what VaultaMark will and will not store, and what it does to a URL on the way
 * in (ARCHITECTURE §3.5, PLAN Phase 5).
 *
 * The scheme table is the part that matters most. Everything it lets through is something a user
 * will later click in the popup and expect to open in an incognito window; everything that gets
 * past it and cannot be reopened is a dead entry the user only finds out about later.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NoActiveTabError,
  activeTab,
  addActiveTab,
  addUrl,
  findDuplicate,
  summarize,
  titleFor,
  vaultableUrl,
  withoutTrackingParams,
} from '../../../src/background/add.js';
import { VaultRepository } from '../../../src/storage/repo.js';
import { UnsupportedUrlError } from '../../../src/vault/errors.js';
import { isBookmark, type Bookmark } from '../../../src/vault/types.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

const PASSWORD = 'a reasonably long master password';

let mock: ChromeMock;

async function unlockedVault(): Promise<VaultRepository> {
  const repo = new VaultRepository({ coalesceMs: 0 });
  await repo.create(PASSWORD);
  return repo;
}

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('vaultableUrl', () => {
  it('keeps the query and the fragment — people bookmark anchors', () => {
    expect(vaultableUrl('https://example.com/docs?page=3#install')).toBe(
      'https://example.com/docs?page=3#install',
    );
  });

  it('lowercases the scheme and host and drops the default port', () => {
    expect(vaultableUrl('HTTPS://Example.COM:443/Path')).toBe('https://example.com/Path');
  });

  it('adds the trailing slash a bare origin has, because that is what the URL is', () => {
    expect(vaultableUrl('https://example.com')).toBe('https://example.com/');
  });

  it('trims whatever whitespace the tab or the clipboard brought along', () => {
    expect(vaultableUrl('  https://example.com/x  ')).toBe('https://example.com/x');
  });

  it.each([
    ['chrome://extensions/', 'internal-page'],
    ['chrome-extension://abcdef/popup.html', 'internal-page'],
    ['about:blank', 'internal-page'],
    ['devtools://devtools/bundled/inspector.html', 'internal-page'],
    ['view-source:https://example.com/', 'internal-page'],
    ['file:///C:/Users/someone/notes.txt', 'local-file'],
    ['javascript:alert(1)', 'unsupported-scheme'],
    ['data:text/html,<h1>hi</h1>', 'unsupported-scheme'],
    ['blob:https://example.com/1234', 'unsupported-scheme'],
    ['mailto:someone@example.com', 'unsupported-scheme'],
    ['not a url at all', 'unsupported-scheme'],
    ['', 'unsupported-scheme'],
  ])('refuses %s with reason %s', (url, reason) => {
    expect(() => vaultableUrl(url)).toThrow(UnsupportedUrlError);
    try {
      vaultableUrl(url);
    } catch (error) {
      expect((error as UnsupportedUrlError).reason).toBe(reason);
    }
  });

  it('leaves tracking parameters alone by default (§3.5)', () => {
    const url = 'https://example.com/a?utm_source=news&id=7';
    expect(vaultableUrl(url)).toBe(url);
  });

  it('strips them when the setting is on, and keeps everything else', () => {
    expect(
      vaultableUrl('https://example.com/a?utm_source=news&id=7&fbclid=abc', {
        stripTrackingParams: true,
      }),
    ).toBe('https://example.com/a?id=7');
  });

  it('drops the "?" with the last tracking parameter rather than leaving a bare one', () => {
    expect(
      vaultableUrl('https://example.com/a?utm_source=news', { stripTrackingParams: true }),
    ).toBe('https://example.com/a');
  });
});

describe('withoutTrackingParams', () => {
  it('touches nothing that is not a campaign parameter', () => {
    const url = 'https://example.com/search?q=utm_source&page=2';
    expect(withoutTrackingParams(url)).toBe(url);
  });
});

describe('titleFor', () => {
  it('prefers the page title, trimmed', () => {
    expect(titleFor('https://example.com/', '  Example Domain  ')).toBe('Example Domain');
  });

  it('falls back to the host, not the whole URL — a row is 20 rem wide', () => {
    expect(titleFor('https://example.com/a/b/c?d=e', undefined)).toBe('example.com');
    expect(titleFor('https://example.com/a', '   ')).toBe('example.com');
  });
});

describe('findDuplicate', () => {
  const bookmark = (id: string, url: string): Bookmark => ({
    id,
    parentId: 'root',
    type: 'bookmark',
    title: id,
    url,
    createdAt: 0,
    updatedAt: 0,
    order: 'a0',
    rev: 1,
  });

  it('matches the same page across a fragment and a reordered query', () => {
    const items = [bookmark('one', 'https://example.com/a?b=1&a=2')];
    expect(findDuplicate(items, 'https://example.com/a?a=2&b=1#section')?.id).toBe('one');
  });

  it('does not match a different path', () => {
    expect(findDuplicate([bookmark('one', 'https://example.com/a')], 'https://example.com/b')).toBe(
      undefined,
    );
  });

  it('ignores tombstones — a deleted bookmark is not "already vaulted"', () => {
    const deleted = { ...bookmark('one', 'https://example.com/a'), deleted: true as const };
    expect(findDuplicate([deleted], 'https://example.com/a')).toBe(undefined);
  });
});

describe('addUrl', () => {
  it('adds a bookmark and writes it through immediately', async () => {
    const repo = await unlockedVault();
    const result = await addUrl(repo, { url: 'https://example.com/x', title: 'Example' });

    expect(result.status).toBe('added');
    expect(result.item.title).toBe('Example');
    expect(result.item.url).toBe('https://example.com/x');
    // The service worker can be torn down 300 ms from now; an add the user watched succeed has to
    // have reached storage before this resolved.
    expect(repo.dirtyBuckets().size).toBe(0);
    expect(Object.keys(mock.storage.local.snapshot()).some((key) => key.startsWith('vm.buckets.')))
      .toBe(true);
  });

  it('answers with the existing item instead of adding a second one', async () => {
    const repo = await unlockedVault();
    const first = await addUrl(repo, { url: 'https://example.com/x', title: 'Example' });
    const second = await addUrl(repo, { url: 'https://example.com/x?#anchor', title: 'Again' });

    expect(second.status).toBe('duplicate');
    expect(second.item.id).toBe(first.item.id);
    expect(repo.getAll().filter(isBookmark)).toHaveLength(1);
  });

  it('refuses a browser page without touching the vault', async () => {
    const repo = await unlockedVault();
    await expect(addUrl(repo, { url: 'chrome://settings' })).rejects.toThrow(UnsupportedUrlError);
    expect(repo.getAll()).toHaveLength(0);
  });
});

describe('activeTab', () => {
  it('reads the active tab', async () => {
    mock.openTabs.push({ id: 1, url: 'https://example.com/', title: 'Example', active: true });
    mock.openTabs.push({ id: 2, url: 'https://other.example/', active: false });
    expect(await activeTab()).toEqual({ url: 'https://example.com/', title: 'Example' });
  });

  it('throws when there is no tab at all', async () => {
    await expect(activeTab()).rejects.toThrow(NoActiveTabError);
  });

  it('throws when activeTab did not grant the URL — Chrome reports it as absent', async () => {
    mock.openTabs.push({ id: 1, title: 'Something', active: true });
    await expect(activeTab()).rejects.toThrow(NoActiveTabError);
  });
});

describe('addActiveTab', () => {
  it('vaults whatever the active tab is showing', async () => {
    const repo = await unlockedVault();
    mock.openTabs.push({ id: 1, url: 'https://example.com/read', title: 'Read me', active: true });

    const result = await addActiveTab(repo);
    expect(result.status).toBe('added');
    expect(repo.getAll().filter(isBookmark).map((item) => item.url)).toEqual([
      'https://example.com/read',
    ]);
  });
});

describe('summarize', () => {
  /*
   * A closed list, checked by name. `hasPreview` is on it and the words behind it are not: the popup
   * draws an eye from a boolean and asks `GET_THUMB` for the card only when one is opened — the same
   * split as `ListRow.hasNote`. Anything else appearing here should fail this test and be argued for
   * rather than noticed later.
   */
  it('carries no note, tags, OG text or thumbnail onto the wire', async () => {
    const repo = await unlockedVault();
    const [added] = await repo.apply([
      {
        kind: 'add',
        input: {
          type: 'bookmark',
          url: 'https://example.com/',
          title: 'Example',
          tags: ['private'],
          note: 'a secret note',
        },
      },
    ]);
    expect(added !== undefined && isBookmark(added)).toBe(true);

    expect(Object.keys(summarize(added as Bookmark)).sort()).toEqual([
      'createdAt',
      'hasPreview',
      'id',
      'title',
      'url',
    ]);
  });

  it('reports a preview from the page’s words alone, not only from a picture', async () => {
    const repo = await unlockedVault();
    const [plain] = await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.com/a', title: 'A' } },
    ]);
    expect(summarize(plain as Bookmark).hasPreview).toBe(false);

    const [worded] = await repo.apply([
      { kind: 'update', id: (plain as Bookmark).id, patch: { og: { title: 'What the page says' } } },
    ]);
    expect(summarize(worded as Bookmark).hasPreview).toBe(true);
  });
});
