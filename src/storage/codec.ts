/**
 * Bucket ⇄ sealed bytes (ARCHITECTURE §4.3, §4.4, §5.1).
 *
 * The write path is **canonical JSON → HMAC tag → gzip → pad → seal**, and the read path reverses
 * it. Three details are load-bearing:
 *
 * - **Canonical JSON.** Object keys are emitted in sorted order, so the same item set always
 *   produces the same bytes. Without that, an item rebuilt with its fields in a different order
 *   would hash differently, and the tag below would report a change that never happened — one
 *   wasted sync write per edit, forever.
 * - **The tag covers the plaintext, keyed.** `HMAC-SHA256(k_hmac, json)[0..8]` is what lets the
 *   sync layer skip a bucket whose contents did not change, even though its ciphertext changes
 *   completely on every seal (random IV). It is keyed rather than a plain digest precisely so an
 *   observer holding the synced blob cannot confirm a guessed bucket content offline (§3.1).
 * - **AAD binds the slot.** Bucket 7's ciphertext will not open as bucket 3, and a thumbnail will
 *   not open as a bucket.
 */

import {
  fromBase64Url,
  gunzip,
  gzip,
  pad,
  toBase64Url,
  unpad,
  utf8,
  utf8Decode,
  type Bytes,
} from '../crypto/codec.js';
import { open, seal, type Aad, type AadPurpose } from '../crypto/envelope.js';
import { assertHmacSha256, hmacSha256 } from '../crypto/hash.js';
import { CorruptVaultError } from '../crypto/errors.js';
import { canonicalJson } from '../vault/model.js';
import { SCHEMA_VERSION, type BucketPayload } from '../vault/types.js';
import type { RawPayload } from '../vault/migrate.js';

/** How much of the HMAC a bucket tag keeps. 64 bits is ample for a change detector. */
export const BUCKET_TAG_BYTES = 8;

/** A sealed bucket and the tag that describes what is inside it, for the header. */
export interface SealedBucket {
  readonly sealed: Bytes;
  readonly tag: string;
}

/** Seal one bucket for storage, and compute the header tag that goes with it. */
export async function sealBucket(
  itemsKey: CryptoKey,
  hmacKey: CryptoKey,
  index: number,
  payload: BucketPayload,
): Promise<SealedBucket> {
  const json = utf8(canonicalJson(payload));
  const tag = await bucketTagOf(hmacKey, json);
  const sealed = await seal(itemsKey, pad(await gzip(json)), bucketAad(index));
  return { sealed, tag };
}

/**
 * Open one bucket.
 *
 * The returned payload is **not** validated into `VaultItem`s here: a v1 → v2 migration reorders
 * siblings across the whole vault, so validation and migration belong to whoever has all the
 * buckets (`repo.ts`), not to whoever has one.
 */
export async function openBucket(
  itemsKey: CryptoKey,
  hmacKey: CryptoKey,
  index: number,
  sealed: Bytes,
  expectedTag?: string,
): Promise<RawPayload> {
  const json = await gunzip(unpad(await open(itemsKey, sealed, bucketAad(index))));
  if (expectedTag !== undefined && expectedTag !== '') {
    await assertHmacSha256(hmacKey, json, fromBase64Url(expectedTag));
  }
  return parseRawPayload(utf8Decode(json));
}

/** The header tag for a payload, without sealing it. Used to decide whether a write is needed. */
export async function bucketTag(hmacKey: CryptoKey, payload: BucketPayload): Promise<string> {
  return bucketTagOf(hmacKey, utf8(canonicalJson(payload)));
}

/**
 * Seal an arbitrary JSON value under a non-bucket purpose — the merge base (`vm.base`) today, the
 * portable export file in Phase 8.
 */
export async function sealJson(
  key: CryptoKey,
  purpose: Exclude<AadPurpose, 'bucket'>,
  id: string,
  value: unknown,
): Promise<Bytes> {
  const json = utf8(canonicalJson(value));
  return seal(key, pad(await gzip(json)), { v: SCHEMA_VERSION, purpose, id });
}

/** Open what {@link sealJson} wrote. The caller validates the shape it expects. */
export async function openJson(
  key: CryptoKey,
  purpose: Exclude<AadPurpose, 'bucket'>,
  id: string,
  sealed: Bytes,
): Promise<unknown> {
  const json = await gunzip(unpad(await open(key, sealed, { v: SCHEMA_VERSION, purpose, id })));
  return parseJson(utf8Decode(json));
}

/**
 * Seal opaque bytes — a processed thumbnail (§14), and nothing else so far.
 *
 * **Padded but not gzipped**, which is the one place this file departs from §4.4's
 * gzip → pad → seal. A WebP is already entropy-coded: deflating it spends CPU to grow the payload
 * by the size of a gzip header. The padding stays, because it is doing different work — it is what
 * keeps the stored length from being a fingerprint of the exact image (§4.4).
 */
export async function sealBytes(
  key: CryptoKey,
  purpose: Exclude<AadPurpose, 'bucket'>,
  id: string,
  bytes: Bytes,
): Promise<Bytes> {
  return seal(key, pad(bytes), { v: SCHEMA_VERSION, purpose, id });
}

/** Open what {@link sealBytes} wrote. */
export async function openBytes(
  key: CryptoKey,
  purpose: Exclude<AadPurpose, 'bucket'>,
  id: string,
  sealed: Bytes,
): Promise<Bytes> {
  return unpad(await open(key, sealed, { v: SCHEMA_VERSION, purpose, id }));
}

export { canonicalJson };

function bucketAad(index: number): Aad {
  return { v: SCHEMA_VERSION, purpose: 'bucket', id: String(index) };
}

async function bucketTagOf(hmacKey: CryptoKey, json: Bytes): Promise<string> {
  const mac = await hmacSha256(hmacKey, json);
  return toBase64Url(mac.subarray(0, BUCKET_TAG_BYTES));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    // The bytes authenticated, so this is our own malformed output rather than an attacker's —
    // but it is still not a vault we can read, and it must not escape as a raw SyntaxError.
    throw new CorruptVaultError('Decrypted vault payload is not valid JSON.', { cause });
  }
}

function parseRawPayload(text: string): RawPayload {
  const parsed = parseJson(text);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as RawPayload).items)
  ) {
    throw new CorruptVaultError('Decrypted bucket has no items array.');
  }
  return parsed as RawPayload;
}
