/**
 * Importing from Chrome's own bookmarks.
 *
 * The assertion this file exists for is the last one: **`chrome.bookmarks` is only ever read**
 * (INV-5). An import that quietly deleted the originals would be a better demo and a much worse
 * product — the deletion is what removes a URL from the omnibox, it cannot be undone by us, and it
 * is therefore a second decision with a second button.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BookmarksPermissionError,
  deleteNative,
  dropBookmarksPermission,
  expandSelection,
  flattenTree,
  hasBookmarksPermission,
  importNative,
  readNativeTree,
  requestBookmarksPermission,
  type NativeNode,
} from '../../../src/import/native-bookmarks.js';
import type { Bytes } from '../../../src/crypto/codec.js';
import { VaultRepository } from '../../../src/storage/repo.js';
import { ROOT_ID, isBookmark, type VaultItem } from '../../../src/vault/types.js';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
  type MockBookmarkNode,
  type StorageSnapshot,
} from '../../mocks/chrome.js';

const PASSWORD = 'correct horse battery staple';

let mock: ChromeMock;
let seeded: StorageSnapshot | null = null;
let dek: Bytes;

/** Chrome's shape: an unnamed root holding the bar and "Other bookmarks". */
const TREE: MockBookmarkNode[] = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: 'Bookmarks bar',
        children: [
          { id: '10', title: 'Example', url: 'https://example.com/' },
          {
            id: '11',
            title: 'Work',
            children: [
              { id: '110', title: 'Spec', url: 'https://example.com/spec' },
              { id: '111', title: 'Script', url: 'javascript:alert(1)' },
            ],
          },
        ],
      },
      {
        id: '2',
        title: 'Other bookmarks',
        children: [{ id: '20', title: '', url: 'https://elsewhere.test/' }],
      },
    ],
  },
];

/**
 * An unlocked repository, opened from the data key rather than from the password.
 *
 * `unlockWithDek` is the path a restarted service worker takes (ARCHITECTURE §7.1), so it is not a
 * test-only shortcut — and it keeps a dozen 600,000-iteration derivations out of a suite that runs
 * in parallel with a wall-clock cold-start budget.
 */
async function repository(): Promise<VaultRepository> {
  const repo = new VaultRepository({ coalesceMs: 60_000 });
  await repo.unlockWithDek(dek);
  return repo;
}

beforeEach(async () => {
  mock = installChromeMock({ grantedPermissions: ['bookmarks'] });
  if (seeded === null) {
    const repo = new VaultRepository({ coalesceMs: 60_000 });
    await repo.create(PASSWORD);
    await repo.flush();
    seeded = mock.storage.local.snapshot();
    dek = repo.exportDek();
  } else {
    await mock.storage.local.set(structuredClone(seeded));
  }
  mock.bookmarkRoots.splice(0, mock.bookmarkRoots.length, ...structuredClone(TREE));
}, 30_000);

afterEach(() => {
  uninstallChromeMock();
});

describe('the permission', () => {
  it('reports whether it has been granted', async () => {
    await expect(hasBookmarksPermission()).resolves.toBe(true);
    await dropBookmarksPermission();
    await expect(hasBookmarksPermission()).resolves.toBe(false);
  });

  it('can be asked for, and the namespace appears with it', async () => {
    await dropBookmarksPermission();
    await expect(readNativeTree()).rejects.toThrow(BookmarksPermissionError);
    await expect(requestBookmarksPermission()).resolves.toBe(true);
    await expect(readNativeTree()).resolves.toHaveLength(2);
  });

  it('refuses to delete without it', async () => {
    await dropBookmarksPermission();
    await expect(deleteNative(['10'])).rejects.toThrow(BookmarksPermissionError);
  });
});

describe('readNativeTree', () => {
  it('drops Chrome unnamed root and promotes the folders a person recognises', async () => {
    const roots = await readNativeTree();
    expect(roots.map((node) => node.title)).toEqual(['Bookmarks bar', 'Other bookmarks']);
  });

  it('keeps urls on leaves and children on folders', async () => {
    const [bar] = await readNativeTree();
    expect(bar?.children?.[0]).toMatchObject({ id: '10', url: 'https://example.com/' });
    expect(bar?.children?.[1]?.url).toBeUndefined();
  });
});

describe('expandSelection', () => {
  let tree: NativeNode[];

  beforeEach(async () => {
    tree = await readNativeTree();
  });

  it('takes everything inside a checked folder', () => {
    expect([...expandSelection(tree, ['11'])].sort()).toEqual(['1', '11', '110', '111']);
  });

  it('takes the ancestors of a checked bookmark, so its filing survives', () => {
    expect([...expandSelection(tree, ['110'])].sort()).toEqual(['1', '11', '110']);
  });

  it('ignores ids that are not in the tree', () => {
    expect([...expandSelection(tree, ['nope'])]).toEqual([]);
  });

  it('is idempotent', () => {
    const once = expandSelection(tree, ['11']);
    expect([...expandSelection(tree, once)].sort()).toEqual([...once].sort());
  });
});

describe('flattenTree', () => {
  it('walks parents before children', async () => {
    const ids = flattenTree(await readNativeTree()).map((node) => node.id);
    expect(ids).toEqual(['1', '10', '11', '110', '111', '2', '20']);
  });
});

describe('importNative', () => {
  it('preserves the folder structure', async () => {
    const repo = await repository();
    const tree = await readNativeTree();
    const result = await importNative(repo, tree, ['1']);

    expect(result).toEqual({ bookmarks: 2, folders: 2, duplicates: 0, skipped: 1 });

    const items = [...repo.items().values()];
    const bar = items.find((item) => item.title === 'Bookmarks bar');
    const work = items.find((item) => item.title === 'Work');
    const spec = items.find((item) => item.title === 'Spec');
    expect(bar?.parentId).toBe(ROOT_ID);
    expect(work?.parentId).toBe(bar?.id);
    expect(spec?.parentId).toBe(work?.id);
  }, 30_000);

  it('refuses a URL the add pipeline would refuse, and says how many', async () => {
    const repo = await repository();
    const result = await importNative(repo, await readNativeTree(), ['111']);
    expect(result.skipped).toBe(1);
    expect(urlsIn(repo)).not.toContain('javascript:alert(1)');
  }, 30_000);

  it('skips a page the vault already holds', async () => {
    const repo = await repository();
    const tree = await readNativeTree();
    await importNative(repo, tree, ['10']);
    const again = await importNative(repo, tree, ['10']);
    expect(again).toMatchObject({ bookmarks: 0, duplicates: 1 });
  }, 30_000);

  it('reuses the folders it already made, so a repeated import adds nothing', async () => {
    const repo = await repository();
    const tree = await readNativeTree();
    await importNative(repo, tree, ['1']);
    const before = repo.header().vaultRev;

    const again = await importNative(repo, tree, ['1']);

    // Every bookmark is a duplicate and every folder is one the vault already has in that place, so
    // the second run has nothing to write at all. It used to create a second, empty "Bookmarks bar"
    // and a second, empty "Work" beside the first pair — the bookmarks inside them having been
    // recognised as duplicates and filed nowhere.
    expect(again).toEqual({ bookmarks: 0, folders: 0, duplicates: 2, skipped: 1 });
    expect(titlesIn(repo).filter((title) => title === 'Work')).toHaveLength(1);
    expect(titlesIn(repo).filter((title) => title === 'Bookmarks bar')).toHaveLength(1);
    expect(repo.header().vaultRev).toBe(before);
  }, 30_000);

  it('adds what is new to the folder that is already there', async () => {
    const repo = await repository();
    await importNative(repo, await readNativeTree(), ['1']);

    mock.bookmarkRoots[0]?.children?.[0]?.children?.[1]?.children?.push({
      id: '112',
      title: 'Notes',
      url: 'https://example.com/notes',
    });
    const result = await importNative(repo, await readNativeTree(), ['1']);

    expect(result).toMatchObject({ bookmarks: 1, folders: 0 });
    const items = [...repo.items().values()];
    const work = items.find((item) => item.title === 'Work');
    expect(items.find((item) => item.title === 'Notes')?.parentId).toBe(work?.id);
  }, 30_000);

  it('matches a folder by its place, not by its name alone', async () => {
    // Two folders called "Work" under two different parents are two folders. Collapsing them would
    // move somebody's bookmarks, which is the failure the naive fix makes.
    mock.bookmarkRoots[0]?.children?.[1]?.children?.push({
      id: '22',
      title: 'Work',
      children: [{ id: '220', title: 'Elsewhere', url: 'https://elsewhere.test/work' }],
    });
    const repo = await repository();
    await importNative(repo, await readNativeTree(), ['1', '2']);

    const items = [...repo.items().values()];
    const works = items.filter((item) => item.title === 'Work');
    expect(works).toHaveLength(2);
    expect(new Set(works.map((item) => item.parentId)).size).toBe(2);
  }, 30_000);

  it('imports the same page twice in one tree only once', async () => {
    mock.bookmarkRoots[0]?.children?.[1]?.children?.push({
      id: '21',
      title: 'Example again',
      url: 'https://example.com/?utm_source=news',
    });
    const repo = await repository();
    const result = await importNative(repo, await readNativeTree(), ['1', '2'], {
      stripTrackingParams: true,
    });
    // The second copy differs only in a campaign parameter, which the strip removes — so the two
    // collapse to one page, and one of them is reported as a duplicate rather than stored twice.
    expect(result.duplicates).toBe(1);
  }, 30_000);

  it('files the import inside a folder when asked', async () => {
    const repo = await repository();
    const [created] = await repo.apply([{ kind: 'add', input: { type: 'folder', title: 'Inbox' } }]);
    await importNative(repo, await readNativeTree(), ['10'], { parentId: created?.id ?? ROOT_ID });

    // The whole selected subtree lands inside Inbox — including the "Bookmarks bar" folder the
    // selection was expanded upward to, which is what keeps the bookmark's filing intact.
    const items = repo.items();
    const bar = [...items.values()].find((item) => item.title === 'Bookmarks bar');
    const imported = [...items.values()].find((item) => item.title === 'Example');
    expect(bar?.parentId).toBe(created?.id);
    expect(imported?.parentId).toBe(bar?.id);
  }, 30_000);

  it('writes nothing when the selection is empty', async () => {
    const repo = await repository();
    const before = repo.header().vaultRev;
    const result = await importNative(repo, await readNativeTree(), []);
    expect(result).toEqual({ bookmarks: 0, folders: 0, duplicates: 0, skipped: 0 });
    expect(repo.header().vaultRev).toBe(before);
  }, 30_000);

  it('commits the whole tree as one revision', async () => {
    const repo = await repository();
    const before = repo.header().vaultRev;
    await importNative(repo, await readNativeTree(), ['1', '2']);
    // One revision for the whole import: that is what makes it atomic, and one thing for the merge
    // engine to carry rather than one per bookmark.
    expect(repo.header().vaultRev).toBe(before + 1);
  }, 30_000);

  it('reports progress', async () => {
    const many: MockBookmarkNode = {
      id: 'big',
      title: 'Big',
      children: Array.from({ length: 250 }, (_unused, index) => ({
        id: `big-${String(index)}`,
        title: `Item ${String(index)}`,
        url: `https://example.com/${String(index)}`,
      })),
    };
    mock.bookmarkRoots[0]?.children?.push(many);

    const repo = await repository();
    const seen: number[] = [];
    await importNative(repo, await readNativeTree(), ['big'], {
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toContain(100);
    expect(seen.at(-1)).toBe(251);
  }, 60_000);

  it('never writes to chrome.bookmarks (INV-5)', async () => {
    const repo = await repository();
    await importNative(repo, await readNativeTree(), ['1', '2']);
    expect(mock.removedBookmarks).toEqual([]);
  }, 30_000);
});

describe('deleteNative', () => {
  it('removes exactly the ids it is given, and nothing else', async () => {
    await deleteNative(['10', '110']);
    expect(mock.removedBookmarks).toEqual(['10', '110']);
  });

  it('counts what Chrome refused rather than abandoning the rest', async () => {
    // Chrome will not delete its permanent folders. One refusal in the middle of four hundred
    // deletions must not stop the other three hundred and ninety-nine.
    const result = await deleteNative(['10', '1', '110']);
    expect(result).toEqual({ removed: 2, failed: 1 });
    expect(mock.removedBookmarks).toEqual(['10', '110']);
  });
});

function titlesIn(repo: VaultRepository): string[] {
  return repo.getAll().map((item: VaultItem) => item.title);
}

function urlsIn(repo: VaultRepository): string[] {
  return repo
    .getAll()
    .filter((item: VaultItem) => isBookmark(item))
    .map((item) => item.url);
}
