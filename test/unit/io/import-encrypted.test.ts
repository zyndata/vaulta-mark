/**
 * Reading a `.vmv` — and, mostly, refusing to.
 *
 * Everything an importer touches came off a filesystem, so this file is the hostile-input table the
 * project's testing rules ask for: every field of the container is damaged in turn, and the test
 * asserts not only that it was rejected but **which** failure was reported. That distinction is the
 * whole reason the container carries a wrapped key: `WrongPasswordError` sends someone back to their
 * password manager, `CorruptVaultError` sends them to their other backup, and getting the two the
 * wrong way round wastes the one and loses the other.
 */

import { describe, expect, it } from 'vitest';

import { CorruptVaultError, UnsupportedSchemaError, WrongPasswordError } from '../../../src/crypto/errors.js';
import { MIN_KDF_ITERATIONS } from '../../../src/crypto/kdf.js';
import { VMV_MAGIC, exportVault, serializeVmv, type VmvFile } from '../../../src/io/export-encrypted.js';
import { openVmv, parseVmv, previewOf } from '../../../src/io/import-encrypted.js';
import { SCHEMA_VERSION } from '../../../src/vault/types.js';
import { T0, bookmark, deleted, folder, itemMap } from '../../helpers/items.js';

const PASSWORD = 'a backup password worth typing';

const ITEMS = [
  folder('f1', { title: 'Work' }),
  bookmark('b1', { parentId: 'f1', createdAt: T0 - 5_000 }),
  bookmark('b2', { createdAt: T0 + 5_000 }),
  deleted(bookmark('b3')),
];

/** One export, shared: the tests below damage copies of it rather than making new ones. */
let cached: VmvFile | null = null;

async function sample(): Promise<VmvFile> {
  cached ??= await exportVault(ITEMS, PASSWORD, { version: '1.0.0', now: () => T0 });
  return cached;
}

async function damaged(change: (file: Record<string, unknown>) => void): Promise<string> {
  const file = JSON.parse(serializeVmv(await sample())) as Record<string, unknown>;
  change(file);
  return JSON.stringify(file);
}

describe('parseVmv', () => {
  it('accepts what the writer produced', async () => {
    expect(parseVmv(serializeVmv(await sample())).magic).toBe(VMV_MAGIC);
  }, 30_000);

  it.each([
    ['empty', ''],
    ['not JSON at all', 'this is not a backup'],
    ['truncated mid-object', '{"magic":"VAULTAMARK-EXPORT","formatVer'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a bare number', '42'],
  ])('rejects %s as corrupt', (_label, text) => {
    expect(() => parseVmv(text)).toThrow(CorruptVaultError);
  });

  it('rejects a file that is not ours', () => {
    expect(() => parseVmv(JSON.stringify({ magic: 'SOMETHING-ELSE' }))).toThrow(CorruptVaultError);
  });

  it.each([
    ['no format version', (file: Record<string, unknown>) => delete file['formatVersion']],
    ['a fractional format version', (file: Record<string, unknown>) => (file['formatVersion'] = 1.5)],
    ['no schema version', (file: Record<string, unknown>) => delete file['schemaVersion']],
    ['no KDF block', (file: Record<string, unknown>) => delete file['kdf']],
    ['a KDF array', (file: Record<string, unknown>) => (file['kdf'] = [])],
    [
      'an unknown KDF algorithm',
      (file: Record<string, unknown>) => ((file['kdf'] as Record<string, unknown>)['alg'] = 'scrypt'),
    ],
    [
      'too few iterations',
      (file: Record<string, unknown>) =>
        ((file['kdf'] as Record<string, unknown>)['iterations'] = MIN_KDF_ITERATIONS - 1),
    ],
    [
      'a salt that is not base64url',
      (file: Record<string, unknown>) => ((file['kdf'] as Record<string, unknown>)['salt'] = 'not base64!'),
    ],
    ['no wrapped key', (file: Record<string, unknown>) => delete file['wrappedKey']],
    [
      'a wrapped key with no ciphertext',
      (file: Record<string, unknown>) => delete (file['wrappedKey'] as Record<string, unknown>)['ct'],
    ],
    ['no payload', (file: Record<string, unknown>) => delete file['payload']],
    ['an empty payload', (file: Record<string, unknown>) => (file['payload'] = '')],
    ['a payload that is not base64url', (file: Record<string, unknown>) => (file['payload'] = '@@@')],
  ])('rejects %s as corrupt', async (_label, change) => {
    const text = await damaged(change);
    expect(() => parseVmv(text)).toThrow(CorruptVaultError);
  }, 30_000);

  it('reports a newer container as unsupported rather than corrupt', async () => {
    // The file is fine and this build is old. Telling someone their backup is damaged is how a good
    // backup gets deleted.
    const text = await damaged((file) => (file['formatVersion'] = 99));
    expect(() => parseVmv(text)).toThrow(UnsupportedSchemaError);
  }, 30_000);

  it('reports a newer vault schema as unsupported', async () => {
    const text = await damaged((file) => (file['schemaVersion'] = SCHEMA_VERSION + 1));
    expect(() => parseVmv(text)).toThrow(UnsupportedSchemaError);
  }, 30_000);

  it('tolerates a missing createdAt and createdBy', async () => {
    const text = await damaged((file) => {
      delete file['createdAt'];
      file['createdBy'] = 42;
    });
    const parsed = parseVmv(text);
    expect(parsed.createdAt).toBe(0);
    expect(parsed.createdBy).toBe('');
  }, 30_000);
});

describe('openVmv', () => {
  it('decrypts and validates every item', async () => {
    const items = await openVmv(await sample(), PASSWORD);
    expect([...items.keys()].sort()).toEqual(['b1', 'b2', 'b3', 'f1']);
    expect(items.get('b1')?.parentId).toBe('f1');
  }, 30_000);

  it('reports a wrong password as a wrong password', async () => {
    await expect(openVmv(await sample(), 'not the password')).rejects.toThrow(WrongPasswordError);
  }, 30_000);

  it('reports a tampered payload as corruption, not as a wrong password', async () => {
    // This is the case the wrapped key exists for. The password is right, so the wrap opens; the
    // payload does not, and that can only mean the bytes changed.
    const file = await sample();
    const at = file.payload.length - 5;
    const original = file.payload.charAt(at);
    const payload =
      file.payload.slice(0, at) + (original === 'A' ? 'B' : 'A') + file.payload.slice(at + 1);
    const damagedFile: VmvFile = { ...file, payload };
    await expect(openVmv(damagedFile, PASSWORD)).rejects.toThrow(CorruptVaultError);
  }, 30_000);

  it('reports a truncated payload as corruption', async () => {
    const file = await sample();
    await expect(openVmv({ ...file, payload: file.payload.slice(0, 20) }, PASSWORD)).rejects.toThrow(
      CorruptVaultError,
    );
  }, 30_000);

  it('refuses a payload sealed for a different format version', async () => {
    // The AAD binds the container's own version, so a file relabelled to v2 will not open as v2.
    // That is the property that lets a v1 file keep opening after the vault schema moves on.
    const file = await sample();
    await expect(openVmv({ ...file, formatVersion: 2 }, PASSWORD)).rejects.toThrow(CorruptVaultError);
  }, 30_000);
});

describe('previewOf', () => {
  it('counts what is in the file and what the vault already knows', async () => {
    const file = await sample();
    const items = await openVmv(file, PASSWORD);
    const vault = itemMap(bookmark('b1'), bookmark('other'));

    const preview = previewOf(file, items, vault);
    expect(preview).toEqual({
      bookmarks: 2,
      folders: 1,
      deleted: 1,
      oldest: T0 - 5_000,
      newest: T0 + 5_000,
      createdAt: T0,
      createdBy: 'VaultaMark 1.0.0',
      schemaVersion: SCHEMA_VERSION,
      includesThumbs: false,
      known: 1,
    });
  }, 30_000);

  it('answers with null dates for a file holding no live bookmarks', async () => {
    const file = await sample();
    const preview = previewOf(file, itemMap(folder('f9')), new Map());
    expect(preview).toMatchObject({ bookmarks: 0, folders: 1, oldest: null, newest: null });
  }, 30_000);
});
