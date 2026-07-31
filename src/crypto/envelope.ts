/**
 * The sealed-blob wire format (ARCHITECTURE §4.3).
 *
 * ```
 * byte 0        : format version (0x02)
 * bytes 1..12   : IV (96-bit, fresh per operation, from crypto.getRandomValues)
 * bytes 13..N   : AES-256-GCM ciphertext ‖ 128-bit tag
 * ```
 *
 * Every sealed value carries associated data — the canonical JSON `{ v, purpose, id }` — which is
 * authenticated but not encrypted. Binding it is what stops a bucket ciphertext being replayed into
 * a different bucket slot, or a thumbnail blob being served back as a bucket: the bytes decrypt
 * only against the exact slot they were written for.
 *
 * Random 96-bit IVs are safe here by a wide margin. GCM's birthday bound turns into a real concern
 * somewhere near 2^32 encryptions under one key; a heavy user commits on the order of 10^5 bucket
 * writes in a decade.
 */

import { CorruptVaultError } from './errors.js';
import { utf8, type Bytes } from './codec.js';

/** Version byte written at the head of every sealed blob. Matches `SCHEMA_VERSION` at v2. */
export const ENVELOPE_VERSION = 0x02;

/** AES-GCM nonce length, in bytes. 96 bits is the size GCM is specified and optimised for. */
export const IV_BYTES = 12;

/** AES-GCM authentication tag length, in bytes. */
export const TAG_BYTES = 16;

/** Bytes of framing a sealed blob adds on top of its plaintext. */
export const ENVELOPE_OVERHEAD_BYTES = 1 + IV_BYTES + TAG_BYTES;

/**
 * What a sealed blob is *for*. Kept as a closed union so a new kind of sealed value cannot be
 * introduced without a deliberate edit here — and therefore without a thought about whether it
 * needs its own HKDF subkey.
 */
export type AadPurpose = 'bucket' | 'thumb' | 'base' | 'export' | 'conflicts';

/**
 * The associated data bound to a sealed blob.
 *
 * `id` distinguishes slots within a purpose: the bucket index for `bucket`, the item id for
 * `thumb`, the empty string for the singletons (`base`, `export`, `conflicts`).
 */
export interface Aad {
  readonly v: number;
  readonly purpose: AadPurpose;
  readonly id: string;
}

/**
 * Canonical JSON encoding of the AAD.
 *
 * Rebuilt field by field rather than stringifying the caller's object, because JSON key order
 * follows insertion order — an AAD constructed with its fields in a different order would produce
 * different bytes and fail to authenticate a blob that is perfectly valid.
 */
export function aadBytes(aad: Aad): Bytes {
  return utf8(JSON.stringify({ v: aad.v, purpose: aad.purpose, id: aad.id }));
}

/** Encrypt and frame. The IV is generated here; callers never supply one. */
export async function seal(key: CryptoKey, plaintext: Bytes, aad: Aad): Promise<Bytes> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await gcmEncrypt(key, iv, plaintext, aadBytes(aad));

  const out = new Uint8Array(1 + IV_BYTES + ciphertext.length);
  out[0] = ENVELOPE_VERSION;
  out.set(iv, 1);
  out.set(ciphertext, 1 + IV_BYTES);
  return out;
}

/**
 * Unframe and decrypt.
 *
 * Throws {@link CorruptVaultError} for a wrong version byte, a truncated blob, a flipped bit
 * anywhere in the blob, or an AAD that does not match the one it was sealed with — all of which
 * mean the same thing to a caller: these are not the bytes we wrote.
 */
export async function open(key: CryptoKey, sealed: Bytes, aad: Aad): Promise<Bytes> {
  if (sealed.length < ENVELOPE_OVERHEAD_BYTES) {
    throw new CorruptVaultError(
      `Sealed blob is ${sealed.length} bytes, shorter than the ${ENVELOPE_OVERHEAD_BYTES} bytes of framing it must carry.`,
    );
  }
  const version = sealed[0];
  if (version !== ENVELOPE_VERSION) {
    throw new CorruptVaultError(`Unknown sealed-blob format version ${String(version)}.`);
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const ciphertext = sealed.subarray(1 + IV_BYTES);
  return gcmDecrypt(key, iv, ciphertext, aadBytes(aad));
}

/**
 * Raw AES-256-GCM encryption, with the AAD already encoded.
 *
 * Exported so the known-answer tests can drive NIST CAVP vectors — which pin an IV and a raw AAD —
 * through the same code path the product uses, rather than through `crypto.subtle` directly, where
 * a passing test would only prove the platform works. `wrapDek` also uses it: the header's
 * `wrappedDek` is a bare `{ iv, ct }` pair, not an envelope.
 */
export async function gcmEncrypt(
  key: CryptoKey,
  iv: Bytes,
  plaintext: Bytes,
  additionalData: Bytes,
): Promise<Bytes> {
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv,
    additionalData,
    tagLength: TAG_BYTES * 8,
  };
  return new Uint8Array(await crypto.subtle.encrypt(params, key, plaintext));
}

/** Raw AES-256-GCM decryption. A tag failure becomes {@link CorruptVaultError}. */
export async function gcmDecrypt(
  key: CryptoKey,
  iv: Bytes,
  ciphertext: Bytes,
  additionalData: Bytes,
): Promise<Bytes> {
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv,
    additionalData,
    tagLength: TAG_BYTES * 8,
  };
  try {
    return new Uint8Array(await crypto.subtle.decrypt(params, key, ciphertext));
  } catch (cause) {
    // WebCrypto deliberately reports every failure as an opaque OperationError: it will not tell
    // us whether the tag, the AAD or the key was wrong, and we must not guess — a caller that could
    // distinguish them would be a decryption oracle.
    throw new CorruptVaultError('Sealed data failed authentication.', { cause });
  }
}
