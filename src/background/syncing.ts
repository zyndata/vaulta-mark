/**
 * The sync vocabulary the UI speaks — status, "sync now", and settling a conflict.
 *
 * `items.ts` is the popup's vocabulary and `organize.ts` is the manager's; this is the sync view's,
 * and it exists for the same reason they do: `src/sync/` is written to be testable without a
 * `chrome` in scope, so the part that knows about sessions, broadcasts and the idle window lives
 * here instead.
 *
 * The one piece of real logic in this file is {@link resolve}. A conflict is settled by making a
 * *normal local edit* — the same mutations the manager would produce if a person had typed the
 * answer — and then dropping the record. That is deliberate: it means resolution goes through the
 * same validation, the same batch atomicity and the same revision bookkeeping as everything else,
 * and the merge engine has nothing special to know about it. What the record does while it exists
 * is keep the item out of the outbound view (`outboundView`), so the other device's answer survives
 * untouched until someone chooses.
 */

import { broadcast, type ConflictSide, type ConflictView, type SyncStatusResponse } from '../shared/messages.js';
import type { ConflictResolution } from '../shared/messages.js';
import { canKeepBoth, forgetConflicts, listConflicts, status, syncNow } from '../sync/engine.js';
import type { Conflict } from '../sync/merge.js';
import { ItemNotFoundError } from '../vault/errors.js';
import type { Mutation } from '../vault/model.js';
import { ROOT_ID, isBookmark, isDeleted, noteOf, tagsOf, type ItemMap, type VaultItem } from '../vault/types.js';
import { requireVault } from './items.js';
import * as session from './session.js';

/** The sync status, as the wire carries it. Answerable while locked — see `SyncStatusResponse`. */
export async function syncStatus(): Promise<SyncStatusResponse> {
  return toWire(await status());
}

/** Run the whole state machine now, and answer with where it got to. */
export async function runSyncNow(): Promise<SyncStatusResponse> {
  await session.touch();
  return toWire(await syncNow());
}

function toWire(current: Awaited<ReturnType<typeof status>>): SyncStatusResponse {
  return { type: 'SYNC_STATUS', ...current };
}

/* ------------------------------------------------------------------ conflicts */

export async function conflicts(): Promise<ConflictView[]> {
  const repo = await requireVault();
  await session.touch();
  const items = repo.items();
  return (await listConflicts(repo)).map((conflict) => view(conflict, items));
}

function view(conflict: Conflict, items: ItemMap): ConflictView {
  return {
    id: conflict.id,
    kind: conflict.kind,
    fields: conflict.fields,
    mine: side(conflict.mine, items),
    theirs: side(conflict.theirs, items),
    canKeepBoth: canKeepBoth(conflict),
    detectedAt: conflict.detectedAt,
  };
}

/**
 * One side, flattened for display.
 *
 * The parent is sent as a *title* rather than an id: "moved to Reading" is a sentence someone can
 * act on and a UUID is not, and the receiving page has no way to resolve one into the other for a
 * folder that only exists on the other device.
 */
function side(item: VaultItem, items: ItemMap): ConflictSide {
  const parent = item.parentId === ROOT_ID ? undefined : items.get(item.parentId);
  return {
    title: item.title,
    ...(isBookmark(item) ? { url: item.url } : {}),
    note: noteOf(item),
    tags: tagsOf(item),
    folder: parent?.title ?? '',
    deleted: isDeleted(item),
    updatedAt: item.updatedAt,
  };
}

/**
 * Settle conflicts, and push the answer.
 *
 * `force` on the sync afterwards, because "keep mine" changes no bookmark: the item already holds
 * this device's version and the only thing that moved is the record that was holding it back from
 * being pushed. Without it the engine would look at an unchanged `vaultRev`, conclude there was
 * nothing to send, and leave the resolution sitting on one device.
 */
export async function resolve(
  ids: readonly string[],
  resolution: ConflictResolution,
): Promise<number> {
  const repo = await requireVault();
  const pending = await listConflicts(repo);
  const chosen = pending.filter((conflict) => ids.includes(conflict.id));
  if (chosen.length === 0) throw new ItemNotFoundError(ids[0] ?? '');

  const mutations = chosen.flatMap((conflict) => resolutionMutations(conflict, resolution));
  if (mutations.length > 0) {
    await repo.apply(mutations);
    await repo.flush();
  }
  await forgetConflicts(
    repo,
    chosen.map((conflict) => conflict.id),
  );

  await session.touch();
  await broadcast({ type: 'VAULT_CHANGED' });
  await syncNow({ force: true });
  return chosen.length;
}

/**
 * What settling one conflict does to the local vault.
 *
 * - **mine** — nothing. The item already is this device's version; dropping the record is the
 *   whole change, and it is what lets the next push carry it.
 * - **theirs** — become the other version, including its deletion and its folder.
 * - **both** — keep this device's, and add the other one beside it under a fresh id with a
 *   "(conflicted copy)" title. The only answer that discards nothing, and the reason it is offered
 *   at all.
 *
 * The awkward case is an id that is a bookmark on one device and a folder on the other, which only
 * an import that reused an id can produce. There is no patch that turns one into the other, so
 * "keep theirs" deletes this device's item and adds theirs as a new one — the id is lost, which is
 * the lesser of the two losses available.
 */
function resolutionMutations(conflict: Conflict, resolution: ConflictResolution): Mutation[] {
  const { id, mine, theirs } = conflict;
  if (resolution === 'mine') return [];

  if (resolution === 'both') {
    return canKeepBoth(conflict) ? [{ kind: 'add', input: copyOf(theirs) }] : [];
  }

  if (isDeleted(theirs)) return [{ kind: 'delete', id }];
  if (mine.type !== theirs.type) {
    return [{ kind: 'delete', id }, { kind: 'add', input: copyOf(theirs) }];
  }

  const mutations: Mutation[] = [];
  if (isDeleted(mine)) mutations.push({ kind: 'restore', id });
  mutations.push({
    kind: 'update',
    id,
    patch: {
      title: theirs.title,
      ...(isBookmark(theirs) ? { url: theirs.url } : {}),
      ...(isBookmark(theirs)
        ? { note: theirs.note ?? null, tags: theirs.tags === undefined ? null : [...theirs.tags] }
        : {}),
    },
  });
  if (mine.parentId !== theirs.parentId) {
    mutations.push({ kind: 'move', id, parentId: theirs.parentId });
  }
  return mutations;
}

/**
 * The other version as a new item.
 *
 * `parentId` is deliberately **not** carried over: the folder it names may be one this device has
 * never heard of, and an add into an unknown parent rejects the whole batch. The copy lands at the
 * top level, where it is visible and can be filed.
 */
function copyOf(item: VaultItem): Extract<Mutation, { kind: 'add' }>['input'] {
  const title = `${item.title} ${chrome.i18n.getMessage('conflictCopySuffix')}`.trim();
  if (!isBookmark(item)) return { type: 'folder', title };
  return {
    type: 'bookmark',
    url: item.url,
    title,
    ...(item.note === undefined ? {} : { note: item.note }),
    ...(item.tags === undefined ? {} : { tags: [...item.tags] }),
  };
}
