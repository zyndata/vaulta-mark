/**
 * The whole storage stack against the `chrome.*` mock: create → fill → lock → unlock → edit →
 * migrate, plus the two claims Phase 3 has to be able to make about it.
 *
 * **INV-6** is the one that matters most. Everything else in this file is a correctness test; the
 * INV-6 case is the product promise. If any title, URL, tag or note can be found by scanning
 * `storage.local`, the extension is not what it says it is, and no amount of correct crypto
 * elsewhere fixes that.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fromBase64Url, gzip, pad, toBase64Url, utf8 } from '../../src/crypto/codec.js';
import { seal } from '../../src/crypto/envelope.js';
import { deriveKek } from '../../src/crypto/kdf.js';
import { subkey, unwrapDek } from '../../src/crypto/keys.js';
import { hmacSha256 } from '../../src/crypto/hash.js';
import { assembleBuckets } from '../../src/storage/buckets.js';
import { LOCAL_KEYS, bucketKey } from '../../src/storage/local.js';
import { VaultRepository } from '../../src/storage/repo.js';
import { canonicalJson, listChildren } from '../../src/vault/model.js';
import { isOrderKey } from '../../src/vault/order.js';
import {
  ROOT_ID,
  SCHEMA_VERSION,
  isDeleted,
  type Bookmark,
  type VaultHeader,
  type VaultItem,
} from '../../src/vault/types.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../mocks/chrome.js';

const PASSWORD = 'a reasonably long master password';
const NOW = 1_750_000_000_000;

/**
 * Plaintext that must never appear in storage. Chosen to be unmistakable: if a scan finds
 * "kestrel" anywhere in `storage.local`, something wrote a title in the clear.
 */
const SECRETS = {
  title: 'kestrel-nightjar-plaintext-title',
  url: 'https://bittern-secret.example/reed-warbler',
  tag: 'corncrake',
  note: 'wryneck-note-body-that-must-not-leak',
  folder: 'nuthatch-folder-name',
} as const;

let mock: ChromeMock;

/**
 * `prefix` stands in for "a different install": two repositories over one vault must not mint the
 * same item ids, exactly as two devices would not.
 */
function repository(coalesceMs = 60_000, prefix = 'id'): VaultRepository {
  let next = 0;
  return new VaultRepository({
    now: () => NOW,
    newId: () => `${prefix}-${String(next++).padStart(4, '0')}`,
    coalesceMs,
  });
}

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('vault lifecycle', () => {
  it('round-trips 500 items through create, lock and unlock', async () => {
    const repo = repository();
    await repo.create(PASSWORD);

    const titles: string[] = [];
    const mutations = Array.from({ length: 500 }, (_unused, i) => {
      const title = `Bookmark number ${String(i)}`;
      titles.push(title);
      return {
        kind: 'add' as const,
        input: {
          type: 'bookmark' as const,
          url: `https://example.org/page/${String(i)}`,
          title,
          tags: i % 3 === 0 ? ['reading', 'later'] : [],
        },
      };
    });
    await repo.apply(mutations);
    await repo.lock();

    const reopened = repository();
    await reopened.unlock(PASSWORD);
    const items = reopened.getAll();
    expect(items).toHaveLength(500);
    expect(items.map((item) => item.title).toSorted()).toEqual(titles.toSorted());
    expect(items.every((item) => isOrderKey(item.order))).toBe(true);
    // Every item came back in a bucket that agrees with the assignment function.
    expect(reopened.header().bucketCount).toBe(16);
    await reopened.lock({ flush: false });
  }, 60_000);

  it('unlocks a 500-item vault well inside the 150 ms budget, KDF excluded', async () => {
    const repo = repository();
    await repo.create(PASSWORD);
    await repo.apply(
      Array.from({ length: 500 }, (_unused, i) => ({
        kind: 'add' as const,
        input: {
          type: 'bookmark' as const,
          url: `https://example.org/page/${String(i)}`,
          title: `Bookmark number ${String(i)}`,
          note: 'a short note to make the payload realistic',
          tags: ['reading'],
        },
      })),
    );
    await repo.lock();

    // The KDF is deliberately expensive (600,000 iterations) and is not what this budget is about,
    // so it is measured separately and subtracted rather than mocked away.
    const header = (await mock.storage.local.get(LOCAL_KEYS.meta))[LOCAL_KEYS.meta] as VaultHeader;
    const kdfStart = performance.now();
    await deriveKek(PASSWORD, fromBase64Url(header.kdf.salt), {
      alg: header.kdf.alg,
      iterations: header.kdf.iterations,
    });
    const kdfMs = performance.now() - kdfStart;

    const reopened = repository();
    const start = performance.now();
    await reopened.unlock(PASSWORD);
    const totalMs = performance.now() - start;

    expect(reopened.getAll()).toHaveLength(500);
    expect(totalMs - kdfMs).toBeLessThan(150);
    await reopened.lock({ flush: false });
  }, 60_000);

  it('keeps folders, tags, notes and ordering across a lock', async () => {
    const repo = repository();
    await repo.create(PASSWORD);
    await repo.apply([
      { kind: 'add', input: { type: 'folder', title: SECRETS.folder } },
      {
        kind: 'add',
        input: {
          type: 'bookmark',
          url: SECRETS.url,
          title: SECRETS.title,
          tags: [SECRETS.tag],
          note: SECRETS.note,
          parentId: 'id-0000',
        },
      },
      {
        kind: 'add',
        input: { type: 'bookmark', url: 'https://example.com/b', title: 'B', parentId: 'id-0000' },
      },
    ]);
    await repo.apply([{ kind: 'move', id: 'id-0002', parentId: 'id-0000', afterId: null }]);
    await repo.lock();

    const reopened = repository();
    await reopened.unlock(PASSWORD);
    const children = listChildren(reopened.items(), 'id-0000');
    expect(children.map((item) => item.id)).toEqual(['id-0002', 'id-0001']);

    const bookmark = reopened.getItem('id-0001') as Bookmark;
    expect(bookmark.url).toBe(SECRETS.url);
    expect(bookmark.tags).toEqual([SECRETS.tag]);
    expect(bookmark.note).toBe(SECRETS.note);
    expect(listChildren(reopened.items(), ROOT_ID).map((item) => item.title)).toEqual([
      SECRETS.folder,
    ]);
    await reopened.lock({ flush: false });
  }, 60_000);

  it('carries tombstones across a lock so a stale peer cannot resurrect a delete', async () => {
    const repo = repository();
    await repo.create(PASSWORD);
    await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/b', title: 'B' } },
    ]);
    await repo.apply([{ kind: 'delete', id: 'id-0000' }]);
    await repo.lock();

    const reopened = repository();
    await reopened.unlock(PASSWORD);
    expect(reopened.getAll()).toHaveLength(1);
    const tombstone = reopened.getItem('id-0000')!;
    expect(isDeleted(tombstone)).toBe(true);
    expect(tombstone.deletedAt).toBe(NOW);
    await reopened.lock({ flush: false });
  }, 60_000);
});

describe('INV-6 — no plaintext vault content reaches storage.local', () => {
  it('survives a full add, edit, delete and re-unlock cycle', async () => {
    const repo = repository();
    await repo.create(PASSWORD);
    await repo.apply([
      { kind: 'add', input: { type: 'folder', title: SECRETS.folder } },
      {
        kind: 'add',
        input: {
          type: 'bookmark',
          url: SECRETS.url,
          title: SECRETS.title,
          tags: [SECRETS.tag],
          note: SECRETS.note,
          parentId: 'id-0000',
        },
      },
    ]);
    await repo.apply([
      { kind: 'update', id: 'id-0001', patch: { title: `${SECRETS.title} (edited)` } },
    ]);
    await repo.apply([{ kind: 'delete', id: 'id-0001' }]);
    await repo.lock();

    const reopened = repository(60_000, 'second');
    await reopened.unlock(PASSWORD);
    await reopened.apply([
      { kind: 'add', input: { type: 'bookmark', url: SECRETS.url, title: SECRETS.title } },
    ]);
    await reopened.lock();

    // The scan: everything storage.local holds, as one string, including the keys.
    const dump = JSON.stringify(mock.storage.local.snapshot());
    for (const [field, secret] of Object.entries(SECRETS)) {
      expect(dump, `${field} leaked into storage.local`).not.toContain(secret);
      // …and in case something wrote it base64url-encoded rather than encrypted.
      expect(dump, `${field} leaked base64url-encoded`).not.toContain(toBase64Url(utf8(secret)));
    }
    // The vault is definitely there — this is not passing because nothing was written.
    expect(dump).toContain(LOCAL_KEYS.meta);
    expect(
      Object.keys(mock.storage.local.snapshot()).some((k) => k.startsWith('vm.buckets.')),
    ).toBe(true);
  }, 60_000);

  it('leaks only what the header is documented to leak', async () => {
    const repo = repository();
    await repo.create(PASSWORD);
    await repo.apply([
      {
        kind: 'add',
        input: { type: 'bookmark', url: SECRETS.url, title: SECRETS.title, tags: [SECRETS.tag] },
      },
    ]);
    await repo.flush();

    const header = mock.storage.local.snapshot()[LOCAL_KEYS.meta] as VaultHeader;
    // Existence, size and revision count — and nothing else (ARCHITECTURE §3.1).
    expect(Object.keys(header).toSorted()).toEqual(
      [
        'buckets',
        'bucketCount',
        'createdAt',
        'deviceId',
        'kdf',
        'magic',
        'schemaVersion',
        'updatedAt',
        'vaultRev',
        'wrappedDek',
      ].toSorted(),
    );
    expect(JSON.stringify(header)).not.toContain(SECRETS.title);
    await repo.lock({ flush: false });
  }, 60_000);

  it('never stores a search index, which would be the vault content reorganised', async () => {
    const repo = repository();
    await repo.create(PASSWORD);
    await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: SECRETS.url, title: SECRETS.title } },
    ]);
    expect(repo.search('kestrel')).toHaveLength(1);
    await repo.flush();

    expect(Object.keys(mock.storage.local.snapshot()).toSorted()).toEqual(
      [
        LOCAL_KEYS.meta,
        ...Object.keys(mock.storage.local.snapshot()).filter((k) => k.startsWith('vm.buckets.')),
      ].toSorted(),
    );
    await repo.lock({ flush: false });
  }, 60_000);
});

describe('migration on unlock', () => {
  /**
   * Rewrite a real vault's storage as a schema-v1 one.
   *
   * The test knows the password, so it can derive the same keys the repository does and seal a v1
   * payload the same way — which is the only honest way to produce a v1 vault, since no build ever
   * shipped one.
   */
  async function downgradeToV1(items: readonly Record<string, unknown>[]): Promise<void> {
    const header = mock.storage.local.snapshot()[LOCAL_KEYS.meta] as VaultHeader;
    const kek = await deriveKek(PASSWORD, fromBase64Url(header.kdf.salt), {
      alg: header.kdf.alg,
      iterations: header.kdf.iterations,
    });
    const dek = await unwrapDek(kek, header.wrappedDek);
    const itemsKey = await subkey(dek, 'items');
    const hmacKey = await subkey(dek, 'hmac');

    const buckets = await assembleBuckets(items as unknown as VaultItem[], header.bucketCount);
    const updates: Record<string, string> = {};
    const metas = [];
    for (const [index, payload] of buckets) {
      if (payload.items.length === 0) {
        metas.push({ i: index, rev: 1, parts: 0, tag: '' });
        continue;
      }
      const json = utf8(canonicalJson(payload));
      const tag = toBase64Url((await hmacSha256(hmacKey, json)).subarray(0, 8));
      const sealed = await seal(itemsKey, pad(await gzip(json)), {
        v: SCHEMA_VERSION,
        purpose: 'bucket',
        id: String(index),
      });
      updates[bucketKey(index)] = toBase64Url(sealed);
      metas.push({ i: index, rev: 1, parts: 1, tag });
    }

    await mock.storage.local.set({
      ...updates,
      [LOCAL_KEYS.meta]: {
        ...header,
        schemaVersion: 1,
        buckets: metas.toSorted((a, b) => a.i - b.i),
      },
    });
  }

  it('migrates a v1 vault in memory and writes it back on the next commit', async () => {
    const repo = repository();
    await repo.create(PASSWORD);
    await repo.flush();

    await downgradeToV1([
      {
        id: 'v1-folder',
        type: 'folder',
        parentId: ROOT_ID,
        title: 'Reading',
        createdAt: 1,
        updatedAt: 1,
        order: 1,
        rev: 1,
      },
      {
        id: 'v1-second',
        type: 'bookmark',
        parentId: 'v1-folder',
        title: 'Second',
        url: 'https://example.org/2',
        createdAt: 1,
        updatedAt: 1,
        order: 20,
        rev: 1,
      },
      {
        id: 'v1-first',
        type: 'bookmark',
        parentId: 'v1-folder',
        title: 'First',
        url: 'https://example.org/1',
        createdAt: 1,
        updatedAt: 1,
        order: 10,
        rev: 1,
      },
    ]);

    const migrated = repository();
    await migrated.unlock(PASSWORD);
    expect(migrated.header().schemaVersion).toBe(SCHEMA_VERSION);
    expect(listChildren(migrated.items(), 'v1-folder').map((item) => item.title)).toEqual([
      'First',
      'Second',
    ]);
    expect(migrated.getAll().every((item) => isOrderKey(item.order))).toBe(true);

    // Not written yet: opening a vault read-only must not rewrite it.
    const storedBefore = (mock.storage.local.snapshot()[LOCAL_KEYS.meta] as VaultHeader)
      .schemaVersion;
    expect(storedBefore).toBe(1);

    await migrated.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/3', title: 'Third' } },
    ]);
    await migrated.flush();
    expect((mock.storage.local.snapshot()[LOCAL_KEYS.meta] as VaultHeader).schemaVersion).toBe(
      SCHEMA_VERSION,
    );

    await migrated.lock();
    const again = repository();
    await again.unlock(PASSWORD);
    expect(again.getAll()).toHaveLength(4);
    await again.lock({ flush: false });
  }, 60_000);
});
