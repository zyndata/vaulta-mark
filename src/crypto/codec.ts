/**
 * Byte-level transforms that sit either side of encryption: gzip, length-hiding padding, and the
 * base64url used wherever ciphertext has to live in a JSON value.
 *
 * The write order is **gzip → pad → seal** (ARCHITECTURE §4.4). Padding comes after compression
 * because padding first would simply be compressed away, taking the side-channel mitigation with
 * it. Reading reverses the order.
 *
 * Nothing here is secret-dependent: no branch and no table lookup in this file depends on key
 * material, so the absence of constant-time care is deliberate and safe. Constant-time comparison
 * lives in `hash.ts`.
 */

import { CorruptVaultError } from './errors.js';

/**
 * A byte buffer backed by a plain `ArrayBuffer` — the currency of this whole module.
 *
 * Bare `Uint8Array` means `Uint8Array<ArrayBufferLike>`, which includes `SharedArrayBuffer` and is
 * therefore not something WebCrypto will accept as a `BufferSource`. We never produce a shared
 * buffer — that needs cross-origin isolation, which an extension page does not have — so naming the
 * narrower type once is more honest than casting at every `crypto.subtle` call.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * Padded plaintext is a multiple of this many bytes. Coarsens the length side-channel: an observer
 * of a sealed bucket learns "about 1.75 KB", not "exactly a 47-character URL". 256 costs at most
 * 255 wasted bytes per bucket, which is noise next to `chrome.storage.sync`'s 8 KB item quota.
 */
export const PAD_BLOCK_BYTES = 256;

/** The 4-byte little-endian payload length that precedes the padded bytes. */
const LENGTH_PREFIX_BYTES = 4;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 encode. Separate from `TextEncoder` at call sites so the encoder is allocated once. */
export function utf8(text: string): Bytes {
  return utf8Encoder.encode(text);
}

/**
 * UTF-8 decode, strictly: malformed sequences throw rather than yielding U+FFFD. Decrypted vault
 * bytes that are not valid UTF-8 mean the plaintext is wrong, and silently substituting a
 * replacement character would turn that into a corrupted bookmark instead of a loud failure.
 */
export function utf8Decode(bytes: Bytes): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch (cause) {
    throw new CorruptVaultError('Decrypted bytes are not valid UTF-8.', { cause });
  }
}

/** gzip, via the platform's `CompressionStream` — no dependency, no WASM. */
export async function gzip(data: Bytes): Promise<Bytes> {
  return pump(new CompressionStream('gzip'), data);
}

/**
 * gunzip. Input is always something we sealed and authenticated first, so a failure here means the
 * plaintext itself is malformed rather than that an attacker fed us a zip bomb — but it is still
 * reported as corruption rather than allowed to escape as a raw `TypeError`.
 */
export async function gunzip(data: Bytes): Promise<Bytes> {
  try {
    return await pump(new DecompressionStream('gzip'), data);
  } catch (cause) {
    throw new CorruptVaultError('Vault payload is not valid gzip data.', { cause });
  }
}

/**
 * Prepend a 4-byte little-endian length and zero-fill to the next {@link PAD_BLOCK_BYTES} boundary.
 *
 * A payload whose length is already exactly on a boundary is left as-is rather than given a whole
 * extra block: the boundary case leaks that the length is a multiple of 256, which is a far smaller
 * signal than the 8 bytes per bucket that the alternative would cost across a synced vault.
 */
export function pad(data: Bytes): Bytes {
  const framed = LENGTH_PREFIX_BYTES + data.length;
  const total = Math.ceil(framed / PAD_BLOCK_BYTES) * PAD_BLOCK_BYTES;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, data.length, true);
  out.set(data, LENGTH_PREFIX_BYTES);
  return out;
}

/** Reverse {@link pad}. Every structural expectation is checked; violations are corruption. */
export function unpad(padded: Bytes): Bytes {
  if (padded.length === 0 || padded.length % PAD_BLOCK_BYTES !== 0) {
    throw new CorruptVaultError(
      `Padded payload is ${padded.length} bytes, not a positive multiple of ${PAD_BLOCK_BYTES}.`,
    );
  }
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(
    0,
    true,
  );
  if (LENGTH_PREFIX_BYTES + length > padded.length) {
    throw new CorruptVaultError('Padded payload declares a length longer than the payload itself.');
  }
  return padded.slice(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length);
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url encode, unpadded (RFC 4648 §5). Safe in JSON, in URLs, and in storage keys. */
export function toBase64Url(bytes: Bytes): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET.charAt(b0 >> 2);
    out += BASE64URL_ALPHABET.charAt(((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4));
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET.charAt(((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6));
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET.charAt(b2 & 0b111111);
  }
  return out;
}

// The alphabet is 64 ASCII characters by definition; there is no grapheme cluster to break.
// eslint-disable-next-line @typescript-eslint/no-misused-spread
const BASE64URL_CHARACTERS = [...BASE64URL_ALPHABET];

const BASE64URL_VALUES: ReadonlyMap<string, number> = new Map(
  BASE64URL_CHARACTERS.map((character, value) => [character, value]),
);

/**
 * base64url decode. Accepts the standard `+`/`/` alphabet and `=` padding as well, because
 * hand-edited backups and other tools produce it; rejects anything else. Input reaching this
 * function is untrusted (it comes out of storage or an imported file), so it is validated
 * character by character rather than handed to `atob`, whose error behaviour varies.
 */
export function fromBase64Url(text: string): Bytes {
  let bits = 0;
  let bitCount = 0;
  const out: number[] = [];
  for (const character of text) {
    if (character === '=') continue;
    const canonical = character === '+' ? '-' : character === '/' ? '_' : character;
    const value = BASE64URL_VALUES.get(canonical);
    if (value === undefined) {
      throw new CorruptVaultError('Value is not valid base64url.');
    }
    bits = (bits << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out.push((bits >> bitCount) & 0xff);
    }
  }
  // Leftover bits must be zero padding, never a truncated byte: `AB` is well-formed, `ABC=` with a
  // non-zero tail is a corrupted value pretending to be well-formed.
  if (bitCount > 0 && (bits & ((1 << bitCount) - 1)) !== 0) {
    throw new CorruptVaultError('base64url value has a non-zero partial byte.');
  }
  return Uint8Array.from(out);
}

/** Concatenate byte arrays into one buffer. */
export function concatBytes(...parts: readonly Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Push `data` through a transform stream and collect the whole output. */
async function pump(
  transform: CompressionStream | DecompressionStream,
  data: Bytes,
): Promise<Bytes> {
  const writer = transform.writable.getWriter();
  // Deliberately not awaited: for inputs larger than the stream's internal buffer, `write()` does
  // not settle until the reader below drains it, so awaiting here would deadlock. The rejection is
  // still observed — it resurfaces from the read loop.
  const written = writer.write(data).then(() => writer.close());
  void written.catch(() => undefined);

  const reader = transform.readable.getReader();
  const chunks: Bytes[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await written;
  return concatBytes(...chunks);
}
