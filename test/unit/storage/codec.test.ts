import { beforeAll, describe, expect, it } from 'vitest';

import { fromBase64Url } from '../../../src/crypto/codec.js';
import { CorruptVaultError } from '../../../src/crypto/errors.js';
import { generateDek, subkey } from '../../../src/crypto/keys.js';
import { seal } from '../../../src/crypto/envelope.js';
import {
  BUCKET_TAG_BYTES,
  bucketTag,
  canonicalJson,
  openBucket,
  openJson,
  sealBucket,
  sealJson,
} from '../../../src/storage/codec.js';
import { SCHEMA_VERSION, type BucketPayload } from '../../../src/vault/types.js';
import { flipBit } from '../../helpers/bytes.js';

let itemsKey: CryptoKey;
let hmacKey: CryptoKey;
let otherItemsKey: CryptoKey;

const PAYLOAD: BucketPayload = {
  items: [
    {
      id: 'a1',
      type: 'bookmark',
      parentId: 'root',
      title: 'Padding oracles, revisited',
      url: 'https://example.org/papers/padding',
      tags: ['crypto'],
      createdAt: 1,
      updatedAt: 2,
      order: 'a0',
      rev: 3,
    },
  ],
};

beforeAll(async () => {
  const dek = generateDek();
  itemsKey = await subkey(dek, 'items');
  hmacKey = await subkey(dek, 'hmac');
  otherItemsKey = await subkey(generateDek(), 'items');
});

describe('sealBucket / openBucket', () => {
  it('round-trips a payload', async () => {
    const { sealed, tag } = await sealBucket(itemsKey, hmacKey, 7, PAYLOAD);
    expect(await openBucket(itemsKey, hmacKey, 7, sealed, tag)).toEqual(PAYLOAD);
  });

  it('round-trips an empty payload', async () => {
    const { sealed, tag } = await sealBucket(itemsKey, hmacKey, 0, { items: [] });
    expect(await openBucket(itemsKey, hmacKey, 0, sealed, tag)).toEqual({ items: [] });
  });

  it('produces different ciphertext every time, because the IV is fresh', async () => {
    const first = await sealBucket(itemsKey, hmacKey, 7, PAYLOAD);
    const second = await sealBucket(itemsKey, hmacKey, 7, PAYLOAD);
    expect([...first.sealed]).not.toEqual([...second.sealed]);
    // …but the plaintext tag is stable, which is exactly what makes it a change detector.
    expect(first.tag).toBe(second.tag);
  });

  it('binds the bucket index, so a bucket cannot be replayed into another slot', async () => {
    const { sealed, tag } = await sealBucket(itemsKey, hmacKey, 7, PAYLOAD);
    await expect(openBucket(itemsKey, hmacKey, 3, sealed, tag)).rejects.toThrow(CorruptVaultError);
  });

  it('rejects a bucket sealed under a different key', async () => {
    const { sealed, tag } = await sealBucket(otherItemsKey, hmacKey, 7, PAYLOAD);
    await expect(openBucket(itemsKey, hmacKey, 7, sealed, tag)).rejects.toThrow(CorruptVaultError);
  });

  it('rejects a single flipped bit anywhere in the blob', async () => {
    const { sealed, tag } = await sealBucket(itemsKey, hmacKey, 7, PAYLOAD);
    for (const index of [0, 1, 6, 13, sealed.length - 1]) {
      await expect(
        openBucket(itemsKey, hmacKey, 7, flipBit(sealed, index), tag),
        `byte ${String(index)}`,
      ).rejects.toThrow(CorruptVaultError);
    }
  });

  it('rejects a tag that does not cover the plaintext', async () => {
    const { sealed } = await sealBucket(itemsKey, hmacKey, 7, PAYLOAD);
    const wrong = await bucketTag(hmacKey, { items: [] });
    await expect(openBucket(itemsKey, hmacKey, 7, sealed, wrong)).rejects.toThrow(
      CorruptVaultError,
    );
  });

  it('skips tag verification when the caller has no tag to check against', async () => {
    const { sealed } = await sealBucket(itemsKey, hmacKey, 7, PAYLOAD);
    expect(await openBucket(itemsKey, hmacKey, 7, sealed, '')).toEqual(PAYLOAD);
    expect(await openBucket(itemsKey, hmacKey, 7, sealed)).toEqual(PAYLOAD);
  });

  it('reports non-JSON plaintext as corruption rather than a raw SyntaxError', async () => {
    const { gzip, pad, utf8 } = await import('../../../src/crypto/codec.js');
    const sealed = await seal(itemsKey, pad(await gzip(utf8('not json'))), {
      v: SCHEMA_VERSION,
      purpose: 'bucket',
      id: '4',
    });
    await expect(openBucket(itemsKey, hmacKey, 4, sealed)).rejects.toThrow(CorruptVaultError);
  });

  it('rejects valid JSON that is not a bucket', async () => {
    const { gzip, pad, utf8 } = await import('../../../src/crypto/codec.js');
    for (const text of ['null', '"a string"', '{"nope":1}', '{"items":"not an array"}']) {
      const sealed = await seal(itemsKey, pad(await gzip(utf8(text))), {
        v: SCHEMA_VERSION,
        purpose: 'bucket',
        id: '4',
      });
      await expect(openBucket(itemsKey, hmacKey, 4, sealed), text).rejects.toThrow(
        CorruptVaultError,
      );
    }
  });
});

describe('bucketTag', () => {
  it('is a truncated HMAC of the canonical plaintext', async () => {
    const tag = await bucketTag(hmacKey, PAYLOAD);
    expect(fromBase64Url(tag)).toHaveLength(BUCKET_TAG_BYTES);
  });

  it('is keyed, not a plain digest — a guessed payload cannot be confirmed without k_hmac', async () => {
    const otherHmac = await subkey(generateDek(), 'hmac');
    expect(await bucketTag(hmacKey, PAYLOAD)).not.toBe(await bucketTag(otherHmac, PAYLOAD));
  });

  it('is insensitive to the key order of an item', async () => {
    const reordered: BucketPayload = {
      items: [Object.fromEntries(Object.entries(PAYLOAD.items[0]!).toReversed())] as never,
    };
    expect(await bucketTag(hmacKey, reordered)).toBe(await bucketTag(hmacKey, PAYLOAD));
  });

  it('changes when the contents change', async () => {
    const edited: BucketPayload = {
      items: [{ ...PAYLOAD.items[0]!, title: 'Something else' }],
    };
    expect(await bucketTag(hmacKey, edited)).not.toBe(await bucketTag(hmacKey, PAYLOAD));
  });
});

describe('sealJson / openJson', () => {
  it('round-trips the merge base', async () => {
    const value = { lastSyncedRev: 4, items: [{ id: 'a' }] };
    const sealed = await sealJson(itemsKey, 'base', '', value);
    expect(await openJson(itemsKey, 'base', '', sealed)).toEqual(value);
  });

  it('binds the purpose, so a base blob cannot be served as an export', async () => {
    const sealed = await sealJson(itemsKey, 'base', '', { a: 1 });
    await expect(openJson(itemsKey, 'export', '', sealed)).rejects.toThrow(CorruptVaultError);
  });

  it('will not open a bucket', async () => {
    const { sealed } = await sealBucket(itemsKey, hmacKey, 0, PAYLOAD);
    await expect(openJson(itemsKey, 'base', '', sealed)).rejects.toThrow(CorruptVaultError);
  });
});

describe('canonicalJson', () => {
  it('is re-exported so the storage layer and the model agree byte for byte', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
