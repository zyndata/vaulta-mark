/**
 * Hashing and MAC primitives.
 *
 * `sha256` is used for content addressing (thumbnail dedupe, bucket assignment) and is *not* a
 * secret operation. `hmacSha256` is: bucket integrity tags are keyed with `k_hmac` precisely so an
 * observer holding a synced blob cannot confirm a guessed bucket content offline
 * (ARCHITECTURE §3.1).
 */

import type { Bytes } from './codec.js';
import { CorruptVaultError } from './errors.js';

/** SHA-256 of `data`. */
export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** HMAC-SHA-256 of `data` under an HKDF-derived `k_hmac` (see `subkey`). */
export async function hmacSha256(key: CryptoKey, data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/**
 * Verify an HMAC in constant time with respect to the tag bytes.
 *
 * Uses `equalBytes` rather than WebCrypto's `verify` because bucket tags are truncated
 * (ARCHITECTURE §3.1) and `verify` requires a full-length tag.
 */
export async function verifyHmacSha256(key: CryptoKey, data: Bytes, tag: Bytes): Promise<boolean> {
  const expected = (await hmacSha256(key, data)).subarray(0, tag.length);
  return equalBytes(expected, tag);
}

/**
 * Compare two byte arrays without an early exit.
 *
 * The comparison is constant-time in the *contents*; it is not, and cannot usefully be, constant
 * time in the *lengths*, which are public in every use we have. Never use `===` on arrays or a
 * loop with `break` to compare a MAC — a timing oracle on a tag comparison is a real forgery
 * primitive, and it is one line to avoid.
 */
export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0;
}

/** Assert an HMAC matches, throwing rather than returning a boolean a caller might ignore. */
export async function assertHmacSha256(key: CryptoKey, data: Bytes, tag: Bytes): Promise<void> {
  if (!(await verifyHmacSha256(key, data, tag))) {
    throw new CorruptVaultError('Integrity tag does not match the data it covers.');
  }
}
