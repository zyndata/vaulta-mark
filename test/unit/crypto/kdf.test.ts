import { describe, expect, it } from 'vitest';

import { utf8 } from '../../../src/crypto/codec.js';
import { gcmDecrypt, gcmEncrypt } from '../../../src/crypto/envelope.js';
import { CorruptVaultError } from '../../../src/crypto/errors.js';
import {
  deriveKek,
  generateKdfSalt,
  KDF_ALGORITHM,
  KDF_SALT_BYTES,
  KEK_BYTES,
  MIN_KDF_ITERATIONS,
  pbkdf2Sha256,
  RECOMMENDED_KDF_PARAMS,
  type KdfParams,
} from '../../../src/crypto/kdf.js';
import vectors from '../../fixtures/kdf-vectors.json';
import { hex, randomBytes } from '../../helpers/bytes.js';

/** Cheap parameters for tests that are about behaviour rather than about cost. */
const FAST: KdfParams = { alg: KDF_ALGORITHM, iterations: MIN_KDF_ITERATIONS };

describe('PBKDF2-HMAC-SHA256 known-answer vectors', () => {
  for (const vector of vectors.sha256) {
    it(`c=${vector.c}, dkLen=${vector.dkLen}`, async () => {
      const out = await pbkdf2Sha256(vector.p, utf8(vector.s), vector.c, vector.dkLen);
      expect(hex(out)).toBe(vector.dk);
    });
  }

  it('handles an embedded NUL in the password and the salt', async () => {
    const vector = vectors.sha256.find((candidate) => candidate.p.includes(String.fromCharCode(0)));
    if (!vector) throw new Error('fixture has no NUL vector');
    // A password field can contain anything a keyboard or a paste can produce; a byte-length
    // shortcut that stops at a NUL would silently truncate the user's password to "pass".
    expect(hex(await pbkdf2Sha256(vector.p, utf8(vector.s), vector.c, vector.dkLen))).toBe(
      vector.dk,
    );
  });
});

describe('the platform PBKDF2 we build on', () => {
  // RFC 6070's vectors are SHA-1, which we ship nowhere. They run against WebCrypto directly, as a
  // sanity check on the primitive the whole key hierarchy rests on.
  for (const vector of vectors.rfc6070Sha1) {
    it(`RFC 6070 c=${vector.c}, dkLen=${vector.dkLen}`, async () => {
      const key = await crypto.subtle.importKey('raw', utf8(vector.p), 'PBKDF2', false, [
        'deriveBits',
      ]);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-1', salt: utf8(vector.s), iterations: vector.c },
        key,
        vector.dkLen * 8,
      );
      expect(hex(new Uint8Array(bits))).toBe(vector.dk);
    });
  }
});

describe('deriveKek', () => {
  it('produces the same key material as the raw primitive', async () => {
    // `deriveKek` returns a non-extractable key, so it cannot be compared byte-for-byte. Instead:
    // seal with the derived key, open with a key imported from the KAT-verified bits. Success means
    // they are the same 256 bits.
    const salt = generateKdfSalt();
    const kek = await deriveKek('correct horse battery staple', salt, FAST);
    const bits = await pbkdf2Sha256(
      'correct horse battery staple',
      salt,
      FAST.iterations,
      KEK_BYTES,
    );
    const imported = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['decrypt']);

    const iv = randomBytes(12);
    const sealed = await gcmEncrypt(kek, iv, utf8('payload'), new Uint8Array(0));
    expect(await gcmDecrypt(imported, iv, sealed, new Uint8Array(0))).toStrictEqual(
      utf8('payload'),
    );
  });

  it('is non-extractable and carries exactly the usages the DEK needs', async () => {
    const kek = await deriveKek('correct horse battery staple', generateKdfSalt(), FAST);
    expect(kek.extractable).toBe(false);
    expect(kek.algorithm).toMatchObject({ name: 'AES-GCM', length: KEK_BYTES * 8 });
    expect([...kek.usages].sort()).toStrictEqual(['decrypt', 'encrypt', 'unwrapKey', 'wrapKey']);
    await expect(crypto.subtle.exportKey('raw', kek)).rejects.toThrow();
  });

  it('is a pure function of password, salt and iteration count', async () => {
    const salt = generateKdfSalt();
    const other = generateKdfSalt();
    const iv = randomBytes(12);
    const sealWith = async (key: CryptoKey) =>
      hex(await gcmEncrypt(key, iv, utf8('x'), new Uint8Array(0)));

    const baseline = await sealWith(await deriveKek('password-one', salt, FAST));
    expect(await sealWith(await deriveKek('password-one', salt, FAST))).toBe(baseline);
    expect(await sealWith(await deriveKek('password-two', salt, FAST))).not.toBe(baseline);
    expect(await sealWith(await deriveKek('password-one', other, FAST))).not.toBe(baseline);
    expect(
      await sealWith(
        await deriveKek('password-one', salt, { ...FAST, iterations: FAST.iterations + 1 }),
      ),
    ).not.toBe(baseline);
  });
});

describe('deriveKek rejects parameters it will not derive against', () => {
  it('refuses an unknown algorithm', async () => {
    const params = { alg: 'scrypt', iterations: 600_000 } as unknown as KdfParams;
    await expect(deriveKek('password', generateKdfSalt(), params)).rejects.toThrow(
      CorruptVaultError,
    );
  });

  it('refuses an iteration count below the floor', async () => {
    // An imported vault built by something else with a cheap KDF would leave the user weakly
    // protected while every screen said "unlocked". Refusing is the only honest response.
    for (const iterations of [0, 1, 1000, MIN_KDF_ITERATIONS - 1, -600_000, 1.5, Number.NaN]) {
      await expect(
        deriveKek('password', generateKdfSalt(), { alg: KDF_ALGORITHM, iterations }),
      ).rejects.toThrow(CorruptVaultError);
    }
  });

  it('refuses a salt of the wrong length', async () => {
    for (const length of [0, 16, 31, 33]) {
      await expect(deriveKek('password', new Uint8Array(length), FAST)).rejects.toThrow(
        CorruptVaultError,
      );
    }
  });
});

describe('generateKdfSalt', () => {
  it('is 32 bytes and does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const salt = generateKdfSalt();
      expect(salt.length).toBe(KDF_SALT_BYTES);
      seen.add(hex(salt));
    }
    expect(seen.size).toBe(64);
  });
});

describe('the shipped parameters', () => {
  it('are the OWASP floor for PBKDF2-SHA256, read from the header and never hard-coded', () => {
    expect(RECOMMENDED_KDF_PARAMS).toStrictEqual({ alg: KDF_ALGORITHM, iterations: 600_000 });
    expect(RECOMMENDED_KDF_PARAMS.iterations).toBeGreaterThanOrEqual(MIN_KDF_ITERATIONS);
  });

  it.skipIf(Boolean(process.env['CI_SLOW']))(
    'derives at the real iteration count in under 3 seconds',
    async () => {
      // This is the unlock latency a user feels. If it regresses past a few hundred milliseconds on
      // developer hardware, the parameters need revisiting — not the test.
      const started = performance.now();
      await deriveKek('a realistic master password', generateKdfSalt(), RECOMMENDED_KDF_PARAMS);
      expect(performance.now() - started).toBeLessThan(3000);
    },
    10_000,
  );
});
