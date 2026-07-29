import { describe, expect, it } from 'vitest';

import { CorruptVaultError, UnsupportedSchemaError } from '../../../src/crypto/errors.js';
import { MIGRATIONS, migrate, needsMigration } from '../../../src/vault/migrate.js';
import { listChildren, toItemMap } from '../../../src/vault/model.js';
import { compareOrder, isOrderKey } from '../../../src/vault/order.js';
import {
  ROOT_ID,
  SCHEMA_VERSION,
  isDeleted,
  noteOf,
  tagsOf,
  type Bookmark,
} from '../../../src/vault/types.js';
import vaultV1 from '../../fixtures/vault-v1.json' with { type: 'json' };

const READING_FOLDER = '0f2b6a54-4f1d-4a0c-9d4a-0a1b2c3d4e01';
const PADDING_PAPER = '0f2b6a54-4f1d-4a0c-9d4a-0a1b2c3d4e04';
const KEY_SEPARATION = '0f2b6a54-4f1d-4a0c-9d4a-0a1b2c3d4e05';
const DELETED_ITEM = '0f2b6a54-4f1d-4a0c-9d4a-0a1b2c3d4e06';

describe('migrate', () => {
  it('loads the committed v1 fixture and produces a v2 payload', () => {
    const payload = migrate(vaultV1, vaultV1.schemaVersion);
    expect(payload.items).toHaveLength(vaultV1.items.length);
    expect(SCHEMA_VERSION).toBe(2);
  });

  it('converts integer ordering to fractional index keys', () => {
    const items = toItemMap(migrate(vaultV1, 1).items);
    for (const item of items.values()) {
      expect(isOrderKey(item.order), item.id).toBe(true);
    }
    // v1 ordered the Reading folder 10 then 20; the fractional keys must preserve that.
    const reading = listChildren(items, READING_FOLDER);
    expect(reading.map((item) => item.id)).toEqual([KEY_SEPARATION, PADDING_PAPER]);
    expect(compareOrder(reading[0]!.order, reading[1]!.order)).toBe(-1);
  });

  it('re-numbers each parent independently', () => {
    const items = toItemMap(migrate(vaultV1, 1).items);
    const top = listChildren(items, ROOT_ID);
    // v1 orders at the top level were 0, 1, 2 — the bookmark first, then the two folders.
    expect(top.map((item) => item.title)).toEqual(['Example Domain', 'Reading', 'Work']);
  });

  it('defaults tags and notes without writing empty values into the ciphertext', () => {
    const items = toItemMap(migrate(vaultV1, 1).items);
    const bookmark = items.get(PADDING_PAPER) as Bookmark;
    expect(tagsOf(bookmark)).toEqual([]);
    expect(noteOf(bookmark)).toBe('');
    // Absent, not `[]`/`""`: every item paying for an empty array costs real sync quota.
    expect('tags' in bookmark).toBe(false);
    expect('note' in bookmark).toBe(false);
    expect('thumb' in bookmark).toBe(false);
    expect('og' in bookmark).toBe(false);
  });

  it('carries tombstones through unchanged', () => {
    const items = toItemMap(migrate(vaultV1, 1).items);
    expect(isDeleted(items.get(DELETED_ITEM)!)).toBe(true);
  });

  it('is a no-op at the current version', () => {
    const already = { items: migrate(vaultV1, 1).items };
    const again = migrate(already, SCHEMA_VERSION);
    expect(again.items).toEqual(already.items);
  });

  it('refuses a vault from a newer build rather than downgrade-writing it', () => {
    expect(() => migrate({ items: [] }, SCHEMA_VERSION + 1)).toThrow(UnsupportedSchemaError);
    try {
      migrate({ items: [] }, 9);
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect((error as UnsupportedSchemaError).schemaVersion).toBe(9);
      expect((error as UnsupportedSchemaError).supportedVersion).toBe(SCHEMA_VERSION);
    }
  });

  it('rejects a schema version that was never one', () => {
    expect(() => migrate({ items: [] }, 0)).toThrow(CorruptVaultError);
    expect(() => migrate({ items: [] }, 1.5)).toThrow(CorruptVaultError);
  });

  it('rejects a payload that is not a payload', () => {
    expect(() => migrate(null, 2)).toThrow(CorruptVaultError);
    expect(() => migrate('nope', 2)).toThrow(CorruptVaultError);
    expect(() => migrate({}, 2)).toThrow(CorruptVaultError);
    expect(() => migrate({ items: [1] }, 2)).toThrow(CorruptVaultError);
    expect(() => migrate({ items: [null] }, 2)).toThrow(CorruptVaultError);
  });

  it('rejects an item whose required fields are missing or of the wrong type', () => {
    const good = {
      id: 'x',
      type: 'bookmark',
      parentId: ROOT_ID,
      title: 't',
      url: 'https://x.test/',
      order: 'a0',
      createdAt: 1,
      updatedAt: 1,
      rev: 1,
    };
    expect(() => migrate({ items: [good] }, 2)).not.toThrow();
    expect(() => migrate({ items: [{ ...good, type: 'link' }] }, 2)).toThrow(CorruptVaultError);
    expect(() => migrate({ items: [{ ...good, id: 7 }] }, 2)).toThrow(CorruptVaultError);
    expect(() => migrate({ items: [{ ...good, rev: 'one' }] }, 2)).toThrow(CorruptVaultError);
    const { url: _dropped, ...noUrl } = good;
    expect(() => migrate({ items: [noUrl] }, 2)).toThrow(CorruptVaultError);
  });

  it('reports when a stored vault needs migrating', () => {
    expect(needsMigration(1)).toBe(true);
    expect(needsMigration(SCHEMA_VERSION)).toBe(false);
  });

  it('registers one step per version gap, in order', () => {
    expect(MIGRATIONS.map((step) => [step.from, step.to])).toEqual([[1, 2]]);
  });
});
