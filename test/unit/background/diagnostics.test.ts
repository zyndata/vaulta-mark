/**
 * Gathering the diagnostics record, over the real message router.
 *
 * The assertions that matter are about what the record does *not* contain. A seeded vault here has
 * bookmarks with distinctive URLs, titles, notes and tags, and the whole formatted report is
 * searched for every one of them — which is a test of the design (the worker hands back a closed
 * record; the page is never trusted to filter) rather than of any single field.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDiagnostics, type Diagnostics } from '../../../src/shared/diagnostics.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

const PASSWORD = 'a reasonably long master password';

/** Strings a leak would carry. Every one of them is in the vault by the time the report is taken. */
const SECRETS = {
  url: 'https://very-distinctive-host.example/secret-path',
  title: 'Zebracorn Quarterly Filings',
  note: 'the pineapple is under the doormat',
  tag: 'wombatology',
  folder: 'Aardvark Papers',
};

let mock: ChromeMock;

async function send(message: unknown): Promise<Record<string, unknown>> {
  return (await mock.sendMessage(message)) as Record<string, unknown>;
}

async function diagnostics(): Promise<Diagnostics> {
  const response = await send({ type: 'GET_DIAGNOSTICS' });
  expect(response['type']).toBe('DIAGNOSTICS');
  return response['diagnostics'] as Diagnostics;
}

beforeAll(() => {
  // PBKDF2 at 600,000 iterations is half a second, and each test creates a vault.
  vi.setConfig({ testTimeout: 30_000 });
});

beforeEach(async () => {
  mock = installChromeMock();
  mock.terminateWorker();
  vi.resetModules();
  await import('../../../src/background/index.js');
  await send({ type: 'CREATE_VAULT', password: PASSWORD });
});

afterEach(async () => {
  const { resetSync, syncNow } = await import('../../../src/sync/engine.js');
  await syncNow();
  resetSync();
  mock.terminateWorker();
  uninstallChromeMock();
});

async function seed(): Promise<void> {
  const folder = await send({ type: 'CREATE_FOLDER', title: SECRETS.folder });
  const folderId = folder['id'] as string;
  const added = await send({ type: 'ADD_URL', url: SECRETS.url, title: SECRETS.title });
  const id = (added['item'] as { id: string }).id;
  await send({ type: 'MOVE_ITEMS', ids: [id], parentId: folderId });
  await send({ type: 'UPDATE_ITEM', id, patch: { note: SECRETS.note } });
  await send({ type: 'TAG_ITEMS', ids: [id], add: [SECRETS.tag] });
  await send({ type: 'ADD_URL', url: 'https://example.com/two', title: 'Two' });
}

describe('the record', () => {
  it('counts an unlocked vault without naming anything in it', async () => {
    await seed();
    const record = await diagnostics();

    expect(record).toMatchObject({
      vaultExists: true,
      locked: false,
      bookmarks: 2,
      folders: 1,
      tags: 1,
      withNotes: 1,
    });

    // The assertion this file exists for: the whole report, searched for every distinctive string
    // that is genuinely in the vault. A field added later that carries content fails here.
    const text = formatDiagnostics(record);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(text).not.toContain('very-distinctive-host');
  });

  it('reports the vault half as unknown while locked, rather than as zero', async () => {
    await seed();
    await send({ type: 'LOCK' });
    const record = await diagnostics();

    expect(record.vaultExists).toBe(true);
    expect(record.locked).toBe(true);
    // Not `0`: a locked vault has not been counted, and a bug report about missing bookmarks needs
    // to be able to tell those two apart.
    expect(record.bookmarks).toBeNull();
    expect(record.folders).toBeNull();
    expect(record.tombstones).toBeNull();
  });

  it('counts tombstones separately from live items, since a delete is a tombstone', async () => {
    const added = await send({ type: 'ADD_URL', url: 'https://example.com/gone', title: 'Gone' });
    await send({ type: 'DELETE_ITEMS', ids: [(added['item'] as { id: string }).id] });
    const record = await diagnostics();
    expect(record.bookmarks).toBe(0);
    expect(record.tombstones).toBe(1);
  });

  it('names which optional permissions are granted and no host pattern at all', async () => {
    mock.grantedPermissions.add('history');
    const record = await diagnostics();
    expect(record.optionalPermissions).toContain('history');
    expect(record.optionalPermissions).not.toContain('bookmarks');
    // `getAll()` would have brought origins with it; this asks about a list we wrote.
    expect(record.optionalPermissions.every((name) => !name.includes('://'))).toBe(true);
  });

  it('says whether the build has an OAuth client, never which one', async () => {
    const record = await diagnostics();
    expect(typeof record.oauthConfigured).toBe('boolean');
    expect(JSON.stringify(record)).not.toContain('apps.googleusercontent.com');
  });

  it('is still produced when the vault does not exist at all', async () => {
    await send({ type: 'DESTROY_VAULT', confirm: true });
    const record = await diagnostics();
    expect(record.vaultExists).toBe(false);
    expect(record.locked).toBe(true);
    expect(record.bookmarks).toBeNull();
  });
});

describe('when a source fails', () => {
  it('reports what it could not ask rather than answering with an invented zero', async () => {
    // `usage()` is a network request on Drive, so this is the state a disconnected Drive puts the
    // worker in — the same failure `status()` learned to tolerate in Phase 10. The point is that
    // the button still produces a report: a diagnostics feature that breaks when the extension is
    // broken is one nobody can use when they need it.
    const syncing = await import('../../../src/background/syncing.js');
    const spy = vi.spyOn(syncing, 'syncStatus').mockRejectedValue(new Error('offline'));

    const record = await diagnostics();
    expect(record.syncPhase).toBe('error');
    expect(record.syncError).toBe('UNKNOWN');
    expect(record.syncQuotaBytes).toBe(0);
    // Everything that did not depend on the failed source is still real.
    expect(record.vaultExists).toBe(true);
    spy.mockRestore();
  });
});

describe('platformFamily', () => {
  it('answers one word, and never the user agent it was given', async () => {
    const { platformFamily } = await import('../../../src/background/diagnostics.js');
    expect(platformFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0')).toBe(
      'windows',
    );
    expect(platformFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/128')).toBe(
      'macos',
    );
    expect(platformFamily('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/128')).toBe('chromeos');
    expect(platformFamily('Mozilla/5.0 (X11; Linux x86_64) Chrome/128')).toBe('linux');
    expect(platformFamily('something else entirely')).toBe('unknown');
  });
});
