/**
 * The `.vmv` container: what it writes, and what a reader is entitled to assume about it.
 *
 * The round trip through a real vault lives in `test/integration/portable-vault.test.ts`; this file
 * is about the file format on its own — including the parts a reader in five years' time depends
 * on, which is exactly what a test rather than a comment is for.
 */

import { describe, expect, it } from 'vitest';

import { fromBase64Url } from '../../../src/crypto/codec.js';
import { ENVELOPE_VERSION } from '../../../src/crypto/envelope.js';
import { RECOMMENDED_KDF_PARAMS } from '../../../src/crypto/kdf.js';
import { DEK_BYTES, subkey, unwrapDek } from '../../../src/crypto/keys.js';
import { deriveKek } from '../../../src/crypto/kdf.js';
import {
  VMV_FORMAT_VERSION,
  VMV_MAGIC,
  exportFilename,
  exportVault,
  serializeVmv,
  type VmvFile,
} from '../../../src/io/export-encrypted.js';
import { openVmv, parseVmv } from '../../../src/io/import-encrypted.js';
import { SCHEMA_VERSION } from '../../../src/vault/types.js';
import { T0, bookmark, deleted, folder } from '../../helpers/items.js';

/**
 * The container derives at `RECOMMENDED_KDF_PARAMS` — 600,000 iterations — and there is deliberately
 * no seam to make that cheaper: an export whose KDF was weakened for the tests would be an export
 * nothing had tested. So the suite exports **once** and every case below reads that one file.
 */
const PASSWORD = 'a backup password worth typing';

const ITEMS = [
  folder('f1', { title: 'Work' }),
  bookmark('b1', { parentId: 'f1', title: 'Spec', url: 'https://example.com/spec' }),
  bookmark('b2', { title: 'Home', tags: ['reading'], note: 'later' }),
  deleted(bookmark('b3')),
];

/** The one export the suite shares. */
let cached: VmvFile | null = null;

async function sample(): Promise<VmvFile> {
  cached ??= await exportVault(ITEMS, PASSWORD, { version: '1.2.3', now: () => T0 });
  return cached;
}

describe('exportVault', () => {
  it('produces a self-describing container', async () => {
    const file = await sample();

    expect(file.magic).toBe(VMV_MAGIC);
    expect(file.formatVersion).toBe(VMV_FORMAT_VERSION);
    expect(file.schemaVersion).toBe(SCHEMA_VERSION);
    expect(file.createdAt).toBe(T0);
    expect(file.createdBy).toBe('VaultaMark 1.2.3');
    expect(file.kdf).toEqual({
      ...RECOMMENDED_KDF_PARAMS,
      salt: expect.any(String),
    });
    expect(fromBase64Url(file.kdf.salt)).toHaveLength(32);
    expect(file.includesThumbs).toBe(false);
    expect(file.thumbs).toBeUndefined();
  }, 30_000);

  it('carries tombstones, so a merge import cannot resurrect a deletion', async () => {
    const items = await openVmv(await sample(), PASSWORD);
    expect(items.get('b3')?.deleted).toBe(true);
  }, 60_000);

  it('wraps a key of its own rather than sealing under the KEK directly', async () => {
    // The wrapped key is what makes "wrong password" distinguishable from "damaged file", so its
    // shape is a contract: 12-byte IV, 32-byte key plus a 16-byte tag.
    const file = await sample();
    expect(fromBase64Url(file.wrappedKey.iv)).toHaveLength(12);
    expect(fromBase64Url(file.wrappedKey.ct)).toHaveLength(DEK_BYTES + 16);

    const kek = await deriveKek(PASSWORD, fromBase64Url(file.kdf.salt), file.kdf);
    const key = await unwrapDek(kek, file.wrappedKey);
    expect(key).toHaveLength(DEK_BYTES);
    // And the payload opens under a subkey of it, not under the key itself.
    await expect(subkey(key, 'items')).resolves.toBeDefined();
  }, 60_000);

  it('frames the payload as an ordinary sealed envelope', async () => {
    const file = await sample();
    const sealed = fromBase64Url(file.payload);
    expect(sealed[0]).toBe(ENVELOPE_VERSION);
    expect(sealed.length).toBeGreaterThan(1 + 12 + 16);
  }, 30_000);

  it('reports progress before and after sealing', async () => {
    const seen: [number, number][] = [];
    await exportVault(ITEMS, PASSWORD, {
      now: () => T0,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([
      [0, ITEMS.length],
      [ITEMS.length, ITEMS.length],
    ]);
  }, 30_000);
});

describe('serializeVmv', () => {
  it('round-trips through the parser', async () => {
    const file = await sample();
    expect(parseVmv(serializeVmv(file))).toEqual(file);
  }, 30_000);

  it('is JSON a person can look inside', async () => {
    const text = serializeVmv(await sample());
    expect(text).toContain(`"magic": "${VMV_MAGIC}"`);
    expect(text.endsWith('\n')).toBe(true);
  }, 30_000);
});

describe('exportFilename', () => {
  it('names the file by date and nothing else', () => {
    // Local time, deliberately: a backup saved on the evening of the 3rd should not be named for
    // the 4th because the machine is east of UTC.
    const at = new Date(2026, 7, 3, 22, 15).getTime();
    expect(exportFilename(at)).toBe('vaultamark-2026-08-03.vmv');
  });

  it('pads single-digit months and days', () => {
    expect(exportFilename(new Date(2026, 0, 5, 12).getTime())).toBe('vaultamark-2026-01-05.vmv');
  });
});
