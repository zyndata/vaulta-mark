import { describe, expect, it } from 'vitest';

import {
  concatBytes,
  fromBase64Url,
  gunzip,
  gzip,
  pad,
  PAD_BLOCK_BYTES,
  toBase64Url,
  unpad,
  utf8,
  utf8Decode,
} from '../../../src/crypto/codec.js';
import { CorruptVaultError } from '../../../src/crypto/errors.js';
import { compressibleBytes, hex, randomBytes, unhex } from '../../helpers/bytes.js';

describe('gzip / gunzip', () => {
  it('round-trips, including the empty payload', async () => {
    for (const size of [0, 1, 255, 256, 4096, 100_000]) {
      const data = compressibleBytes(size);
      expect(await gunzip(await gzip(data))).toStrictEqual(data);
    }
  });

  it('actually compresses repetitive payloads — this is what makes the sync tier viable', async () => {
    const data = compressibleBytes(64 * 1024);
    expect((await gzip(data)).length).toBeLessThan(data.length / 3);
  });

  it('survives a payload larger than the stream backpressure window', async () => {
    // Regression guard for the write/read ordering in `pump`: awaiting the writer before draining
    // the reader deadlocks once the input exceeds the stream's internal queue.
    //
    // A megabyte of incompressible bytes through two stream transforms is slow enough on a CI
    // runner to blow the 5-second default. The generous budget does not weaken the guard — the
    // failure this catches is a deadlock, which never finishes at any timeout.
    const data = randomBytes(1_000_000);
    expect(await gunzip(await gzip(data))).toStrictEqual(data);
  }, 30_000);

  it('reports non-gzip input as corruption, not as a raw TypeError', async () => {
    await expect(gunzip(randomBytes(64))).rejects.toThrow(CorruptVaultError);
    await expect(gunzip(new Uint8Array(0))).rejects.toThrow(CorruptVaultError);
  });
});

describe('pad / unpad', () => {
  it('round-trips at every interesting length', () => {
    for (const size of [0, 1, 251, 252, 253, 255, 256, 512, 1000]) {
      const data = randomBytes(size);
      const padded = pad(data);
      expect(padded.length % PAD_BLOCK_BYTES).toBe(0);
      expect(unpad(padded)).toStrictEqual(data);
    }
  });

  it('hides length: 300 and 500 bytes pad to the same size', () => {
    expect(pad(randomBytes(300)).length).toBe(pad(randomBytes(500)).length);
    expect(pad(randomBytes(300)).length).toBe(512);
  });

  it('rounds up to the block boundary, and does not add a whole wasted block on an exact fit', () => {
    expect(pad(randomBytes(0)).length).toBe(256); // 4 bytes of length prefix still need a block
    expect(pad(randomBytes(251)).length).toBe(256);
    expect(pad(randomBytes(252)).length).toBe(256); // 4 + 252 lands exactly on the boundary
    expect(pad(randomBytes(253)).length).toBe(512);
  });

  it('writes the payload length as a little-endian uint32', () => {
    const padded = pad(new Uint8Array([0xaa, 0xbb, 0xcc]));
    expect([...padded.subarray(0, 4)]).toStrictEqual([3, 0, 0, 0]);
    expect([...padded.subarray(4, 7)]).toStrictEqual([0xaa, 0xbb, 0xcc]);
    expect([...padded.subarray(7)].every((byte) => byte === 0)).toBe(true);
  });

  it('rejects a padded buffer that is not a positive multiple of the block size', () => {
    expect(() => unpad(new Uint8Array(0))).toThrow(CorruptVaultError);
    expect(() => unpad(new Uint8Array(255))).toThrow(CorruptVaultError);
    expect(() => unpad(new Uint8Array(257))).toThrow(CorruptVaultError);
  });

  it('rejects a declared length longer than the buffer', () => {
    const padded = new Uint8Array(256);
    new DataView(padded.buffer).setUint32(0, 9999, true);
    expect(() => unpad(padded)).toThrow(CorruptVaultError);
  });

  it('reads the length from the view, not from the underlying buffer', () => {
    // Sealed payloads routinely arrive as a subarray of a larger buffer; a DataView constructed
    // without the byte offset would read someone else's bytes as the length.
    const backing = new Uint8Array(300);
    backing.fill(0xff, 0, 20);
    const padded = backing.subarray(20, 276);
    new DataView(padded.buffer, padded.byteOffset, padded.byteLength).setUint32(0, 4, true);
    padded.set([1, 2, 3, 4], 4);
    expect([...unpad(padded)]).toStrictEqual([1, 2, 3, 4]);
  });
});

describe('base64url', () => {
  it('round-trips random bytes at every residue of three', () => {
    for (let size = 0; size < 40; size++) {
      const data = randomBytes(size);
      expect(fromBase64Url(toBase64Url(data))).toStrictEqual(data);
    }
  });

  it('encodes the RFC 4648 test vectors, unpadded', () => {
    expect(toBase64Url(utf8(''))).toBe('');
    expect(toBase64Url(utf8('f'))).toBe('Zg');
    expect(toBase64Url(utf8('fo'))).toBe('Zm8');
    expect(toBase64Url(utf8('foo'))).toBe('Zm9v');
    expect(toBase64Url(utf8('foob'))).toBe('Zm9vYg');
    expect(toBase64Url(utf8('fooba'))).toBe('Zm9vYmE');
    expect(toBase64Url(utf8('foobar'))).toBe('Zm9vYmFy');
  });

  it('uses the URL-safe alphabet', () => {
    expect(toBase64Url(unhex('fbff'))).toBe('-_8');
    expect(hex(fromBase64Url('-_8'))).toBe('fbff');
  });

  it('accepts the standard alphabet and padding on the way in', () => {
    // Hand-edited backups and other tools emit these; refusing them would strand a recoverable file.
    expect(hex(fromBase64Url('+/8='))).toBe('fbff');
    expect(fromBase64Url('Zm9vYg==')).toStrictEqual(utf8('foob'));
  });

  it('rejects characters outside the alphabet', () => {
    for (const bad of ['Zm9v*', 'a b', 'Zm9é', '#']) {
      expect(() => fromBase64Url(bad)).toThrow(CorruptVaultError);
    }
  });

  it('rejects a non-zero partial byte rather than silently truncating it', () => {
    expect(() => fromBase64Url('Zh')).toThrow(CorruptVaultError);
    expect(fromBase64Url('Zg')).toStrictEqual(utf8('f'));
  });
});

describe('utf8', () => {
  it('round-trips text outside the BMP', () => {
    const text = 'bookmark — 北京 🔐';
    expect(utf8Decode(utf8(text))).toBe(text);
  });

  it('rejects malformed sequences instead of substituting U+FFFD', () => {
    // Silent replacement would turn a decryption bug into a quietly corrupted bookmark title.
    expect(() => utf8Decode(unhex('ff'))).toThrow(CorruptVaultError);
    expect(() => utf8Decode(unhex('c3'))).toThrow(CorruptVaultError);
  });
});

describe('concatBytes', () => {
  it('joins in order and handles the empty cases', () => {
    expect(concatBytes()).toStrictEqual(new Uint8Array(0));
    expect(concatBytes(new Uint8Array(0), new Uint8Array([1]))).toStrictEqual(new Uint8Array([1]));
    expect([...concatBytes(unhex('0102'), unhex('03'), unhex('0405'))]).toStrictEqual([
      1, 2, 3, 4, 5,
    ]);
  });
});
