/**
 * Import and export as the service worker exposes them.
 *
 * The formats themselves are tested in `test/unit/io/**` and the round trip in
 * `test/integration/portable-vault.test.ts`. What is asserted here is everything the worker adds:
 * the lock check on every path, the password verification in front of a "use my vault password"
 * export, the progress broadcasts, and the fact that reading Chrome's bookmarks and deleting them
 * are two different messages (INV-5).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { VaultRepository } from '../../../src/storage/repo.js';
import { ROOT_ID } from '../../../src/vault/types.js';
import { parseVmv } from '../../../src/io/import-encrypted.js';
import { exportVault, serializeVmv } from '../../../src/io/export-encrypted.js';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
  type MockBookmarkNode,
  type StorageSnapshot,
} from '../../mocks/chrome.js';

const PASSWORD = 'correct horse battery staple';

type WorkerModule = typeof import('../../../src/background/index.js');

let mock: ChromeMock;
let seeded: StorageSnapshot;
/**
 * The unlocked session, captured once.
 *
 * Restoring it is what `session.ts` does after every worker restart: the DEK is in
 * `chrome.storage.session`, so the worker rehydrates from it without a KDF. Unlocking properly in
 * each of these tests would run PBKDF2 at 600,000 iterations seventeen times, which is CPU the
 * whole suite is sharing — and the cold-start budget in `message-router.test.ts` is measured in
 * milliseconds of wall clock on the same machine.
 */
let unlocked: StorageSnapshot;

const TREE: MockBookmarkNode[] = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: 'Bookmarks bar',
        children: [{ id: '10', title: 'Imported', url: 'https://imported.test/' }],
      },
    ],
  },
];

async function startWorker(): Promise<WorkerModule> {
  vi.resetModules();
  return await import('../../../src/background/index.js');
}

/** Open the vault by restoring the captured session, not by deriving the key again. */
async function unlock(): Promise<void> {
  await mock.storage.session.set(structuredClone(unlocked));
}

beforeAll(async () => {
  mock = installChromeMock();
  const repo = new VaultRepository({ coalesceMs: 0 });
  await repo.create(PASSWORD);
  await repo.apply([
    {
      kind: 'add',
      input: { type: 'bookmark', parentId: ROOT_ID, title: 'Seed', url: 'https://a.invalid/' },
    },
  ]);
  await repo.flush();
  seeded = structuredClone(mock.storage.local.snapshot());

  // One real unlock, through the worker, so the session record is exactly what production writes.
  await startWorker();
  await mock.sendMessage({ type: 'UNLOCK', password: PASSWORD });
  unlocked = structuredClone(mock.storage.session.snapshot());
  uninstallChromeMock();
}, 60_000);

beforeEach(async () => {
  mock = installChromeMock({ manifestVersion: '1.2.3', grantedPermissions: ['bookmarks'] });
  mock.bookmarkRoots.splice(0, mock.bookmarkRoots.length, ...structuredClone(TREE));
  await mock.storage.local.set(structuredClone(seeded));
  await startWorker();
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallChromeMock();
});

describe('exporting', () => {
  it('refuses every path while the vault is locked', async () => {
    for (const message of [
      { type: 'EXPORT_VAULT', password: PASSWORD, mode: 'vault' },
      { type: 'EXPORT_HTML' },
      { type: 'PREVIEW_IMPORT', file: '{}', password: PASSWORD },
      { type: 'IMPORT_VAULT', file: '{}', password: PASSWORD, mode: 'merge' },
      { type: 'GET_ROLLBACK' },
      { type: 'ROLLBACK_IMPORT' },
      { type: 'NATIVE_TREE' },
      { type: 'IMPORT_NATIVE', ids: ['1'] },
      { type: 'DELETE_NATIVE', ids: ['10'] },
    ]) {
      await expect(mock.sendMessage(message)).resolves.toEqual({
        type: 'ERROR',
        code: 'VAULT_LOCKED',
      });
    }
  });

  it('produces a named, parseable .vmv', async () => {
    await unlock();
    const response = (await mock.sendMessage({
      type: 'EXPORT_VAULT',
      password: PASSWORD,
      mode: 'vault',
    })) as { type: string; filename: string; mime: string; text: string };

    expect(response.type).toBe('FILE');
    expect(response.filename).toMatch(/^vaultamark-\d{4}-\d{2}-\d{2}\.vmv$/u);
    expect(response.mime).toBe('application/octet-stream');
    expect(parseVmv(response.text).createdBy).toBe('VaultaMark 1.2.3');
  }, 60_000);

  it('refuses to seal a backup under a password that is not the vault (mode: vault)', async () => {
    // The worker holds the data key, not the password, so nothing else could catch this — and a
    // backup sealed under a typo is discovered on the day it is needed.
    await unlock();
    await expect(
      mock.sendMessage({ type: 'EXPORT_VAULT', password: 'not it', mode: 'vault' }),
    ).resolves.toEqual({ type: 'ERROR', code: 'WRONG_PASSWORD' });
  }, 60_000);

  it('accepts any password when the file gets one of its own (mode: custom)', async () => {
    await unlock();
    const response = (await mock.sendMessage({
      type: 'EXPORT_VAULT',
      password: 'a password of the files own',
      mode: 'custom',
    })) as { type: string };
    expect(response.type).toBe('FILE');
  }, 60_000);

  it('produces the plain HTML file with its warning comment', async () => {
    await unlock();
    const response = (await mock.sendMessage({ type: 'EXPORT_HTML' })) as {
      type: string;
      filename: string;
      mime: string;
      text: string;
    };
    expect(response.type).toBe('FILE');
    expect(response.mime).toBe('text/html');
    expect(response.filename.endsWith('.html')).toBe(true);
    expect(response.text).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    // The mock's `i18n` answers with the key, which is how we can tell the warning was localized
    // rather than falling back to the built-in English.
    expect(response.text).toContain('htmlExportWarning1');
  }, 30_000);

  it('falls back to the built-in warning when the locale has no string', async () => {
    await unlock();
    vi.spyOn(chrome.i18n, 'getMessage').mockReturnValue('');
    const response = (await mock.sendMessage({ type: 'EXPORT_HTML' })) as { text: string };
    expect(response.text).toContain('WARNING');
  }, 30_000);

  it('broadcasts progress while it works', async () => {
    await unlock();
    const seen = mock.observeMessages();
    await mock.sendMessage({ type: 'EXPORT_VAULT', password: PASSWORD, mode: 'vault' });
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'IO_PROGRESS', job: 'export' }),
    );
  }, 60_000);
});

describe('importing', () => {
  /**
   * Backup files, built once each.
   *
   * Every `exportVault` is a 600,000-iteration derivation, and most of these tests want *a* file
   * rather than a particular one. The empty backup is the one four of them share.
   */
  const files = new Map<string, Promise<string>>();

  function backup(key: string, items: Parameters<typeof exportVault>[0]): Promise<string> {
    const existing = files.get(key);
    if (existing !== undefined) return existing;
    const built = exportVault(items, PASSWORD, { version: '1.0.0' }).then(serializeVmv);
    files.set(key, built);
    return built;
  }

  it('previews without writing anything', async () => {
    await unlock();
    const before = (await mock.sendMessage({ type: 'GET_TREE' })) as { total: number };
    const file = await backup('empty', []);

    const preview = (await mock.sendMessage({
      type: 'PREVIEW_IMPORT',
      file,
      password: PASSWORD,
    })) as { type: string; bookmarks: number };
    expect(preview.type).toBe('IMPORT_PREVIEW');
    expect(preview.bookmarks).toBe(0);

    const after = (await mock.sendMessage({ type: 'GET_TREE' })) as { total: number };
    expect(after.total).toBe(before.total);
  }, 60_000);

  it('reports a wrong password rather than a corrupt file', async () => {
    await unlock();
    const file = await backup('empty', []);
    await expect(
      mock.sendMessage({ type: 'PREVIEW_IMPORT', file, password: 'wrong' }),
    ).resolves.toEqual({ type: 'ERROR', code: 'WRONG_PASSWORD' });
  }, 60_000);

  it('reports an unreadable file as corrupt', async () => {
    await unlock();
    await expect(
      mock.sendMessage({ type: 'PREVIEW_IMPORT', file: 'not a backup', password: PASSWORD }),
    ).resolves.toEqual({ type: 'ERROR', code: 'CORRUPT_VAULT' });
  }, 30_000);

  it('applies a merge and tells open pages the vault changed', async () => {
    await unlock();
    const file = await backup('one-item', [
      {
        id: 'from-the-file',
        type: 'bookmark',
        parentId: ROOT_ID,
        title: 'From the file',
        url: 'https://file.test/',
        createdAt: 1,
        updatedAt: 1,
        order: 'a1',
        rev: 1,
      },
    ]);

    const seen = mock.observeMessages();
    const result = (await mock.sendMessage({
      type: 'IMPORT_VAULT',
      file,
      password: PASSWORD,
      mode: 'merge',
    })) as { type: string; added: number; mode: string };

    expect(result).toMatchObject({ type: 'IMPORT_RESULT', mode: 'merge', added: 1 });
    expect(seen).toContainEqual({ type: 'VAULT_CHANGED' });
  }, 60_000);

  it('offers an undo after a replace, and spends it', async () => {
    await unlock();
    const file = await backup('empty', []);

    await expect(mock.sendMessage({ type: 'GET_ROLLBACK' })).resolves.toEqual({
      type: 'ROLLBACK',
      available: false,
      createdAt: null,
      expiresAt: null,
    });

    await mock.sendMessage({ type: 'IMPORT_VAULT', file, password: PASSWORD, mode: 'replace' });
    const offer = (await mock.sendMessage({ type: 'GET_ROLLBACK' })) as { available: boolean };
    expect(offer.available).toBe(true);

    const undone = (await mock.sendMessage({ type: 'ROLLBACK_IMPORT' })) as {
      type: string;
      count: number;
    };
    expect(undone.type).toBe('COUNT');
    expect(undone.count).toBeGreaterThan(0);
    await expect(mock.sendMessage({ type: 'GET_ROLLBACK' })).resolves.toMatchObject({
      available: false,
    });
  }, 60_000);
});

describe('native bookmarks', () => {
  it('answers with the tree when the permission is granted', async () => {
    await unlock();
    const response = (await mock.sendMessage({ type: 'NATIVE_TREE' })) as {
      type: string;
      granted: boolean;
      nodes: { title: string; children?: unknown[] }[];
    };
    expect(response.type).toBe('NATIVE_TREE_STATE');
    expect(response.granted).toBe(true);
    expect(response.nodes[0]?.title).toBe('Bookmarks bar');
  }, 30_000);

  it('says so, rather than failing, when the permission is not granted', async () => {
    await unlock();
    mock.grantedPermissions.delete('bookmarks');
    await expect(mock.sendMessage({ type: 'NATIVE_TREE' })).resolves.toEqual({
      type: 'NATIVE_TREE_STATE',
      granted: false,
      nodes: [],
    });
  }, 30_000);

  it('imports a selection and leaves Chrome alone (INV-5)', async () => {
    await unlock();
    const result = (await mock.sendMessage({ type: 'IMPORT_NATIVE', ids: ['10'] })) as {
      type: string;
      bookmarks: number;
      folders: number;
    };
    expect(result).toMatchObject({ type: 'NATIVE_IMPORT', bookmarks: 1, folders: 1 });
    // The import is a read. Deleting is a different message, sent by a different button, behind a
    // different confirmation.
    expect(mock.removedBookmarks).toEqual([]);
  }, 60_000);

  it('deletes only when told to, and only what it was told', async () => {
    await unlock();
    const response = (await mock.sendMessage({ type: 'DELETE_NATIVE', ids: ['10'] })) as {
      type: string;
      removed: number;
      failed: number;
    };
    expect(response).toEqual({ type: 'NATIVE_DELETE', removed: 1, failed: 0 });
    expect(mock.removedBookmarks).toEqual(['10']);
  }, 30_000);

  it('reports a missing permission as its own error code', async () => {
    await unlock();
    mock.grantedPermissions.delete('bookmarks');
    await expect(mock.sendMessage({ type: 'DELETE_NATIVE', ids: ['10'] })).resolves.toEqual({
      type: 'ERROR',
      code: 'BOOKMARKS_PERMISSION',
    });
  }, 30_000);
});
