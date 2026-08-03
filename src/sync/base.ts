/**
 * The merge base and the pending conflicts — the two pieces of state that make a 3-way merge
 * possible at all (ARCHITECTURE §5.1, §6.2).
 *
 * **Why a base is stored rather than derived.** Without a common ancestor there is no way to tell
 * "this device added a tag" from "the other device removed one": both look like a difference. The
 * base is the exact item set as of the last successful sync, so every question a merge asks —
 * *which side changed?* — has an answer that does not involve guessing from timestamps.
 *
 * **Why both are sealed.** They are vault content. The base is a whole copy of the item set, and a
 * conflict record carries two full versions of a bookmark. INV-6 has no exception for scratch
 * space, and `storage.local` is exactly where a plaintext copy would sit unnoticed for months.
 *
 * `vm.baseMeta` beside them is plaintext and holds no content: a revision number, a provider id and
 * a timestamp. It is read before the vault is unlocked, to tell a UI when it last synced.
 */

import type { Bytes } from '../crypto/codec.js';
import { CorruptVaultError } from '../crypto/errors.js';
import {
  clearBase,
  readBase,
  readBaseMeta,
  readConflicts,
  writeBase,
  writeConflicts,
} from '../storage/local.js';
import type { VaultCipher } from '../storage/repo.js';
import { toItemMap } from '../vault/model.js';
import { migrate } from '../vault/migrate.js';
import { SCHEMA_VERSION, type BaseMeta, type ItemMap, type VaultItem } from '../vault/types.js';
import type { Conflict, ConflictField, ConflictKind } from './merge.js';

/* ------------------------------------------------------------------ the merge base */

/** Read the merge base. `null` means there has never been a successful sync on this device. */
export async function loadBase(cipher: VaultCipher): Promise<ItemMap | null> {
  const sealed = await readBase();
  if (sealed === null) return null;
  const payload = await cipher.open('base', '', sealed);
  return toItemMap(migrate(payload, SCHEMA_VERSION).items);
}

/**
 * Write the merge base, together with the revision it represents.
 *
 * Both in one call because they must never disagree: a base whose `lastSyncedRev` belongs to a
 * different item set is worse than no base at all — it makes the merge confidently wrong instead of
 * conservatively cautious.
 */
export async function saveBase(
  cipher: VaultCipher,
  items: ItemMap,
  meta: BaseMeta,
): Promise<void> {
  const sealed = await cipher.seal('base', '', { items: [...items.values()] });
  await writeBase(sealed, meta);
}

export { clearBase, readBaseMeta };

/* ------------------------------------------------------------------ conflicts */

/** What `vm.conflicts` decrypts to. Versioned so a later shape change is a migration, not a crash. */
interface ConflictFile {
  readonly v: number;
  readonly conflicts: readonly Conflict[];
}

export async function loadConflicts(cipher: VaultCipher): Promise<Conflict[]> {
  const sealed = await readConflicts();
  if (sealed === null) return [];
  return parseConflicts(await cipher.open('conflicts', '', sealed));
}

/** Write the pending set. An empty list removes the key rather than storing an empty container. */
export async function saveConflicts(
  cipher: VaultCipher,
  conflicts: readonly Conflict[],
): Promise<void> {
  if (conflicts.length === 0) {
    await writeConflicts(null);
    return;
  }
  const file: ConflictFile = { v: SCHEMA_VERSION, conflicts };
  await writeConflicts(await sealConflicts(cipher, file));
}

function sealConflicts(cipher: VaultCipher, file: ConflictFile): Promise<Bytes> {
  return cipher.seal('conflicts', '', file);
}

/**
 * Validate a decrypted conflict file.
 *
 * The bytes authenticated, so this is not defending against an attacker — it is defending against a
 * record written by an older build, or by a bug. A malformed conflict would otherwise reach the
 * resolution UI as a half-item and let someone "keep theirs" on something that is not a bookmark.
 */
function parseConflicts(raw: unknown): Conflict[] {
  if (raw === null || typeof raw !== 'object') {
    throw new CorruptVaultError('Stored conflicts are not an object.');
  }
  const list = (raw as { conflicts?: unknown }).conflicts;
  if (!Array.isArray(list)) {
    throw new CorruptVaultError('Stored conflicts have no conflicts array.');
  }

  const out: Conflict[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Partial<Conflict>;
    if (
      typeof record.id !== 'string' ||
      !isConflictKind(record.kind) ||
      !isItem(record.mine) ||
      !isItem(record.theirs) ||
      typeof record.detectedAt !== 'number'
    ) {
      continue;
    }
    out.push({
      id: record.id,
      kind: record.kind,
      fields: Array.isArray(record.fields)
        ? (record.fields.filter((field) => typeof field === 'string') as ConflictField[])
        : [],
      mine: record.mine,
      theirs: record.theirs,
      base: isItem(record.base) ? record.base : null,
      detectedAt: record.detectedAt,
      ...(typeof record.remoteDevice === 'string' ? { remoteDevice: record.remoteDevice } : {}),
      // Load-bearing rather than decorative: `outboundView` reads it to decide whether the other
      // side is a device whose answer must be protected, or a file that has no answer to protect.
      ...(record.origin === 'import' ? { origin: 'import' as const } : {}),
    });
  }
  return out;
}

function isConflictKind(value: unknown): value is ConflictKind {
  return value === 'field' || value === 'edit-delete' || value === 'add-add';
}

function isItem(value: unknown): value is VaultItem {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Partial<VaultItem>;
  return (
    typeof item.id === 'string' &&
    (item.type === 'bookmark' || item.type === 'folder') &&
    typeof item.title === 'string' &&
    typeof item.parentId === 'string'
  );
}
