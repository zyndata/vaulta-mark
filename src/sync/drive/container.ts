/**
 * What `vaultamark-vault.vmv` actually contains.
 *
 * The Chrome tier has a shape imposed on it by `storage.sync` — one header item and a hundred
 * 8 KB part items — and Drive has none: it is one file, so the container is ours to choose.
 *
 * It is JSON with base64url buckets, and that is a deliberate trade of about a third in size for
 * a file a person can open. §13.3 makes a point of the vault being an ordinary, user-visible Drive
 * object rather than something hidden in `appdata`; a user-visible file that is an opaque blob is
 * only half of that promise. Opening this one shows a header saying which KDF and how many buckets,
 * and then base64 that is unmistakably encrypted. **The contents are ciphertext either way** — the
 * encoding is not a security boundary and is not doing any work.
 *
 * `md5Checksum` from Drive is computed over these bytes, which is what makes it a usable
 * cross-check against the revision in `appProperties` (§13.4).
 */

import { fromBase64Url, toBase64Url, utf8, utf8Decode, type Bytes } from '../../crypto/codec.js';
import { parseHeader } from '../../storage/local.js';
import type { EncryptedVault } from '../../vault/types.js';
import { CorruptRemote } from '../provider.js';

/** Bumped only if the *container* changes. Independent of the vault's own `schemaVersion`. */
export const CONTAINER_VERSION = 1;

export function encodeVault(vault: EncryptedVault): Bytes {
  const buckets: Record<string, string> = {};
  for (const [index, sealed] of vault.buckets) buckets[String(index)] = toBase64Url(sealed);
  return utf8(
    `${JSON.stringify({ v: CONTAINER_VERSION, header: vault.header, buckets }, null, 1)}\n`,
  );
}

/**
 * Read a container back.
 *
 * Everything that can be wrong with these bytes is a {@link CorruptRemote}: they came off the
 * network, and the engine's answer to a remote it cannot read is to repair it by pushing its own
 * copy, which is the right answer to a truncated upload and to a file somebody edited by hand
 * alike. What it must not do is throw something that reads as "your vault is damaged".
 */
export function decodeVault(bytes: Bytes): EncryptedVault {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(bytes));
  } catch (cause) {
    throw new CorruptRemote('The Drive vault file is not JSON.', { cause });
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new CorruptRemote('The Drive vault file is not an object.');
  }

  const file = parsed as { v?: unknown; header?: unknown; buckets?: unknown };
  if (file.v !== CONTAINER_VERSION) {
    throw new CorruptRemote(`Unknown Drive container version ${JSON.stringify(file.v)}.`);
  }

  let header;
  try {
    header = parseHeader(file.header);
  } catch (cause) {
    throw new CorruptRemote('The Drive vault file has no readable header.', { cause });
  }

  const raw = file.buckets;
  if (raw === null || typeof raw !== 'object') {
    throw new CorruptRemote('The Drive vault file has no bucket table.');
  }

  const buckets = new Map<number, Bytes>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || typeof value !== 'string') {
      throw new CorruptRemote(`The Drive vault file has a malformed bucket ${key}.`);
    }
    try {
      buckets.set(index, fromBase64Url(value));
    } catch (cause) {
      throw new CorruptRemote(`Drive bucket ${key} is not base64url.`, { cause });
    }
  }

  // A header that promises a bucket the file does not carry is a truncated upload. Saying so here
  // means the engine repairs it; letting it through would mean decrypting a vault short of its
  // items and then pushing *that* back as the truth.
  for (const meta of header.buckets) {
    if (meta.parts > 0 && !buckets.has(meta.i)) {
      throw new CorruptRemote(`The Drive vault file is missing bucket ${String(meta.i)}.`);
    }
  }
  return { header, buckets };
}
