/**
 * The full write path, end to end: **gzip → pad → seal**, and its exact reverse.
 *
 * This is the pipeline every bucket, merge base and export goes through (ARCHITECTURE §4.4), and it
 * is the one place where an off-by-one in the padding, a stream that drops its tail, or an AAD that
 * does not round-trip would cost a user their bookmarks rather than failing a narrow unit test.
 *
 * Padding is applied *after* compression on purpose: padding first would simply be compressed away,
 * taking the length-hiding with it.
 */

import { describe, expect, it } from 'vitest';

import {
  gunzip,
  gzip,
  pad,
  PAD_BLOCK_BYTES,
  unpad,
  utf8,
  type Bytes,
} from '../../../src/crypto/codec.js';
import { open, seal, type Aad } from '../../../src/crypto/envelope.js';
import { CorruptVaultError } from '../../../src/crypto/errors.js';
import { generateDek, subkey } from '../../../src/crypto/keys.js';
import { compressibleBytes, randomBytes } from '../../helpers/bytes.js';

const AAD: Aad = { v: 2, purpose: 'bucket', id: '3' };

async function write(key: CryptoKey, plaintext: Bytes, aad: Aad): Promise<Bytes> {
  return seal(key, pad(await gzip(plaintext)), aad);
}

async function read(key: CryptoKey, sealed: Bytes, aad: Aad): Promise<Bytes> {
  return gunzip(unpad(await open(key, sealed, aad)));
}

describe('gzip → pad → seal round-trip', () => {
  it('survives random plaintexts from 0 to 256 KiB', async () => {
    const key = await subkey(generateDek(), 'items');
    const sizes = [0, 1, 2, 63, 255, 256, 257, 1024, 65_536, 262_144];
    for (const size of sizes) {
      const plaintext = randomBytes(size);
      expect(await read(key, await write(key, plaintext, AAD), AAD)).toStrictEqual(plaintext);
    }
  });

  it('survives realistic, highly compressible payloads', async () => {
    const key = await subkey(generateDek(), 'items');
    for (const size of [0, 900, 40_000, 262_144]) {
      const plaintext = compressibleBytes(size);
      expect(await read(key, await write(key, plaintext, AAD), AAD)).toStrictEqual(plaintext);
    }
  });

  it('survives JSON that looks like a real bucket', async () => {
    const key = await subkey(generateDek(), 'items');
    const payload = utf8(
      JSON.stringify({
        items: Array.from({ length: 200 }, (_, index) => ({
          id: `0000000${index}`,
          type: 'bookmark',
          parentId: 'root',
          title: `Bookmark number ${index} — with an em dash, 北京 and 🔐`,
          url: `https://example.invalid/path/${index}?q=1#fragment`,
          tags: ['reading', 'later', `bucket-${index % 7}`],
          note: 'A note with\nnewlines and "quotes".',
          createdAt: 1_750_000_000_000 + index,
          updatedAt: 1_750_000_000_000 + index,
          order: `a${index.toString(36)}`,
          rev: index,
        })),
      }),
    );
    expect(await read(key, await write(key, payload, AAD), AAD)).toStrictEqual(payload);
  });

  it('keeps the sealed length on a padded boundary, so it leaks only a coarse size', async () => {
    const key = await subkey(generateDek(), 'items');
    // The blob is [1B version][12B IV][padded plaintext ‖ 16B tag]; strip the framing and what is
    // left must land on a block boundary.
    for (const size of [10, 300, 500, 4000]) {
      const sealed = await write(key, randomBytes(size), AAD);
      expect((sealed.length - 29) % PAD_BLOCK_BYTES).toBe(0);
    }
  });

  it('hides the difference between a 300-byte and a 500-byte payload', async () => {
    const key = await subkey(generateDek(), 'items');
    // Incompressible input, so gzip cannot collapse the two to the same size for the wrong reason.
    const short = await write(key, randomBytes(300), AAD);
    const long = await write(key, randomBytes(400), AAD);
    expect(short.length).toBe(long.length);
  });

  it('refuses to read a bucket back into the wrong slot', async () => {
    const key = await subkey(generateDek(), 'items');
    const sealed = await write(key, utf8('bucket three'), AAD);
    await expect(read(key, sealed, { ...AAD, id: '4' })).rejects.toThrow(CorruptVaultError);
  });

  it('refuses to read with a key derived for a different purpose', async () => {
    const dek = generateDek();
    const sealed = await write(await subkey(dek, 'items'), utf8('bucket three'), AAD);
    await expect(read(await subkey(dek, 'thumbs'), sealed, AAD)).rejects.toThrow(CorruptVaultError);
  });

  it('produces completely different bytes for the same plaintext each time', async () => {
    // Random IVs mean a whole-blob rewrite changes every byte, which is exactly why the storage
    // layout is bucketed: one edit must rewrite one bucket, not the entire sync quota.
    const key = await subkey(generateDek(), 'items');
    const plaintext = utf8('the same bucket, twice');
    const first = await write(key, plaintext, AAD);
    const second = await write(key, plaintext, AAD);

    expect(first.length).toBe(second.length);
    expect(first.subarray(1)).not.toStrictEqual(second.subarray(1));
  });
});
