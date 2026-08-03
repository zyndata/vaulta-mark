/**
 * `.vmv` — the portable encrypted export (ARCHITECTURE §11).
 *
 * A vault backup that outlives this install: one JSON file, self-describing, with its own KDF header
 * so it can be opened by any future version and under a password of its own. It is the disaster
 * recovery story — the answer to "my profile is gone" — and it is the only artefact VaultaMark
 * produces that a user is expected to keep somewhere we know nothing about.
 *
 * Three things shape the container.
 *
 * - **Its own key hierarchy, mirroring the vault's.** A random export key is wrapped under a KEK
 *   derived from the export password, exactly as the vault wraps its DEK (§4.1). That is not
 *   symmetry for its own sake: the wrap *is* the password check, so a wrong password fails on 48
 *   bytes and reports `WrongPasswordError`, while a payload that fails afterwards can only be
 *   damage and reports `CorruptVaultError`. Without it the two are one indistinguishable GCM
 *   failure, and "wrong password" and "this backup is broken" send a user down entirely different
 *   roads.
 * - **The AAD carries the file's own `formatVersion`, not `SCHEMA_VERSION`.** This is why the
 *   payload is sealed here rather than through `storage/codec.ts`'s `sealJson`, which binds the
 *   vault schema version of the build that wrote it. A file sealed under `v:2` would stop opening
 *   the day the vault schema became 3 — in a format whose entire purpose is to still open then.
 * - **Tombstones travel.** The payload is the complete item set, deletions included, so a
 *   merge-mode import does not resurrect what the user deleted (§11).
 *
 * The file is delivered by the page that asked for it, with an object URL and a synthetic download
 * click, so the `downloads` permission is never needed (INV-9).
 */

import { gzip, pad, toBase64Url, utf8, type Bytes } from '../crypto/codec.js';
import { seal, type Aad } from '../crypto/envelope.js';
import { RECOMMENDED_KDF_PARAMS, deriveKek, generateKdfSalt, type KdfParams } from '../crypto/kdf.js';
import { generateDek, subkey, wrapDek, type WrappedDek } from '../crypto/keys.js';
import { zero } from '../crypto/wipe.js';
import { canonicalJson } from '../vault/model.js';
import { SCHEMA_VERSION, type VaultItem } from '../vault/types.js';

/** The first field of the file, and the cheapest way to say "this is not one of ours". */
export const VMV_MAGIC = 'VAULTAMARK-EXPORT';

/** The container's own version, independent of the vault schema inside it. */
export const VMV_FORMAT_VERSION = 1;

/** What a `.vmv` file is, field for field (ARCHITECTURE §11). */
export interface VmvFile {
  readonly magic: typeof VMV_MAGIC;
  readonly formatVersion: number;
  /** The schema version of the items inside, so an older export migrates on import. */
  readonly schemaVersion: number;
  readonly createdAt: number;
  /** `"VaultaMark 1.2.3"`. Informational; nothing branches on it. */
  readonly createdBy: string;
  readonly kdf: { readonly alg: KdfParams['alg']; readonly iterations: number; readonly salt: string };
  /** AES-256-GCM(KEK, export key). The password check, exactly as in the vault header. */
  readonly wrappedKey: WrappedDek;
  readonly includesThumbs: boolean;
  /** base64url of the sealed, padded, gzipped canonical JSON of {@link VmvPayload}. */
  readonly payload: string;
  /** Sealed thumbnail bytes by item id. Present only when {@link includesThumbs}. */
  readonly thumbs?: Record<string, string>;
}

/** What the payload decrypts to. The whole light tier, tombstones included. */
export interface VmvPayload {
  readonly items: readonly VaultItem[];
}

export interface ExportOptions {
  /** Stamped into `createdBy`. The manifest version, supplied by the caller. */
  readonly version?: string;
  readonly now?: () => number;
  /** Told how far along the sealing is, so a large vault can show something moving. */
  readonly onProgress?: (done: number, total: number) => void;
}

/**
 * Seal an item set into a `.vmv` container.
 *
 * The export password may be the vault's or a different one — the container does not know or care,
 * which is the point of it carrying its own KDF parameters. The caller is responsible for having
 * established that the user meant the password they typed (`repo.verifyPassword` for the
 * "use my vault password" path, a confirmation field for the other).
 */
export async function exportVault(
  items: Iterable<VaultItem>,
  password: string,
  options: ExportOptions = {},
): Promise<VmvFile> {
  const now = (options.now ?? Date.now)();
  const list = [...items];
  options.onProgress?.(0, list.length);

  const salt = generateKdfSalt();
  const kek = await deriveKek(password, salt, RECOMMENDED_KDF_PARAMS);
  const exportKey = generateDek();
  try {
    const wrappedKey = await wrapDek(kek, exportKey);
    const itemsKey = await subkey(exportKey, 'items');
    const payload = await sealPayload(itemsKey, VMV_FORMAT_VERSION, { items: list });
    options.onProgress?.(list.length, list.length);

    return {
      magic: VMV_MAGIC,
      formatVersion: VMV_FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      createdBy: `VaultaMark ${options.version ?? '0.0.0'}`,
      kdf: { ...RECOMMENDED_KDF_PARAMS, salt: toBase64Url(salt) },
      wrappedKey,
      // Nothing captures thumbnails until Phase 11, so there is no heavy tier to include. The field
      // is written rather than omitted because a reader should never have to guess.
      includesThumbs: false,
      payload: toBase64Url(payload),
    };
  } finally {
    zero(exportKey);
  }
}

/**
 * Seal the payload under the export key.
 *
 * gzip → pad → seal, the same order as everything else in the project (§4.4), with the AAD bound to
 * the container's `formatVersion` — see the note at the top of this file.
 */
export async function sealPayload(
  itemsKey: CryptoKey,
  formatVersion: number,
  payload: VmvPayload,
): Promise<Bytes> {
  const json = utf8(canonicalJson(payload));
  return await seal(itemsKey, pad(await gzip(json)), exportAad(formatVersion));
}

/** The associated data every `.vmv` payload is bound to. Shared with the reader, by construction. */
export function exportAad(formatVersion: number): Aad {
  return { v: formatVersion, purpose: 'export', id: '' };
}

/** The file as text, ready for a `Blob`. Two-space indented: a backup people can look inside. */
export function serializeVmv(file: VmvFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * A filename for an export: `vaultamark-YYYY-MM-DD.vmv`.
 *
 * The date and nothing else. A name carrying a bookmark count or a vault label would put vault
 * facts into a filename that ends up in a downloads folder, a backup index and a cloud drive.
 */
export function exportFilename(at: number, extension: 'vmv' | 'html' = 'vmv'): string {
  const date = new Date(at);
  const parts = [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
  return `vaultamark-${parts.join('-')}.${extension}`;
}
