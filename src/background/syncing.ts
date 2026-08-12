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

import {
  broadcast,
  type ConflictSide,
  type ConflictView,
  type DriveStateResponse,
  type MigrationResponse,
  type SyncStatusResponse,
} from '../shared/messages.js';
import type { ConflictResolution } from '../shared/messages.js';
import { clearBase, readSettings } from '../storage/local.js';
import type { VaultCipher } from '../storage/repo.js';
import { ChromeSyncProvider } from '../sync/chrome-provider.js';
import { DriveAuth, hasDrivePermissions } from '../sync/drive/auth.js';
import { DriveSyncProvider } from '../sync/drive/provider.js';
import { clearDriveRecord, readDriveRecord, writeDriveRecord } from '../sync/drive/record.js';
import {
  canKeepBoth,
  fetchRemote,
  forgetConflicts,
  listConflicts,
  markAdopted,
  status,
  syncNow,
} from '../sync/engine.js';
import { migrateProvider, type MigrationDeps } from '../sync/migration.js';
import type { Conflict } from '../sync/merge.js';
import type { ProviderId } from '../sync/provider.js';
import { ItemNotFoundError, VaultStateError } from '../vault/errors.js';
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

/* ------------------------------------------------------------------ Drive (Phase 10) */

/**
 * What the settings screen draws the Drive section from.
 *
 * Answerable while the vault is locked, like the sync status is and for the same reason: none of it
 * describes a bookmark. `connected` is deliberately "the provider in force *and* an account we have
 * seen", not "there is a token" — a token in `storage.session` says the browser has not been
 * restarted, which is not what anyone means by connected.
 */
export async function driveState(): Promise<DriveStateResponse> {
  const [settings, record, granted] = await Promise.all([
    readSettings(),
    readDriveRecord(),
    hasDrivePermissions(),
  ]);
  return {
    type: 'DRIVE_STATE',
    configured: new DriveAuth().configured,
    granted,
    connected: settings.providerId === 'drive',
    email: record.email,
    fileLink: record.webViewLink,
  };
}

/**
 * Connect Drive and move the vault there.
 *
 * The consent screen is opened from here — `chrome.identity` works from a worker — but the optional
 * *permission* cannot be: `chrome.permissions.request` needs a page and a user gesture, so the UI
 * has already asked before this message is sent, and this refuses rather than silently failing if
 * it did not.
 */
export async function connectDrive(replaceExisting = false): Promise<MigrationResponse> {
  await session.touch();
  if (!(await hasDrivePermissions())) {
    return { type: 'MIGRATION', ok: false, providerId: (await readSettings()).providerId, reason: 'auth' };
  }
  const provider = new DriveSyncProvider({ cipher: () => cipher() });
  try {
    // Interactive, once, here: this is the click. Everything afterwards is non-interactive, which is
    // what keeps a background sync from putting a consent window in front of someone.
    await provider.auth.token({ interactive: true });
  } catch {
    return { type: 'MIGRATION', ok: false, providerId: (await readSettings()).providerId, reason: 'auth' };
  }
  return await migrate('drive', {
    provider: (id) => (id === 'drive' ? provider : chromeProvider()),
    replaceExisting,
  });
}

/**
 * Move back to Chrome sync, and hand the Drive grant back.
 *
 * The revoke happens **after** the migration succeeded, and only then: a failed migration must leave
 * the device syncing through Drive exactly as it was, and a device with no token would not be.
 */
export async function disconnectDrive(deleteRemote: boolean): Promise<MigrationResponse> {
  await session.touch();
  const provider = new DriveSyncProvider({ cipher: () => cipher() });
  const result = await migrate('chrome', {
    provider: (id) => (id === 'drive' ? provider : chromeProvider()),
    // The Drive copy stays unless asked for: it is a file in the user's own Drive, and §6.6 says so.
    clearSource: false,
  });
  if (!result.ok) return result;

  // Best-effort, and after the fact. The vault is already back in Chrome sync and verified there;
  // a revoke that fails because the network dropped must not turn a completed disconnect into a
  // failure, which would leave the user believing they are still on Drive.
  try {
    if (deleteRemote) await provider.deleteRemote();
    await provider.disconnect();
  } catch {
    /* the grant stays until Google expires it, or the user withdraws it from their account page */
  }
  await clearDriveRecord();
  await broadcast({ type: 'SYNC_CHANGED', status: await syncStatus() });
  return result;
}

/* ------------------------------------------------------------------ taking a vault out of sync */

/**
 * Remove this vault's copy from whichever backend it syncs through.
 *
 * Two callers, and the difference between them is the whole reason for the flag.
 *
 * - **Destroying the vault** (`disconnect: true`). "Destroy my vault" that erased the local copy and
 *   left the encrypted one in `storage.sync` is the bug this exists to fix, and it was not a cosmetic
 *   one: the profile came back offering to *adopt* the vault it had just been told to destroy, and a
 *   freshly created replacement — same password typed again, but a new random DEK, because that is
 *   what "new vault" means — could never open those bytes. The result was a permanent
 *   `VAULT_MISMATCH` with no way out of it, on the one code path whose entire promise is that
 *   afterwards there is nothing left.
 * - **Taking the sync area over** (`disconnect: false`), from {@link replaceRemoteVault}. Same
 *   deletion, but the connection stays: the next sync writes this vault where the old one was.
 *
 * Never throws. It is best-effort by nature — Drive may be offline, the grant may have been
 * withdrawn from Google's account page — and a destroy that refused to proceed because a network
 * request failed would be a destroy that cannot be completed on a train. The boolean is reported so
 * the screen can say which of the two things happened rather than claiming both.
 */
async function removeRemoteVault(options: { readonly disconnect: boolean }): Promise<boolean> {
  const { providerId } = await readSettings();
  try {
    if (providerId === 'drive') {
      const provider = new DriveSyncProvider({ cipher: () => cipher() });
      await provider.init();
      await provider.deleteRemote();
      if (options.disconnect) {
        await provider.disconnect();
        await clearDriveRecord();
      }
      return true;
    }
    // `storage.sync` has no "stop using it but leave the copy behind": the keys *are* the copy, and
    // the Chrome provider's `disconnect()` is documented as deliberately destructive for exactly
    // this reason (§6.6). So both callers get the same thing here.
    await chromeProvider().disconnect();
    return true;
  } catch {
    return false;
  }
}

/**
 * The synced copy, as part of destroying the vault.
 *
 * Called **before** the local erase, and it has to be: on Drive the file ids and the sealed refresh
 * token live in `storage.local` under `vm.drive`, which `clearVault()` removes along with everything
 * else — so a Drive vault destroyed the other way round would leave an orphaned folder in the user's
 * Drive that nothing in the extension could still find.
 */
export async function destroyRemoteVault(): Promise<boolean> {
  return await removeRemoteVault({ disconnect: true });
}

/**
 * Replace whatever is in the sync area with this vault.
 *
 * The way out of `VAULT_MISMATCH`. Two vaults sharing one sync area cannot be merged — they are
 * different keys, and §6.5 has nothing to say about it — so the only answers are "one of them goes"
 * and "one of them moves to a different backend". Until now the UI stated the problem and offered
 * neither: the toolbar's status *is* a Sync-now button, so the only thing to click retried the merge
 * that cannot work and appeared to do nothing at all.
 *
 * Deliberately not offered as a repair the engine performs on its own. It discards another vault's
 * only synced copy, and on a second computer that vault may be the one somebody still wants.
 */
export async function replaceRemoteVault(): Promise<SyncStatusResponse> {
  // Unlocked, or there is no vault to put there. Throws `VaultLockedError`, which the wire turns
  // into `VAULT_LOCKED` — the same answer every other vault operation gives.
  await requireVault();
  await session.touch();

  const removed = await removeRemoteVault({ disconnect: false });
  // The base says "this is what the remote has". After a deletion that is a lie, and a merge that
  // believes it would treat every item as a remote deletion the moment something reappears there.
  await clearBase();
  if (!removed) return toWire(await status());

  return toWire(await syncNow({ force: true }));
}

/**
 * The other answer to the same question: keep the vault that is in the sync area, not this one.
 *
 * {@link replaceRemoteVault} settles "two vaults, one sync area" by discarding the remote. This
 * settles it by discarding the local, which is the right way round in the two situations that
 * actually produce a mismatch in the field:
 *
 * - **A profile that lost its vault.** A new extension id, a reinstall, a cleared profile: the
 *   synced copy is untouched, but `storage.local` is empty, so a vault created with the same
 *   password again gets a *new random DEK* and cannot open a byte of it. Retrying the merge can
 *   never work, and the copy on the other side is the one with the bookmarks in it.
 * - **A second computer joining through Drive.** Adoption from an empty profile only ever covered
 *   the backend in `vm.settings`, which is `chrome` until a migration succeeds — and the migration
 *   is exactly what a mismatch refuses. So this is also the door that was missing.
 *
 * `from` is passed rather than read, because the refused migration left `providerId` on the backend
 * being *left*: a Drive connection that was turned down still has an authorized Drive behind it and
 * a vault waiting in it, and that is the one being asked for.
 *
 * The Drive record is read before the adoption and written back after it, minus the refresh token.
 * The ids in it — which folder, which file — describe where the ciphertext is kept and are still
 * true of the adopted vault; `clearVault()` takes them because they live under `vm.`, and losing
 * them would leave the provider to find its own folder again by name. The token cannot come with
 * them: it is sealed under the *old* vault's `k_items` (§13.2) and is so much noise now. A profile
 * on the PKCE route therefore signs in once more, which the status line already knows how to say.
 */
export async function adoptRemoteVault(
  password: string,
  from: ProviderId,
): Promise<SyncStatusResponse> {
  // Unlocked first, and that is a gate rather than plumbing: this erases the vault that is on this
  // profile, so it must not be reachable by somebody who does not hold *its* master password.
  // Destroying a vault is refused while locked for exactly the same reason. A profile with no vault
  // at all never arrives here — joining from empty is `session.unlock`, which asks for one password
  // and erases nothing.
  await requireVault();
  await session.touch();

  const remote = await fetchRemote(from);
  if (remote === null) {
    throw new VaultStateError('There is no vault in that sync area to join.');
  }
  const drive = await readDriveRecord();

  await session.adoptRemoteVault(remote.vault, password, from);

  if (from === 'drive') await writeDriveRecord({ ...drive, refreshToken: null });

  // The merge base, for the same reason the empty-profile adoption records one: without it the next
  // sync reads every item as a local add and pushes the whole vault back where it came from.
  const repo = await requireVault();
  await markAdopted(repo, repo.items(), remote.stamp, remote.vault.header.vaultRev);

  // Every open page is now showing another vault's bookmarks. `VAULT_CHANGED` is what makes the
  // manager reload its list, and `settingsArrived` is the same call a merge makes when preferences
  // cross — the adopted vault brought its theme and its idle window with it, and the second of
  // those has an alarm behind it.
  await broadcast({ type: 'VAULT_CHANGED' });
  await session.settingsArrived();

  // A run rather than a status read, and for a reason the tests found: `lastError` is remembered
  // until the next attempt clears it, so a screen asked for the status here would still be showing
  // `VAULT_MISMATCH` — the very thing that has just been settled — until something else happened to
  // sync. The run itself has nothing to do (the base was recorded a few lines up) and says so.
  const current = toWire(await syncNow());
  await broadcast({ type: 'SYNC_CHANGED', status: current });
  return current;
}

async function migrate(
  target: 'chrome' | 'drive',
  deps: Pick<MigrationDeps, 'provider' | 'clearSource' | 'replaceExisting'>,
): Promise<MigrationResponse> {
  const result = await migrateProvider(target, {
    ...deps,
    repository: () => session.currentRepository(),
  });
  // The provider changed under every open page: the status line, the quota bar and the whole Drive
  // section are drawn from it.
  await broadcast({ type: 'SYNC_CHANGED', status: await syncStatus() });
  return {
    type: 'MIGRATION',
    ok: result.ok,
    providerId: result.providerId,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.fits === undefined ? {} : { fits: result.fits }),
    ...(result.items === undefined ? {} : { items: result.items }),
  };
}

function chromeProvider(): ChromeSyncProvider {
  return new ChromeSyncProvider();
}

/** The unlocked vault's cipher, or `null`. Never throws — the Drive path runs while locked too. */
async function cipher(): Promise<VaultCipher | null> {
  try {
    return (await session.currentRepository())?.cipher() ?? null;
  } catch {
    return null;
  }
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
