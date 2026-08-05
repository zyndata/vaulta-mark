/**
 * Reading a `.vmv` back (ARCHITECTURE §11): parse, decrypt, validate, migrate, preview, apply.
 *
 * **Everything in this file is hostile input.** A `.vmv` arrives from a filesystem: it may have been
 * truncated by a failed copy, edited by hand, rewritten by something that thought it was helping, or
 * assembled by an attacker who would like the importer to do something interesting. Nothing is
 * trusted until it has been checked, and the checks run in an order chosen so that each failure is
 * reported as the thing it actually is:
 *
 * 1. **Text → JSON.** A truncated file is not valid JSON, which is what a half-copied download
 *    looks like. `CorruptVaultError`.
 * 2. **Shape.** Magic, versions, KDF parameters, base64 fields. All structural, all
 *    `CorruptVaultError` — except a `formatVersion` or `schemaVersion` from the future, which is
 *    `UnsupportedSchemaError`: the file is fine and this build is old, and telling someone their
 *    backup is corrupt when it is merely newer is how a good backup gets deleted.
 * 3. **The wrapped key.** 48 authenticated bytes whose only job is to answer "is this the right
 *    password?". `WrongPasswordError`.
 * 4. **The payload.** Only reachable with the right key, so a failure here is damage rather than a
 *    typo. `CorruptVaultError`.
 * 5. **The items.** `migrate()` validates every field of every item, as it does for a bucket.
 *
 * Applying is separate from reading, and both import modes leave the vault in a state the user can
 * get out of. **Merge** runs the Phase-7 engine against an empty base, so an id present on both
 * sides and differing becomes a conflict rather than an overwrite — nothing is ever discarded.
 * **Replace** takes a sealed snapshot of the current vault *before* it writes anything, so the
 * answer to "that was the wrong file" is one button for the next 24 hours.
 */

import { fromBase64Url, gunzip, unpad, utf8Decode, type Bytes } from '../crypto/codec.js';
import { open } from '../crypto/envelope.js';
import { CorruptVaultError, UnsupportedSchemaError } from '../crypto/errors.js';
import { KDF_ALGORITHM, MIN_KDF_ITERATIONS, deriveKek } from '../crypto/kdf.js';
import { subkey, unwrapDek } from '../crypto/keys.js';
import { zero } from '../crypto/wipe.js';
import type { VaultRepository } from '../storage/repo.js';
import { saveConflicts, loadConflicts } from '../sync/base.js';
import { merge, type Conflict } from '../sync/merge.js';
import { migrate } from '../vault/migrate.js';
import { toItemMap } from '../vault/model.js';
import {
  SCHEMA_VERSION,
  isBookmark,
  isDeleted,
  type ItemMap,
  type VaultItem,
} from '../vault/types.js';
import { VMV_FORMAT_VERSION, VMV_MAGIC, exportAad, type VmvFile } from './export-encrypted.js';
import { saveRollback } from './rollback.js';

/** The two ways an import can meet a vault that already has things in it. */
export type ImportMode =
  /** Phase-7 merge against an empty base: adds and conflicts, never a loss. */
  | 'merge'
  /** The imported set becomes the vault. Gated twice in the UI, and undoable for 24 hours. */
  | 'replace';

/** What the preview step shows before anything is written. */
export interface ImportPreview {
  readonly bookmarks: number;
  readonly folders: number;
  /** Tombstones in the file. Carried so a merge does not resurrect deletions; never shown as items. */
  readonly deleted: number;
  /** Creation dates of the oldest and newest live bookmark, or `null` when there are none. */
  readonly oldest: number | null;
  readonly newest: number | null;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly schemaVersion: number;
  readonly includesThumbs: boolean;
  /**
   * How many of the file's **live** items the vault already holds, live.
   *
   * It is the number the preview shows against the bookmark and folder counts beside it, so it has
   * to be counted over the same items those are: an earlier version counted every id in the file the
   * vault recognised, tombstones included, and a backup carrying nine deletions reported "38 of them
   * are already in this vault" under a line reading "28 bookmarks in 1 folders". A count larger than
   * the thing it is a subset of is not a preview, it is a reason to distrust the whole screen.
   *
   * A file's live item whose vault copy is a tombstone is deliberately *not* counted: that is
   * something a merge has to ask about (§6.4), not something this vault already has.
   */
  readonly known: number;
}

export interface ImportResult {
  readonly mode: ImportMode;
  /** Items in the vault afterwards, tombstones excluded. */
  readonly total: number;
  /** Ids the vault did not have before. */
  readonly added: number;
  /** Ids that existed and now hold something different. */
  readonly updated: number;
  /** Disagreements the merge could not settle. Zero in replace mode, by definition. */
  readonly conflicts: number;
  /** Whether an undo snapshot was written — replace mode only. */
  readonly rollback: boolean;
}

/* ------------------------------------------------------------------ reading the file */

/**
 * Parse and structurally validate the container. **Does not decrypt** — no password needed.
 *
 * Split out so a UI can say "this is a VaultaMark export from 3 March" before it asks for a
 * password, and so every structural failure is reported before any 600,000-iteration KDF runs.
 */
export function parseVmv(text: string): VmvFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new CorruptVaultError('This file is not a readable VaultaMark export.', { cause });
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CorruptVaultError('Export file is not an object.');
  }
  const file = raw as Record<string, unknown>;

  if (file['magic'] !== VMV_MAGIC) {
    throw new CorruptVaultError('This file is not a VaultaMark export.');
  }

  const formatVersion = file['formatVersion'];
  if (!Number.isSafeInteger(formatVersion) || (formatVersion as number) < 1) {
    throw new CorruptVaultError('Export file declares no usable format version.');
  }
  if ((formatVersion as number) > VMV_FORMAT_VERSION) {
    throw new UnsupportedSchemaError(formatVersion as number, VMV_FORMAT_VERSION);
  }

  const schemaVersion = file['schemaVersion'];
  if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 1) {
    throw new CorruptVaultError('Export file declares no usable vault schema version.');
  }
  if ((schemaVersion as number) > SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(schemaVersion as number, SCHEMA_VERSION);
  }

  const kdf = asRecord(file['kdf'], 'Export file has no key-derivation parameters.');
  if (kdf['alg'] !== KDF_ALGORITHM) {
    throw new CorruptVaultError('Export file uses an unsupported key-derivation algorithm.');
  }
  const iterations = kdf['iterations'];
  if (!Number.isSafeInteger(iterations) || (iterations as number) < MIN_KDF_ITERATIONS) {
    throw new CorruptVaultError('Export file declares too few key-derivation iterations.');
  }
  const salt = asBase64UrlString(kdf['salt'], 'Export file has no usable KDF salt.');

  const wrapped = asRecord(file['wrappedKey'], 'Export file has no wrapped key.');
  const iv = asBase64UrlString(wrapped['iv'], 'Export file has no usable wrapped-key IV.');
  const ct = asBase64UrlString(wrapped['ct'], 'Export file has no usable wrapped key.');

  const payload = asBase64UrlString(file['payload'], 'Export file has no usable payload.');
  const includesThumbs = file['includesThumbs'] === true;

  return {
    magic: VMV_MAGIC,
    formatVersion: formatVersion as number,
    schemaVersion: schemaVersion as number,
    createdAt: typeof file['createdAt'] === 'number' ? file['createdAt'] : 0,
    createdBy: typeof file['createdBy'] === 'string' ? file['createdBy'] : '',
    kdf: { alg: KDF_ALGORITHM, iterations: iterations as number, salt },
    wrappedKey: { iv, ct },
    includesThumbs,
    payload,
  };
}

/**
 * Decrypt the payload and validate every item in it.
 *
 * The returned items have been through `migrate()`, so an export written by an older schema arrives
 * as items this build understands — and one written with a field missing is rejected here rather
 * than three layers up.
 */
export async function openVmv(file: VmvFile, password: string): Promise<ItemMap> {
  const kek = await deriveKek(password, fromBase64Url(file.kdf.salt), {
    alg: file.kdf.alg,
    iterations: file.kdf.iterations,
  });
  // The password check, and the only thing that answers `WrongPasswordError`. Everything after this
  // line runs under a key that is known to be right, so its failures are damage.
  const exportKey = await unwrapDek(kek, file.wrappedKey);
  try {
    const itemsKey = await subkey(exportKey, 'items');
    const plaintext = await openPayload(itemsKey, file);
    return toItemMap(migrate(plaintext, file.schemaVersion).items);
  } finally {
    zero(exportKey);
  }
}

async function openPayload(itemsKey: CryptoKey, file: VmvFile): Promise<unknown> {
  const sealed: Bytes = fromBase64Url(file.payload);
  const json = await gunzip(unpad(await open(itemsKey, sealed, exportAad(file.formatVersion))));
  try {
    return JSON.parse(utf8Decode(json));
  } catch (cause) {
    throw new CorruptVaultError('Export payload is not valid JSON.', { cause });
  }
}

/** What the file holds, for the confirmation step. Reads nothing from the vault except its ids. */
export function previewOf(file: VmvFile, items: ItemMap, vault: ItemMap): ImportPreview {
  let bookmarks = 0;
  let folders = 0;
  let deleted = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  let known = 0;

  for (const item of items.values()) {
    if (isDeleted(item)) {
      deleted += 1;
      continue;
    }
    // Counted here, past the tombstone check, so `known` is a subset of the bookmarks and folders
    // reported above it rather than a number over a different set of items entirely.
    const mine = vault.get(item.id);
    if (mine !== undefined && !isDeleted(mine)) known += 1;
    if (!isBookmark(item)) {
      folders += 1;
      continue;
    }
    bookmarks += 1;
    oldest = oldest === null ? item.createdAt : Math.min(oldest, item.createdAt);
    newest = newest === null ? item.createdAt : Math.max(newest, item.createdAt);
  }

  return {
    bookmarks,
    folders,
    deleted,
    oldest,
    newest,
    createdAt: file.createdAt,
    createdBy: file.createdBy,
    schemaVersion: file.schemaVersion,
    includesThumbs: file.includesThumbs,
    known,
  };
}

/* ------------------------------------------------------------------ applying it */

export interface ApplyOptions {
  readonly now?: () => number;
  /** Told how far along the merge is, so a large import can show something moving. */
  readonly onProgress?: (done: number, total: number) => void;
}

/**
 * Write an imported item set into an unlocked vault.
 *
 * Nothing is written before the decision is final: the merge is computed in full, the rollback
 * snapshot (replace mode) is taken, and only then does `replaceAll` commit. A failure at any point
 * before that leaves the vault exactly as it was.
 */
export async function applyImport(
  repo: VaultRepository,
  imported: ItemMap,
  mode: ImportMode,
  options: ApplyOptions = {},
): Promise<ImportResult> {
  const now = (options.now ?? Date.now)();
  const local = repo.items();
  const header = repo.header();

  if (mode === 'replace') {
    // Before anything: the way back. A replace that cannot be undone is a delete with extra steps.
    await saveRollback(repo, local, now);
    const changes = countChanges(local, imported);
    await repo.replaceAll(imported, { ...header, vaultRev: header.vaultRev + 1 });
    options.onProgress?.(imported.size, imported.size);
    return {
      mode,
      total: liveCount(imported),
      ...changes,
      conflicts: 0,
      rollback: true,
    };
  }

  options.onProgress?.(0, imported.size);
  const result = merge(null, local, imported, { now, origin: 'import' });
  options.onProgress?.(imported.size, imported.size);

  const changes = countChanges(local, result.merged);
  const conflicts = mergeIntoPending(await loadConflicts(repo.cipher()), result.conflicts);

  await repo.replaceAll(result.merged, { ...header, vaultRev: header.vaultRev + 1 });
  await saveConflicts(repo.cipher(), conflicts);

  return {
    mode,
    total: liveCount(result.merged),
    ...changes,
    conflicts: result.conflicts.length,
    rollback: false,
  };
}

/**
 * Fold import conflicts into whatever sync had already left pending.
 *
 * Keyed by id and newest wins, exactly as `sync/engine.ts` does it: a record carries whole versions,
 * so an older pair describes a state the vault is no longer in.
 */
function mergeIntoPending(
  pending: readonly Conflict[],
  fresh: readonly Conflict[],
): readonly Conflict[] {
  const byId = new Map(pending.map((conflict) => [conflict.id, conflict]));
  for (const conflict of fresh) byId.set(conflict.id, conflict);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function countChanges(
  before: ItemMap,
  after: ItemMap,
): { readonly added: number; readonly updated: number } {
  let added = 0;
  let updated = 0;
  for (const [id, item] of after) {
    const previous = before.get(id);
    if (previous === undefined) added += 1;
    else if (previous !== item) updated += 1;
  }
  return { added, updated };
}

function liveCount(items: ItemMap): number {
  let live = 0;
  for (const item of items.values()) if (!isDeleted(item)) live += 1;
  return live;
}

/* ------------------------------------------------------------------ input guards */

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CorruptVaultError(message);
  }
  return value as Record<string, unknown>;
}

/**
 * A base64url field, decoded once here to prove it is one.
 *
 * Validating on the way in rather than where it is used means a hand-edited file fails at the top of
 * the importer with a sentence about the file, instead of somewhere inside the cipher with a
 * sentence about bytes.
 */
function asBase64UrlString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value === '') throw new CorruptVaultError(message);
  fromBase64Url(value);
  return value;
}

/** Re-exported so callers need one import for the whole round trip. */
export type { VaultItem };
