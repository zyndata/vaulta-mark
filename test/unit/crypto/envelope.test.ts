import { describe, expect, it } from 'vitest';

import { utf8, utf8Decode, type Bytes } from '../../../src/crypto/codec.js';
import { CorruptVaultError } from '../../../src/crypto/errors.js';
import {
  aadBytes,
  ENVELOPE_OVERHEAD_BYTES,
  ENVELOPE_VERSION,
  gcmDecrypt,
  gcmEncrypt,
  IV_BYTES,
  open,
  seal,
  TAG_BYTES,
  type Aad,
} from '../../../src/crypto/envelope.js';
import vectors from '../../fixtures/gcm-vectors.json';
import { flipBit, hex, randomBytes, unhex } from '../../helpers/bytes.js';

const AAD: Aad = { v: 2, purpose: 'bucket', id: '7' };

async function aesKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function randomKey(): Promise<CryptoKey> {
  return aesKey(randomBytes(32));
}

describe('AES-256-GCM known-answer vectors', () => {
  for (const vector of vectors.aes256) {
    it(`encrypts ${vector.name}`, async () => {
      const key = await aesKey(unhex(vector.key));
      const out = await gcmEncrypt(key, unhex(vector.iv), unhex(vector.pt), unhex(vector.aad));
      expect(hex(out)).toBe(vector.ct);
    });

    it(`decrypts ${vector.name}`, async () => {
      const key = await aesKey(unhex(vector.key));
      const out = await gcmDecrypt(key, unhex(vector.iv), unhex(vector.ct), unhex(vector.aad));
      expect(hex(out)).toBe(vector.pt);
    });
  }

  it('reports a tag failure as corruption, never as a raw OperationError', async () => {
    const vector = vectors.aes256.find((candidate) => candidate.aad.length > 0);
    if (!vector) throw new Error('fixture has no vector with associated data');
    const key = await aesKey(unhex(vector.key));
    const tampered = flipBit(unhex(vector.ct), 0);
    await expect(gcmDecrypt(key, unhex(vector.iv), tampered, unhex(vector.aad))).rejects.toThrow(
      CorruptVaultError,
    );
  });
});

describe('the sealed-blob wire format', () => {
  it('decrypts the pinned vector — a change here is a format break, not a test to regenerate', async () => {
    const { wireFormat } = vectors;
    const key = await aesKey(unhex(wireFormat.key));
    const plaintext = await open(key, unhex(wireFormat.sealed), wireFormat.aad as Aad);
    expect(utf8Decode(plaintext)).toBe(wireFormat.plaintextUtf8);
  });

  it('frames as [1B version][12B IV][ciphertext‖16B tag]', async () => {
    const key = await randomKey();
    const plaintext = randomBytes(100);
    const sealed = await seal(key, plaintext, AAD);

    expect(sealed[0]).toBe(ENVELOPE_VERSION);
    expect(sealed.length).toBe(plaintext.length + ENVELOPE_OVERHEAD_BYTES);
    expect(ENVELOPE_OVERHEAD_BYTES).toBe(1 + IV_BYTES + TAG_BYTES);
  });

  it('uses a fresh IV every time, so the same plaintext never seals to the same bytes', async () => {
    const key = await randomKey();
    const plaintext = utf8('https://example.invalid/one-bookmark');
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      seen.add(hex((await seal(key, plaintext, AAD)).subarray(1, 1 + IV_BYTES)));
    }
    expect(seen.size).toBe(32);
  });

  it('round-trips at every size that matters', async () => {
    const key = await randomKey();
    for (const size of [0, 1, 15, 16, 17, 256, 65_536]) {
      const plaintext = randomBytes(size);
      expect(await open(key, await seal(key, plaintext, AAD), AAD)).toStrictEqual(plaintext);
    }
  });
});

describe('open() rejects anything that is not what we wrote', () => {
  it('rejects a blob too short to hold its own framing', async () => {
    const key = await randomKey();
    for (const size of [0, 1, ENVELOPE_OVERHEAD_BYTES - 1]) {
      await expect(open(key, new Uint8Array(size), AAD)).rejects.toThrow(CorruptVaultError);
    }
  });

  it('rejects an unknown format version', async () => {
    const key = await randomKey();
    const sealed = await seal(key, utf8('payload'), AAD);
    for (const version of [0x00, 0x01, 0x03, 0xff]) {
      const other = Uint8Array.from(sealed);
      other[0] = version;
      await expect(open(key, other, AAD)).rejects.toThrow(CorruptVaultError);
    }
  });

  it('rejects a flip of any single bit, anywhere in the blob', async () => {
    const key = await randomKey();
    const plaintext = utf8('a short bookmark title');
    const sealed = await seal(key, plaintext, AAD);

    // Every byte of every region — version byte, IV, ciphertext, tag — and every bit of every byte.
    for (let byte = 0; byte < sealed.length; byte++) {
      for (let bit = 0; bit < 8; bit++) {
        const tampered = flipBit(sealed, byte, bit);
        await expect(open(key, tampered, AAD)).rejects.toThrow(CorruptVaultError);
      }
    }
  });

  it('rejects a truncated blob', async () => {
    const key = await randomKey();
    const sealed = await seal(key, randomBytes(64), AAD);
    await expect(open(key, sealed.subarray(0, sealed.length - 1), AAD)).rejects.toThrow(
      CorruptVaultError,
    );
  });

  it('rejects the right ciphertext under the wrong key', async () => {
    const sealed = await seal(await randomKey(), utf8('payload'), AAD);
    await expect(open(await randomKey(), sealed, AAD)).rejects.toThrow(CorruptVaultError);
  });
});

describe('associated data binds a blob to its slot', () => {
  it('refuses a bucket replayed into a different bucket index', async () => {
    const key = await randomKey();
    const sealed = await seal(key, utf8('bucket 7 contents'), { v: 2, purpose: 'bucket', id: '7' });
    await expect(open(key, sealed, { v: 2, purpose: 'bucket', id: '8' })).rejects.toThrow(
      CorruptVaultError,
    );
  });

  it('refuses a thumbnail served back as a bucket, and vice versa', async () => {
    const key = await randomKey();
    const sealed = await seal(key, utf8('image bytes'), { v: 2, purpose: 'thumb', id: 'abc' });
    await expect(open(key, sealed, { v: 2, purpose: 'bucket', id: 'abc' })).rejects.toThrow(
      CorruptVaultError,
    );
  });

  it('refuses a blob from a different schema version', async () => {
    const key = await randomKey();
    const sealed = await seal(key, utf8('v2 payload'), AAD);
    await expect(open(key, sealed, { ...AAD, v: 3 })).rejects.toThrow(CorruptVaultError);
  });

  it('encodes canonically, so field order at the call site cannot break authentication', () => {
    const ordered: Aad = { v: 2, purpose: 'bucket', id: '7' };
    // Same values, built in a different order — JSON.stringify would otherwise emit different bytes.
    const shuffled = { id: '7', purpose: 'bucket', v: 2 } as Aad;
    expect(aadBytes(shuffled)).toStrictEqual(aadBytes(ordered));
    expect(utf8Decode(aadBytes(ordered))).toBe('{"v":2,"purpose":"bucket","id":"7"}');
  });

  it('gives each singleton purpose an empty id, as the spec writes it', () => {
    expect(utf8Decode(aadBytes({ v: 2, purpose: 'base', id: '' }))).toBe(
      '{"v":2,"purpose":"base","id":""}',
    );
    expect(utf8Decode(aadBytes({ v: 2, purpose: 'export', id: '' }))).toBe(
      '{"v":2,"purpose":"export","id":""}',
    );
  });
});
