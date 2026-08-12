/**
 * The two kinds of file the importer will accept, and how it tells them apart.
 *
 * VaultaMark writes `.vmv` twice, in two different formats, for two different reasons:
 *
 * - **A backup** (`src/io/export-encrypted.ts`), written by *Back up the vault*. Password-derived
 *   KEK, its own random export key, one gzipped payload. Standalone by construction: it carries the
 *   KDF parameters it was sealed with and opens on any machine with the password.
 * - **The sync container** (`src/sync/drive/container.ts`), which is `vaultamark-vault.vmv` in the
 *   user's Drive. Header plus base64url buckets — the live vault, exactly as the engine pushes it.
 *
 * They shared an extension and nothing else, and *Restore from a backup* understood only the first
 * one. That is a real bug rather than a cosmetic mismatch: §13.3 deliberately puts the Drive vault in
 * the user's own Drive as an ordinary, visible, downloadable file, and `syncDriveDeleteRemoteHint`
 * tells people in so many words that leaving it there keeps a copy they can restore from. A file the
 * product hands you, names after itself, and promises you can restore from has to be restorable.
 * Downloading it is also the one recovery path that outlives the account it came from — a vault whose
 * Drive access is gone but whose file was saved is still a vault, and refusing it would be refusing
 * the user their own data over a container format.
 *
 * The container carries no magic string of its own, so the sniff is positive on the backup and
 * structural on the container: `magic` present means backup, otherwise a `v`/`header`/`buckets` shape
 * means container, and anything else is neither. Deliberately *not* "whatever is left is a
 * container" — an unrelated JSON file has to fail as **not a VaultaMark file**, not as a damaged one.
 *
 * **Everything here is hostile input**, on the same terms as `import-encrypted.ts`: it arrived from a
 * filesystem. The container path re-applies the two guards `parseVmv` applies and `parseHeader` does
 * not — the KDF algorithm, and a floor under the iteration count — because a header that came off
 * Drive was written by us and one that came off a disk was written by anybody.
 */

import { fromBase64Url, utf8 } from '../crypto/codec.js';
import { CorruptVaultError, UnsupportedSchemaError } from '../crypto/errors.js';
import { MIN_KDF_ITERATIONS, deriveKek } from '../crypto/kdf.js';
import { subkey, unwrapDek } from '../crypto/keys.js';
import { zero } from '../crypto/wipe.js';
import { openBucket } from '../storage/codec.js';
import { decodeVault } from '../sync/drive/container.js';
import { migrate } from '../vault/migrate.js';
import { toItemMap } from '../vault/model.js';
import { SCHEMA_VERSION, type EncryptedVault, type ItemMap } from '../vault/types.js';
import type { VmvFile } from './export-encrypted.js';
import { openVmv, parseVmv, previewOf, type ImportPreview } from './import-encrypted.js';

/** Which of the two files this is. Surfaced all the way to the dialog: the two say different things. */
export type VaultFileKind = 'backup' | 'sync';

/** A file that has been recognised and structurally checked, but not decrypted. */
export type ParsedVaultFile =
  | { readonly kind: 'backup'; readonly file: VmvFile }
  | { readonly kind: 'sync'; readonly vault: EncryptedVault };

export type VaultFilePreview = ImportPreview & { readonly origin: VaultFileKind };

/**
 * Recognise a file and validate its structure. **Does not decrypt** — no password needed.
 *
 * Split from opening for the same reason `parseVmv` is: every structural failure is reported before
 * a 600,000-iteration derivation runs, so the wrong file is refused instantly rather than after a
 * second and a half of looking like it might work.
 */
export function parseVaultFile(text: string): ParsedVaultFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new CorruptVaultError('This file is not a readable VaultaMark file.', { cause });
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CorruptVaultError('This file is not a VaultaMark file.');
  }
  const file = raw as Record<string, unknown>;

  // The positive test first, so a backup is never reached by elimination.
  if ('magic' in file) return { kind: 'backup', file: parseVmv(text) };

  if (
    typeof file['v'] === 'number' &&
    typeof file['header'] === 'object' &&
    file['header'] !== null
  ) {
    return { kind: 'sync', vault: parseContainer(text) };
  }

  throw new CorruptVaultError('This file is not a VaultaMark file.');
}

/**
 * The Drive container, re-checked as a file rather than as a network response.
 *
 * `decodeVault` answers `CorruptRemote`, which is the sync layer's phrase for "push over it" and is
 * not something an importer should be throwing at someone who picked the wrong file — so its
 * failures are translated. A truncated download and a hand-edited file both land here, and both are
 * damage.
 */
function parseContainer(text: string): EncryptedVault {
  let vault: EncryptedVault;
  try {
    vault = decodeVault(utf8(text));
  } catch (cause) {
    throw new CorruptVaultError('This file is not a readable VaultaMark vault.', { cause });
  }

  const { header } = vault;
  if (header.schemaVersion > SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(header.schemaVersion, SCHEMA_VERSION);
  }
  // The algorithm is checked by `parseHeader` itself, which is where a header's own claim about
  // itself belongs. The iteration floor is not: a header we wrote can be trusted to have used the
  // configured count, and one that came off a disk is a number an attacker chose.
  if (!Number.isSafeInteger(header.kdf.iterations) || header.kdf.iterations < MIN_KDF_ITERATIONS) {
    throw new CorruptVaultError('This vault file declares too few key-derivation iterations.');
  }
  // Proves the salt is base64url now, rather than inside the KDF a second and a half from here.
  fromBase64Url(header.kdf.salt);
  return vault;
}

/**
 * Decrypt the file, and validate every item in it.
 *
 * The container path derives from the file's **own** header rather than from the running vault's
 * keys, and that is what makes it work in the two cases that matter: a vault whose Drive connection
 * is gone, and a vault from another profile entirely. It is `repo.adopt()`'s derivation without the
 * adoption — nothing is written, and the caller decides what to do with the items.
 */
export async function openVaultFile(parsed: ParsedVaultFile, password: string): Promise<ItemMap> {
  if (parsed.kind === 'backup') return await openVmv(parsed.file, password);
  return await openContainer(parsed.vault, password);
}

async function openContainer(vault: EncryptedVault, password: string): Promise<ItemMap> {
  const { header } = vault;
  const kek = await deriveKek(password, fromBase64Url(header.kdf.salt), {
    alg: header.kdf.alg,
    iterations: header.kdf.iterations,
  });
  // The password check, and the only thing here that answers `WrongPasswordError`. Everything past
  // this line runs under a key known to be right, so its failures are damage rather than a typo.
  const dek = await unwrapDek(kek, header.wrappedDek);
  try {
    const itemsKey = await subkey(dek, 'items');
    const hmacKey = await subkey(dek, 'hmac');

    const raw: Record<string, unknown>[] = [];
    for (const meta of header.buckets) {
      if (meta.parts === 0) continue;
      const bytes = vault.buckets.get(meta.i);
      if (bytes === undefined) {
        throw new CorruptVaultError(
          `This vault file lists bucket ${String(meta.i)}, which is not in it.`,
        );
      }
      raw.push(...(await openBucket(itemsKey, hmacKey, meta.i, bytes, meta.tag)).items);
    }
    return toItemMap(migrate({ items: raw }, header.schemaVersion).items);
  } finally {
    zero(dek);
  }
}

/**
 * What the file holds, for the confirmation step.
 *
 * A container has no `createdBy` and no creation date — it is the live vault, not a snapshot taken at
 * a moment — so `createdAt` is the header's `updatedAt`, which is the honest answer to "how recent is
 * this?" and the one somebody needs before replacing a vault with it. `origin` is what lets the
 * dialog say which of the two it is holding instead of calling a sync file a backup.
 *
 * `includesThumbs` is false for a container, and that is a fact rather than a default: thumbnails are
 * their own Drive files (§14.3), and none of them is in this one.
 */
export function previewOfFile(
  parsed: ParsedVaultFile,
  items: ItemMap,
  vault: ItemMap,
): VaultFilePreview {
  if (parsed.kind === 'backup') {
    return { ...previewOf(parsed.file, items, vault), origin: 'backup' };
  }
  const { header } = parsed.vault;
  return {
    ...previewOf(
      {
        createdAt: header.updatedAt,
        createdBy: '',
        schemaVersion: header.schemaVersion,
        includesThumbs: false,
      },
      items,
      vault,
    ),
    origin: 'sync',
  };
}
