/**
 * The Drive file's own format.
 *
 * Everything that can be wrong with these bytes has to come back as `CorruptRemote`, because that
 * is the error the engine repairs by pushing its own copy — and because a file somebody opened and
 * edited by hand must not be reported to them as "your vault is damaged".
 */

import { describe, expect, it } from 'vitest';

import { toBase64Url, utf8 } from '../../../../src/crypto/codec.js';
import { CONTAINER_VERSION, decodeVault, encodeVault } from '../../../../src/sync/drive/container.js';
import { CorruptRemote } from '../../../../src/sync/provider.js';
import { VAULT_MAGIC, type EncryptedVault, type VaultHeader } from '../../../../src/vault/types.js';

const header: VaultHeader = {
  magic: VAULT_MAGIC,
  schemaVersion: 2,
  kdf: { alg: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: 'c2FsdA' },
  wrappedDek: { iv: 'aXY', ct: 'Y3Q' },
  vaultRev: 12,
  bucketCount: 2,
  buckets: [
    { i: 0, rev: 12, parts: 1, tag: 'tag0' },
    { i: 1, rev: 3, parts: 0, tag: 'tag1' },
  ],
  createdAt: 1,
  updatedAt: 2,
  deviceId: 'device',
};

const vault: EncryptedVault = {
  header,
  buckets: new Map([[0, new Uint8Array([1, 2, 3, 250])]]),
};

describe('the Drive container', () => {
  it('round-trips a vault', () => {
    const back = decodeVault(encodeVault(vault));
    expect(back.header).toEqual(header);
    expect([...(back.buckets.get(0) ?? [])]).toEqual([1, 2, 3, 250]);
    expect(back.buckets.has(1)).toBe(false);
  });

  it('is text a person can open, and says which container it is', () => {
    const text = new TextDecoder().decode(encodeVault(vault));
    expect(JSON.parse(text)).toMatchObject({ v: CONTAINER_VERSION });
    expect(text).toContain('VAULTAMARK');
  });

  it('rejects bytes that are not JSON', () => {
    expect(() => decodeVault(utf8('not json at all'))).toThrow(CorruptRemote);
  });

  it('rejects a container from a version we do not know', () => {
    expect(() => decodeVault(utf8(JSON.stringify({ v: 99, header, buckets: {} })))).toThrow(
      CorruptRemote,
    );
  });

  it('rejects a file with no readable header', () => {
    expect(() =>
      decodeVault(utf8(JSON.stringify({ v: CONTAINER_VERSION, header: { magic: 'nope' }, buckets: {} }))),
    ).toThrow(CorruptRemote);
  });

  it('rejects a bucket table that is not one', () => {
    expect(() =>
      decodeVault(utf8(JSON.stringify({ v: CONTAINER_VERSION, header, buckets: 'nope' }))),
    ).toThrow(CorruptRemote);
  });

  it('rejects a bucket that is not base64url', () => {
    expect(() =>
      decodeVault(
        utf8(JSON.stringify({ v: CONTAINER_VERSION, header, buckets: { '0': 'not base64!!' } })),
      ),
    ).toThrow(CorruptRemote);
  });

  it('rejects a bucket key that is not an index', () => {
    expect(() =>
      decodeVault(
        utf8(
          JSON.stringify({
            v: CONTAINER_VERSION,
            header,
            buckets: { nope: toBase64Url(new Uint8Array([1])) },
          }),
        ),
      ),
    ).toThrow(CorruptRemote);
  });

  it('rejects a truncated upload — a header promising a bucket the file does not carry', () => {
    expect(() =>
      decodeVault(utf8(JSON.stringify({ v: CONTAINER_VERSION, header, buckets: {} }))),
    ).toThrow(CorruptRemote);
  });

  it('rejects a file that is not an object at all', () => {
    expect(() => decodeVault(utf8('[]'))).toThrow(CorruptRemote);
    expect(() => decodeVault(utf8('null'))).toThrow(CorruptRemote);
  });
});
