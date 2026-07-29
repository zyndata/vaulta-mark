/**
 * The DEK and its HKDF subkeys — the middle and bottom of the key hierarchy (ARCHITECTURE §4.1).
 *
 * ```
 * KEK  ──AES-256-GCM unwrap──►  DEK  ──HKDF-SHA256──►  k_items | k_thumbs | k_hmac
 * ```
 *
 * **Why two levels.** Changing the master password re-derives the KEK and re-wraps 32 bytes.
 * Nothing else moves: no re-encryption of the vault, no sync storm, no window in which the vault is
 * half-converted.
 *
 * **Why HKDF subkeys.** No key is ever used for two purposes, so a hypothetical weakness in the
 * thumbnail path cannot be turned into an oracle against the item path.
 *
 * **Why the DEK is bytes and not a `CryptoKey`.** MV3 kills the service worker every ~30 seconds,
 * so the unlocked DEK has to survive in `chrome.storage.session` (D14) — and a `CryptoKey` does not
 * serialise into it. The DEK therefore exists as a byte array that callers are expected to
 * zero on lock; see `wipe.ts` for exactly how much that is and is not worth.
 */

import { CorruptVaultError, WrongPasswordError } from './errors.js';
import { fromBase64Url, toBase64Url, utf8, type Bytes } from './codec.js';
import { gcmDecrypt, gcmEncrypt, IV_BYTES, TAG_BYTES } from './envelope.js';
import { zero } from './wipe.js';

/** DEK length, in bytes. */
export const DEK_BYTES = 32;

/** The purposes that get their own key. Adding one means adding an entry here, deliberately. */
export const SUBKEY_PURPOSES = ['items', 'thumbs', 'hmac'] as const;

export type SubkeyPurpose = (typeof SUBKEY_PURPOSES)[number];

/**
 * HKDF `info` prefix. Carries the schema version so a v3 vault derives entirely different subkeys
 * from the same DEK — domain separation across format versions, for free.
 */
export const SUBKEY_INFO_PREFIX = 'vaultamark/v2/';

/** HKDF salt: 32 zero bytes. Fixed and public; the DEK is already uniformly random, so a salt adds
 * nothing here, and fixing it keeps subkey derivation reproducible from the DEK alone. */
const HKDF_SALT = new Uint8Array(32);

/**
 * The wrapped DEK exactly as it sits in the plaintext vault header (ARCHITECTURE §3.1): a bare
 * `{ iv, ct }` pair, base64url, **not** an envelope. It predates knowing the key, so it cannot
 * carry the envelope's AAD, and its shape is fixed by the header format.
 */
export interface WrappedDek {
  readonly iv: string;
  readonly ct: string;
}

/** A fresh random DEK. Generated once at vault creation and unchanged for the vault's lifetime. */
export function generateDek(): Bytes {
  return crypto.getRandomValues(new Uint8Array(DEK_BYTES));
}

/** Wrap the DEK under the KEK for storage in the header. Fresh IV every call. */
export async function wrapDek(kek: CryptoKey, dek: Bytes): Promise<WrappedDek> {
  if (dek.length !== DEK_BYTES) {
    throw new CorruptVaultError(`DEK is ${dek.length} bytes, expected ${DEK_BYTES}.`);
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await gcmEncrypt(kek, iv, dek, EMPTY_AAD);
  return { iv: toBase64Url(iv), ct: toBase64Url(ct) };
}

/**
 * Unwrap the DEK. **This is the password check.**
 *
 * There is no verifier blob in the vault (D12) — one less oracle and one less thing to store — so a
 * failed GCM tag on this one operation is exactly the statement "that password was wrong". The
 * distinction is drawn carefully: structurally invalid header bytes throw `CorruptVaultError`,
 * because a truncated header says nothing at all about the password, and telling a user their
 * password is wrong when their vault is damaged sends them down the wrong path entirely.
 */
export async function unwrapDek(kek: CryptoKey, wrapped: WrappedDek): Promise<Bytes> {
  const iv = fromBase64Url(wrapped.iv);
  const ct = fromBase64Url(wrapped.ct);
  if (iv.length !== IV_BYTES) {
    throw new CorruptVaultError(`Wrapped DEK has a ${iv.length}-byte IV, expected ${IV_BYTES}.`);
  }
  if (ct.length !== DEK_BYTES + TAG_BYTES) {
    throw new CorruptVaultError(
      `Wrapped DEK is ${ct.length} bytes, expected ${DEK_BYTES + TAG_BYTES}.`,
    );
  }

  let dek: Bytes;
  try {
    dek = await gcmDecrypt(kek, iv, ct, EMPTY_AAD);
  } catch (cause) {
    throw new WrongPasswordError(undefined, { cause });
  }

  // Cannot happen with an authenticated 48-byte ciphertext, but the length of the DEK is load-
  // bearing for everything below it and is worth one comparison.
  if (dek.length !== DEK_BYTES) {
    zero(dek);
    throw new CorruptVaultError(`Unwrapped DEK is ${dek.length} bytes, expected ${DEK_BYTES}.`);
  }
  return dek;
}

/**
 * Derive a purpose-specific subkey from the DEK.
 *
 * Deterministic: the same DEK and purpose always give the same key, which is what lets a vault be
 * read on any device from the DEK alone. The returned key is non-extractable, and the raw bits it
 * was imported from are zeroed before this resolves.
 */
export async function subkey(dek: Bytes, purpose: SubkeyPurpose): Promise<CryptoKey> {
  if (dek.length !== DEK_BYTES) {
    throw new CorruptVaultError(`DEK is ${dek.length} bytes, expected ${DEK_BYTES}.`);
  }
  const bits = await hkdfSha256(dek, HKDF_SALT, utf8(SUBKEY_INFO_PREFIX + purpose), 32);
  try {
    return purpose === 'hmac'
      ? await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, [
          'sign',
          'verify',
        ])
      : await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, [
          'encrypt',
          'decrypt',
        ]);
  } finally {
    zero(bits);
  }
}

/**
 * HKDF-SHA256 (RFC 5869), extract-and-expand in one call.
 *
 * Exported so {@link subkey} has a known-answer test against the RFC's vectors — the subkey path
 * pins its own salt and info, so the vectors cannot be driven through it directly.
 */
export async function hkdfSha256(
  ikm: Bytes,
  salt: Bytes,
  info: Bytes,
  lengthBytes: number,
): Promise<Bytes> {
  const baseKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/** The wrapped DEK has no associated data — see {@link WrappedDek}. */
const EMPTY_AAD = new Uint8Array(0);
