import { describe, expect, it } from 'vitest';

import { fromBase64Url, toBase64Url, utf8 } from '../../../src/crypto/codec.js';
import { gcmDecrypt, gcmEncrypt, open, seal, type Aad } from '../../../src/crypto/envelope.js';
import { CorruptVaultError, WrongPasswordError } from '../../../src/crypto/errors.js';
import { hmacSha256 } from '../../../src/crypto/hash.js';
import {
  deriveKek,
  generateKdfSalt,
  KDF_ALGORITHM,
  MIN_KDF_ITERATIONS,
} from '../../../src/crypto/kdf.js';
import {
  DEK_BYTES,
  generateDek,
  hkdfSha256,
  subkey,
  SUBKEY_INFO_PREFIX,
  SUBKEY_PURPOSES,
  unwrapDek,
  wrapDek,
  type WrappedDek,
} from '../../../src/crypto/keys.js';
import hkdfVectors from '../../fixtures/hkdf-vectors.json';
import { flipBit, hex, randomBytes, unhex } from '../../helpers/bytes.js';

const FAST = { alg: KDF_ALGORITHM, iterations: MIN_KDF_ITERATIONS } as const;
const AAD: Aad = { v: 2, purpose: 'bucket', id: '0' };

describe('HKDF-SHA256 known-answer vectors', () => {
  for (const vector of hkdfVectors.sha256) {
    it(vector.name, async () => {
      const out = await hkdfSha256(
        unhex(vector.ikm),
        unhex(vector.salt),
        unhex(vector.info),
        vector.length,
      );
      expect(hex(out)).toBe(vector.okm);
    });
  }
});

describe('generateDek', () => {
  it('is 32 random bytes', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const dek = generateDek();
      expect(dek.length).toBe(DEK_BYTES);
      seen.add(hex(dek));
    }
    expect(seen.size).toBe(32);
  });
});

describe('wrapDek / unwrapDek', () => {
  it('round-trips the DEK through the header representation', async () => {
    const kek = await deriveKek('a master password', generateKdfSalt(), FAST);
    const dek = generateDek();
    const wrapped = await wrapDek(kek, dek);

    expect(fromBase64Url(wrapped.iv).length).toBe(12);
    expect(fromBase64Url(wrapped.ct).length).toBe(DEK_BYTES + 16);
    expect(await unwrapDek(kek, wrapped)).toStrictEqual(dek);
  });

  it('uses a fresh IV, so re-wrapping the same DEK never produces the same header bytes', async () => {
    const kek = await deriveKek('a master password', generateKdfSalt(), FAST);
    const dek = generateDek();
    const first = await wrapDek(kek, dek);
    const second = await wrapDek(kek, dek);
    expect(second.iv).not.toBe(first.iv);
    expect(second.ct).not.toBe(first.ct);
    expect(await unwrapDek(kek, second)).toStrictEqual(dek);
  });

  it('is the password check: a wrong password throws WrongPasswordError and returns nothing', async () => {
    // D12 — there is no verifier blob. A failed GCM tag on this one operation *is* the statement
    // "that password was wrong", which is why no other code path is allowed to make that claim.
    const salt = generateKdfSalt();
    const dek = generateDek();
    const wrapped = await wrapDek(await deriveKek('the right password', salt, FAST), dek);

    const wrongKek = await deriveKek('the wrong password', salt, FAST);
    await expect(unwrapDek(wrongKek, wrapped)).rejects.toThrow(WrongPasswordError);
  });

  it('does not mistake a damaged header for a wrong password', async () => {
    // Telling a user their password is wrong when their vault is actually damaged sends them to
    // retype it forever instead of to their backup.
    const kek = await deriveKek('a master password', generateKdfSalt(), FAST);
    const wrapped = await wrapDek(kek, generateDek());

    const malformed: WrappedDek[] = [
      { ...wrapped, iv: toBase64Url(randomBytes(11)) },
      { ...wrapped, iv: toBase64Url(randomBytes(13)) },
      { ...wrapped, iv: '' },
      { ...wrapped, ct: toBase64Url(randomBytes(47)) },
      { ...wrapped, ct: toBase64Url(randomBytes(49)) },
      { ...wrapped, ct: '' },
      { ...wrapped, iv: 'not base64url!' },
      { ...wrapped, ct: 'also not base64url!' },
    ];
    for (const candidate of malformed) {
      const error = await unwrapDek(kek, candidate).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(CorruptVaultError);
      expect(error).not.toBeInstanceOf(WrongPasswordError);
    }
  });

  it('detects a tampered ciphertext with the right password', async () => {
    const kek = await deriveKek('a master password', generateKdfSalt(), FAST);
    const wrapped = await wrapDek(kek, generateDek());
    const ct = flipBit(fromBase64Url(wrapped.ct), 0);
    await expect(unwrapDek(kek, { ...wrapped, ct: toBase64Url(ct) })).rejects.toThrow(
      WrongPasswordError,
    );
  });

  it('refuses to wrap something that is not a 256-bit key', async () => {
    const kek = await deriveKek('a master password', generateKdfSalt(), FAST);
    for (const length of [0, 16, 31, 33, 64]) {
      await expect(wrapDek(kek, new Uint8Array(length))).rejects.toThrow(CorruptVaultError);
    }
  });

  it('survives a password change by re-wrapping 32 bytes and nothing else', async () => {
    // The whole reason for a two-level hierarchy (ARCHITECTURE §4.1): the vault's sealed content is
    // untouched by a password change, so there is no re-encryption and no sync storm.
    const salt = generateKdfSalt();
    const dek = generateDek();
    const itemsKey = await subkey(dek, 'items');
    const sealed = await seal(itemsKey, utf8('a bucket full of bookmarks'), AAD);

    const wrapped = await wrapDek(await deriveKek('old password', salt, FAST), dek);
    const unwrapped = await unwrapDek(await deriveKek('old password', salt, FAST), wrapped);

    const newSalt = generateKdfSalt();
    const rewrapped = await wrapDek(await deriveKek('new password', newSalt, FAST), unwrapped);
    const recovered = await unwrapDek(await deriveKek('new password', newSalt, FAST), rewrapped);

    expect(recovered).toStrictEqual(dek);
    expect(await open(await subkey(recovered, 'items'), sealed, AAD)).toStrictEqual(
      utf8('a bucket full of bookmarks'),
    );
  });
});

describe('subkey', () => {
  it('derives exactly the HKDF output the spec names', async () => {
    const dek = generateDek();
    const expected = await hkdfSha256(
      dek,
      new Uint8Array(32),
      utf8(`${SUBKEY_INFO_PREFIX}items`),
      32,
    );
    const imported = await crypto.subtle.importKey('raw', expected, 'AES-GCM', false, ['decrypt']);

    const iv = randomBytes(12);
    const ciphertext = await gcmEncrypt(
      await subkey(dek, 'items'),
      iv,
      utf8('x'),
      new Uint8Array(0),
    );
    expect(await gcmDecrypt(imported, iv, ciphertext, new Uint8Array(0))).toStrictEqual(utf8('x'));
  });

  it('carries the schema version, so a v3 vault gets different subkeys from the same DEK', () => {
    expect(SUBKEY_INFO_PREFIX).toBe('vaultamark/v2/');
  });

  it('is deterministic: the same DEK and purpose open what the last derivation sealed', async () => {
    const dek = generateDek();
    const sealed = await seal(await subkey(dek, 'items'), utf8('bookmark payload'), AAD);
    expect(await open(await subkey(dek, 'items'), sealed, AAD)).toStrictEqual(
      utf8('bookmark payload'),
    );
  });

  it('gives every purpose a different key', async () => {
    // No key is ever used for two purposes, so a weakness in the thumbnail path cannot become an
    // oracle against the item path.
    const dek = generateDek();
    const sealed = await seal(await subkey(dek, 'items'), utf8('bookmark payload'), AAD);
    await expect(open(await subkey(dek, 'thumbs'), sealed, AAD)).rejects.toThrow(CorruptVaultError);
  });

  it('gives a different DEK a different key', async () => {
    const sealed = await seal(await subkey(generateDek(), 'items'), utf8('payload'), AAD);
    await expect(open(await subkey(generateDek(), 'items'), sealed, AAD)).rejects.toThrow(
      CorruptVaultError,
    );
  });

  it('derives a signing key for bucket tags, deterministically', async () => {
    const dek = generateDek();
    const data = utf8('bucket plaintext');
    const first = await hmacSha256(await subkey(dek, 'hmac'), data);
    const second = await hmacSha256(await subkey(dek, 'hmac'), data);

    expect(first).toStrictEqual(second);
    expect(first.length).toBe(32);
    expect(hex(await hmacSha256(await subkey(generateDek(), 'hmac'), data))).not.toBe(hex(first));
  });

  it('produces non-extractable keys with only the usages their purpose needs', async () => {
    const dek = generateDek();
    // `icons` sits with `hmac`: it names a stored favicon rather than encrypting one (§10.1), so it
    // is a MAC key, and the bytes it names are sealed under `thumbs`.
    const macs = new Set(['hmac', 'icons']);
    for (const purpose of SUBKEY_PURPOSES) {
      const key = await subkey(dek, purpose);
      expect(key.extractable).toBe(false);
      expect([...key.usages].sort()).toStrictEqual(
        macs.has(purpose) ? ['sign', 'verify'] : ['decrypt', 'encrypt'],
      );
      expect(key.algorithm.name).toBe(macs.has(purpose) ? 'HMAC' : 'AES-GCM');
    }
  });

  it('gives every purpose a different key, icons included', async () => {
    const dek = generateDek();
    const data = utf8('github.com');
    const asIcons = hex(await hmacSha256(await subkey(dek, 'icons'), data));
    const asHmac = hex(await hmacSha256(await subkey(dek, 'hmac'), data));
    // The two MAC keys must not be the same key: bucket tags are published in the plaintext header,
    // so a shared key would let anyone holding a synced vault confirm a guessed host from it.
    expect(asIcons).not.toBe(asHmac);
  });

  it('refuses a DEK of the wrong length', async () => {
    for (const length of [0, 16, 31, 33]) {
      await expect(subkey(new Uint8Array(length), 'items')).rejects.toThrow(CorruptVaultError);
    }
  });
});
