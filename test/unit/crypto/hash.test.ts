import { describe, expect, it } from 'vitest';

import { utf8, type Bytes } from '../../../src/crypto/codec.js';
import { CorruptVaultError } from '../../../src/crypto/errors.js';
import {
  assertHmacSha256,
  equalBytes,
  hmacSha256,
  sha256,
  verifyHmacSha256,
} from '../../../src/crypto/hash.js';
import { hex, unhex } from '../../helpers/bytes.js';

/** RFC 4231 §4.2, test case 1. */
const HMAC_KEY = unhex('0b'.repeat(20));
const HMAC_DATA = utf8('Hi There');
const HMAC_TAG = 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';

async function importHmacKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

describe('sha256', () => {
  it('matches the published FIPS 180-4 vectors', async () => {
    expect(hex(await sha256(utf8('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hex(await sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      hex(await sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });
});

describe('hmacSha256', () => {
  it('matches RFC 4231 test case 1', async () => {
    const key = await importHmacKey(HMAC_KEY);
    expect(hex(await hmacSha256(key, HMAC_DATA))).toBe(HMAC_TAG);
  });

  it('verifies a truncated tag, which is what bucket metadata stores', async () => {
    const key = await importHmacKey(HMAC_KEY);
    const full = await hmacSha256(key, HMAC_DATA);
    // ARCHITECTURE §3.1 keeps only the first 8 bytes in the header, so WebCrypto's own `verify`
    // — which insists on a full-length tag — cannot be used here.
    expect(await verifyHmacSha256(key, HMAC_DATA, full.subarray(0, 8))).toBe(true);
    expect(await verifyHmacSha256(key, HMAC_DATA, full)).toBe(true);
  });

  it('rejects a tag over different data, or under a different key', async () => {
    const key = await importHmacKey(HMAC_KEY);
    const other = await importHmacKey(unhex('aa'.repeat(20)));
    const tag = (await hmacSha256(key, HMAC_DATA)).subarray(0, 8);

    expect(await verifyHmacSha256(key, utf8('Hi there'), tag)).toBe(false);
    expect(await verifyHmacSha256(other, HMAC_DATA, tag)).toBe(false);
  });

  it('throws rather than returning a boolean a caller might drop on the floor', async () => {
    const key = await importHmacKey(HMAC_KEY);
    const tag = (await hmacSha256(key, HMAC_DATA)).subarray(0, 8);

    await expect(assertHmacSha256(key, HMAC_DATA, tag)).resolves.toBeUndefined();
    await expect(assertHmacSha256(key, utf8('tampered'), tag)).rejects.toThrow(CorruptVaultError);
  });
});

describe('equalBytes', () => {
  it('is true only for identical contents', () => {
    expect(equalBytes(unhex('00112233'), unhex('00112233'))).toBe(true);
    expect(equalBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    expect(equalBytes(unhex('00112233'), unhex('00112234'))).toBe(false);
    expect(equalBytes(unhex('00112233'), unhex('80112233'))).toBe(false);
  });

  it('is false for different lengths without reading past the end', () => {
    expect(equalBytes(unhex('0011'), unhex('001122'))).toBe(false);
    expect(equalBytes(unhex('001122'), unhex('0011'))).toBe(false);
    expect(equalBytes(new Uint8Array(0), unhex('00'))).toBe(false);
  });

  it('catches a difference in any position, including the last byte', () => {
    // A loop that stops early would still pass a first-byte test. Walking the difference across
    // every index is the behavioural half of "no early exit"; the timing half is untestable in a
    // JIT, which is why the implementation is written to have no exit to measure.
    const base = new Uint8Array(64).fill(0x5a);
    for (let i = 0; i < base.length; i++) {
      const other = Uint8Array.from(base);
      other[i] = 0x5b;
      expect(equalBytes(base, other)).toBe(false);
    }
    expect(equalBytes(base, Uint8Array.from(base))).toBe(true);
  });
});
