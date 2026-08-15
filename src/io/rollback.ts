/**
 * The one-shot undo behind a replace-mode import. ARCHITECTURE §11.
 *
 * A replace is the only operation in VaultaMark that can remove thousands of bookmarks in one press,
 * and the moment it is most likely to be wrong is the moment it happens — the wrong file, an export
 * from before a month of work, a backup of a different vault. So the vault is snapshotted first and
 * kept for 24 hours.
 *
 * Two properties make it worth having rather than reassuring:
 *
 * - **Sealed.** The snapshot is a complete copy of the item set. INV-6 has no exception for
 *   "temporarily", and `storage.local` is precisely where a plaintext copy would sit unnoticed.
 * - **One-shot, and it expires.** Restoring consumes it, so there is no half-remembered undo two
 *   imports later, and an unused one is discarded after 24 hours rather than kept forever as a
 *   second copy of the vault nobody knows is there.
 */

import { CorruptVaultError } from '../crypto/errors.js';
import { clearRollback, readRollback, readRollbackMeta, writeRollback } from '../storage/local.js';
import type { VaultRepository } from '../storage/repo.js';
import { migrate } from '../vault/migrate.js';
import { toItemMap } from '../vault/model.js';
import {
  ROLLBACK_TTL_MS,
  SCHEMA_VERSION,
  type ItemMap,
  type RollbackMeta,
} from '../vault/types.js';

/** Whether there is an undo, and until when. Answers without a key: the metadata is plaintext. */
export interface RollbackOffer {
  readonly available: boolean;
  readonly createdAt: number | null;
  readonly expiresAt: number | null;
}

/** Take the snapshot. Overwrites any earlier one — the newest replace is the one worth undoing. */
export async function saveRollback(
  repo: VaultRepository,
  items: ItemMap,
  now: number,
): Promise<void> {
  const sealed = await repo.cipher().seal('rollback', '', { items: [...items.values()] });
  const meta: RollbackMeta = { createdAt: now, expiresAt: now + ROLLBACK_TTL_MS };
  await writeRollback(sealed, meta);
}

/**
 * Is there an undo waiting?
 *
 * An expired snapshot is **deleted** here rather than merely hidden. Leaving a whole copy of a
 * previous vault on disk because nobody asked the right question is exactly the kind of forgotten
 * data this project does not keep.
 */
export async function rollbackOffer(now: number): Promise<RollbackOffer> {
  const meta = await readRollbackMeta();
  if (meta === null) return { available: false, createdAt: null, expiresAt: null };
  if (meta.expiresAt <= now) {
    await clearRollback();
    return { available: false, createdAt: null, expiresAt: null };
  }
  return { available: true, createdAt: meta.createdAt, expiresAt: meta.expiresAt };
}

/**
 * Put the vault back, and consume the snapshot.
 *
 * The snapshot is dropped only after `replaceAll` has committed: a failure to write must leave the
 * undo available, because the alternative is a user who pressed *Undo*, saw an error, and now has
 * neither the old vault nor the way back to it.
 */
export async function restoreRollback(repo: VaultRepository, now: number): Promise<number> {
  const offer = await rollbackOffer(now);
  if (!offer.available) {
    throw new CorruptVaultError('There is no import to undo.');
  }
  const sealed = await readRollback();
  if (sealed === null) {
    await clearRollback();
    throw new CorruptVaultError('The saved copy of the previous vault is missing.');
  }

  const payload = await repo.cipher().open('rollback', '', sealed);
  const items = toItemMap(migrate(payload, SCHEMA_VERSION).items);
  const header = repo.header();
  await repo.replaceAll(items, { ...header, vaultRev: header.vaultRev + 1 });
  await clearRollback();
  return items.size;
}

export { clearRollback };
