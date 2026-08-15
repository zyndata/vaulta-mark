/**
 * Password → KEK. The first and slowest step of the key hierarchy (ARCHITECTURE §4.1, §4.2).
 *
 * PBKDF2-HMAC-SHA256 at 600,000 iterations, not Argon2id: the only practical route to a memory-hard
 * KDF under MV3 is a WASM build, and WASM needs `'wasm-unsafe-eval'` in the CSP. Trading a
 * documented, CI-enforced CSP for a KDF upgrade is a bad deal against a threat model whose primary
 * adversary is a person with access to a device, not a cracking cluster (D9).
 *
 * Parameters are **always read from the vault header** and passed in. Nothing here is hard-coded at
 * a call site, so raising the iteration count later is a header change plus a re-wrap of 32 bytes,
 * not a format break.
 */

import { CorruptVaultError } from './errors.js';
import { utf8, type Bytes } from './codec.js';
import { zero } from './wipe.js';

/** The only KDF this schema version knows. Versioned so a future one can be added, not swapped. */
export const KDF_ALGORITHM = 'PBKDF2-HMAC-SHA256';

/** KDF parameters as they appear in the vault header. The salt travels separately, as base64url. */
export interface KdfParams {
  readonly alg: typeof KDF_ALGORITHM;
  readonly iterations: number;
}

/** What a vault created by this build gets. OWASP's 2023 floor for PBKDF2-SHA256. */
export const RECOMMENDED_KDF_PARAMS: KdfParams = {
  alg: KDF_ALGORITHM,
  iterations: 600_000,
};

/**
 * Iteration floor we are willing to *read*.
 *
 * A header is plaintext, so anyone with the vault file can rewrite it — but lowering the count does
 * not help an attacker, since the DEK was wrapped under the original KEK and will simply fail to
 * unwrap. The case this actually guards is an imported vault built by something else with an
 * indefensibly cheap KDF, which would leave the user weakly protected while everything appeared to
 * work. Below this we refuse rather than quietly downgrade the user's security.
 */
export const MIN_KDF_ITERATIONS = 100_000;

/** Salt length, in bytes. Random per vault, stored in the header. */
export const KDF_SALT_BYTES = 32;

/** KEK length, in bytes. */
export const KEK_BYTES = 32;

/** A fresh 32-byte KDF salt. One per vault, generated at creation and never reused. */
export function generateKdfSalt(): Bytes {
  return crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES));
}

/**
 * Derive the key-encryption key from the master password.
 *
 * The result is **non-extractable**: the raw KEK never exists as JavaScript-reachable bytes, which
 * is the one place in the hierarchy where we can have that property for free. It carries
 * `wrapKey`/`unwrapKey` alongside `encrypt`/`decrypt` because the KEK's entire job is the DEK
 * (`keys.ts`), and both spellings of that operation stay available to it.
 */
export async function deriveKek(
  password: string,
  salt: Bytes,
  params: KdfParams,
): Promise<CryptoKey> {
  assertUsableParams(params, salt);

  const passwordKey = await importPasswordKey(password);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: params.iterations },
    passwordKey,
    { name: 'AES-GCM', length: KEK_BYTES * 8 },
    false,
    ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt'],
  );
}

/**
 * Raw PBKDF2-HMAC-SHA256 output.
 *
 * Exists so the KDF has a real known-answer test against pinned vectors — `deriveKek` returns a
 * non-extractable key by design, and a KAT cannot look inside one. Nothing in `src/` outside this
 * file should call it; use {@link deriveKek}.
 */
export async function pbkdf2Sha256(
  password: string,
  salt: Bytes,
  iterations: number,
  lengthBytes: number,
): Promise<Bytes> {
  const passwordKey = await importPasswordKey(password);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    passwordKey,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/** Reject header parameters we will not derive against. */
function assertUsableParams(params: KdfParams, salt: Bytes): void {
  // Widened deliberately: `params` is typed as if it were ours, but it was parsed out of a
  // plaintext header on disk, where the type system has no jurisdiction.
  const alg: string = params.alg;
  if (alg !== KDF_ALGORITHM) {
    throw new CorruptVaultError(`Unsupported key-derivation algorithm ${alg}.`);
  }
  if (!Number.isSafeInteger(params.iterations) || params.iterations < MIN_KDF_ITERATIONS) {
    throw new CorruptVaultError(
      `Vault declares ${String(params.iterations)} KDF iterations, below the ${MIN_KDF_ITERATIONS} floor.`,
    );
  }
  if (salt.length !== KDF_SALT_BYTES) {
    throw new CorruptVaultError(`KDF salt is ${salt.length} bytes, expected ${KDF_SALT_BYTES}.`);
  }
}

/**
 * Import the password as PBKDF2 key material.
 *
 * The password arrives as a `string` because that is what an `<input>` gives us, and we cannot undo
 * that: the engine may already have copied it. We zero the UTF-8 encoding we control and leave the
 * limitation stated rather than implied (ARCHITECTURE §4.5).
 */
async function importPasswordKey(password: string): Promise<CryptoKey> {
  const bytes = utf8(password);
  try {
    return await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, [
      'deriveKey',
      'deriveBits',
    ]);
  } finally {
    zero(bytes);
  }
}
