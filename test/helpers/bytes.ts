/** Byte helpers shared by the crypto suites. Test-only — nothing here ships. */

import type { Bytes } from '../../src/crypto/codec.js';

/** Hex string → bytes. Accepts the empty string. */
export function unhex(hexText: string): Bytes {
  const out = new Uint8Array(hexText.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hexText.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Bytes → lowercase hex. */
export function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Cryptographically random bytes, for round-trip and property tests. */
export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length);
  // getRandomValues caps at 65536 bytes per call.
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + 65536, length)));
  }
  return out;
}

/**
 * Bytes that compress well, so a round-trip test exercises gzip doing actual work rather than
 * gzip's incompressible-input escape hatch.
 */
export function compressibleBytes(length: number): Bytes {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i % 17) + 0x61;
  return out;
}

/** A copy of `bytes` with one bit flipped. The tamper tests are built entirely out of this. */
export function flipBit(bytes: Bytes, index: number, bit = 0): Bytes {
  const out = Uint8Array.from(bytes);
  out[index] = (out[index] ?? 0) ^ (1 << bit);
  return out;
}
