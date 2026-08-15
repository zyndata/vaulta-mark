/**
 * Schema migrations (ARCHITECTURE §3.3).
 *
 * An ordered registry of `(from, to, run)` steps applied in sequence over the **decrypted** item
 * set. The rules that matter:
 *
 * - A vault older than us is migrated in memory on unlock and written back on the next commit, so
 *   a user who never edits anything never has their vault rewritten under them.
 * - A vault **newer** than us throws `UnsupportedSchemaError` and is never written. Downgrade-
 *   writing would silently destroy whatever the newer version added, and the user would not find
 *   out until they opened the vault on the device that could read it.
 * - Steps are pure functions with a committed fixture each, so they are exercised by a real vault
 *   rather than being dead code that first runs on someone's only copy.
 *
 * `v1` is deliberately reserved as "pre-tags/notes/thumbs, integer ordering" — it never shipped,
 * and it exists so this machinery is tested rather than theoretical.
 */

import { CorruptVaultError, UnsupportedSchemaError } from '../crypto/errors.js';
import { ordersBetween } from './order.js';
import { ROOT_ID, SCHEMA_VERSION, type BucketPayload, type VaultItem } from './types.js';

/** The loose shape a migration works on: a payload whose items have not been validated yet. */
export interface RawPayload {
  readonly items: readonly Record<string, unknown>[];
}

export interface MigrationStep {
  readonly from: number;
  readonly to: number;
  readonly run: (payload: RawPayload) => RawPayload;
}

/**
 * v1 → v2.
 *
 * v1 had no `tags`, `note`, `og` or `thumb`, and ordered siblings with an integer `order`. The
 * integers become fractional index keys (`order.ts`) so that from here on a reorder touches one
 * item; the new optional fields are left **absent** rather than written as `[]`/`""`, because
 * absent and empty mean the same thing to every reader (`tagsOf`, `noteOf`) and an empty array in
 * every item costs real bytes against a 100 KB sync quota.
 */
const v1ToV2: MigrationStep = {
  from: 1,
  to: 2,
  run: (payload) => {
    const bySibling = new Map<string, Record<string, unknown>[]>();
    for (const item of payload.items) {
      const parentId = typeof item['parentId'] === 'string' ? item['parentId'] : ROOT_ID;
      const group = bySibling.get(parentId) ?? [];
      group.push(item);
      bySibling.set(parentId, group);
    }

    const items: Record<string, unknown>[] = [];
    for (const group of bySibling.values()) {
      group.sort((a, b) => numericOrder(a) - numericOrder(b));
      const keys = ordersBetween(null, null, group.length);
      group.forEach((item, index) => {
        items.push({ ...item, order: keys[index] });
      });
    }
    return { items };
  },
};

/** Every migration this build knows, in application order. */
export const MIGRATIONS: readonly MigrationStep[] = [v1ToV2];

/**
 * Migrate a decrypted payload from schema version `from` up to `to` (our version by default).
 *
 * Throws `UnsupportedSchemaError` for a newer vault and `CorruptVaultError` when there is no path —
 * a version we once knew and dropped, or a header claiming something that was never a version.
 */
export function migrate(raw: unknown, from: number, to: number = SCHEMA_VERSION): BucketPayload {
  if (!Number.isSafeInteger(from) || from < 1) {
    throw new CorruptVaultError(`Vault declares an invalid schema version ${String(from)}.`);
  }
  if (from > to) throw new UnsupportedSchemaError(from, to);

  let payload = asRawPayload(raw);
  let version = from;
  while (version < to) {
    const step = MIGRATIONS.find((candidate) => candidate.from === version);
    if (step === undefined) {
      throw new CorruptVaultError(`No migration path from schema version ${version} to ${to}.`);
    }
    payload = step.run(payload);
    version = step.to;
  }
  return { items: payload.items.map(asVaultItem) };
}

/** Whether `migrate` would change anything — i.e. whether unlock has to mark the vault dirty. */
export function needsMigration(schemaVersion: number): boolean {
  return schemaVersion < SCHEMA_VERSION;
}

function asRawPayload(raw: unknown): RawPayload {
  if (raw === null || typeof raw !== 'object') {
    throw new CorruptVaultError('Vault payload is not an object.');
  }
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    throw new CorruptVaultError('Vault payload has no items array.');
  }
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new CorruptVaultError('Vault payload contains an item that is not an object.');
    }
  }
  return { items: items as Record<string, unknown>[] };
}

/**
 * The one place a decrypted payload becomes a typed `VaultItem`.
 *
 * The bytes are authenticated by the time they get here, so this is not defending against an
 * attacker — it is defending against *us*: a migration step that forgets a field, or a vault
 * written by a build with a bug, would otherwise propagate as a plausible-looking item that breaks
 * something three layers up with no clue as to where it came from.
 */
function asVaultItem(raw: Record<string, unknown>): VaultItem {
  const type = raw['type'];
  if (type !== 'bookmark' && type !== 'folder') {
    throw new CorruptVaultError(`Vault item has unknown type ${JSON.stringify(type)}.`);
  }
  for (const field of ['id', 'parentId', 'title', 'order'] as const) {
    if (typeof raw[field] !== 'string') {
      throw new CorruptVaultError(`Vault item is missing a string "${field}".`);
    }
  }
  for (const field of ['createdAt', 'updatedAt', 'rev'] as const) {
    if (typeof raw[field] !== 'number') {
      throw new CorruptVaultError(`Vault item is missing a numeric "${field}".`);
    }
  }
  if (type === 'bookmark' && typeof raw['url'] !== 'string') {
    throw new CorruptVaultError('Bookmark is missing a string "url".');
  }
  // Checked field by field immediately above; there is no narrowing a type predicate could do here
  // that this has not already done.
  return raw as unknown as VaultItem;
}

/** v1 ordering was an integer. Anything else sorts to the front, deterministically. */
function numericOrder(item: Record<string, unknown>): number {
  const order = item['order'];
  return typeof order === 'number' && Number.isFinite(order) ? order : 0;
}
