/**
 * Moving a vault between backends (ARCHITECTURE §6.6, D24).
 *
 * The whole design of this module comes from one sentence in the spec: **if verification fails, the
 * original provider stays active and nothing is flipped.** So the order is upload, verify, *then*
 * flip — and the flip is a single settings write that either happened or did not. A migration that
 * fails leaves a device syncing exactly where it was syncing before, with an extra copy of the vault
 * sitting in a backend it is not using. That is the safe way to be wrong.
 *
 * Three things worth reading twice:
 *
 * - **Verification re-reads.** `peek()` has to report the revision we pushed, and `pullLight()` has
 *   to decrypt back to the *same item set*. Not "the push returned 200" — a backend that accepted
 *   bytes it will not give back is exactly the failure this step exists to catch, and it is the one
 *   nobody would notice until the other device stopped seeing changes.
 * - **Drive → Chrome can be refused.** The Chrome tier is a hard 100 KB, and a vault that grew on
 *   Drive may simply not fit. Refusing with a number ("about 600 bookmarks fit; you have 2,400") is
 *   the only useful answer; migrating 600 of them is not a thing anyone wants.
 * - **A Drive vault that is already there is adopted, not overwritten.** Reconnecting a device to a
 *   Drive folder that already holds a vault is the normal case for a second computer, and uploading
 *   over it would destroy whatever the first one had. If it opens under this vault's key the merge
 *   engine takes it from there; if it does not, the two are different vaults and the migration is
 *   refused rather than resolved.
 */

import { CorruptVaultError } from '../crypto/errors.js';
import { clearBase, readSettings, writeSettings } from '../storage/local.js';
import type { VaultRepository } from '../storage/repo.js';
import { BLOCK_RATIO, SYNC_QUOTA_BYTES, projectSyncUsage } from '../storage/quota.js';
import { isDeleted, type ItemMap } from '../vault/types.js';
import { saveBase } from './base.js';
import { ChromeSyncProvider } from './chrome-provider.js';
import { DriveSyncProvider } from './drive/provider.js';
import { sameItems } from './merge.js';
import {
  AuthRequired,
  Offline,
  type ProviderId,
  type SyncProvider,
} from './provider.js';

/** Where a migration got to. Reported as it goes, so a slow upload is not a frozen screen. */
export type MigrationPhase =
  | 'authorizing'
  | 'uploading'
  | 'verifying'
  | 'switching'
  | 'cleaning'
  | 'done';

/** Why a migration did not happen. Each one is something the UI can say a useful sentence about. */
export type MigrationFailure =
  /** The vault is locked; there is nothing to move and no key to move it with. */
  | 'locked'
  /** Drive would not authorize: the consent screen was closed, or there is no OAuth client. */
  | 'auth'
  | 'offline'
  /** The vault does not fit in `chrome.storage.sync`. {@link MigrationResult.fits} says roughly how much would. */
  | 'too-large'
  /** The target already holds a *different* vault. Neither is damaged; they cannot be merged. */
  | 'mismatch'
  /** The copy did not read back as what was sent. Nothing was flipped. */
  | 'verify'
  | 'unknown';

export interface MigrationResult {
  readonly ok: boolean;
  /** The provider in force **after** the attempt — unchanged from before, when `ok` is false. */
  readonly providerId: ProviderId;
  readonly reason?: MigrationFailure;
  /** How many bookmarks the Chrome tier would hold, when the answer is `too-large`. */
  readonly fits?: number;
  /** How many the vault has, for the same message. */
  readonly items?: number;
}

export interface MigrationDeps {
  readonly repository: () => Promise<VaultRepository | null>;
  /** Injected in tests; the real ones are built here so the caller need not know how. */
  readonly provider?: (id: ProviderId) => SyncProvider;
  readonly onPhase?: (phase: MigrationPhase) => void;
  readonly now?: () => number;
  /**
   * Take the vault out of the backend being left.
   *
   * Defaults to **true for Chrome → Drive** and false the other way, and §6.6 is explicit about
   * why the two differ: `storage.sync` is a shared area, and a copy left behind there is a second
   * system of record that other devices keep pulling. A Drive file is a file in the user's own
   * Drive, and deleting it is not ours to do by default.
   */
  readonly clearSource?: boolean;
  /**
   * Delete a *different* vault found in the target and put this one there, instead of refusing.
   *
   * Default false, and the default is the important half: a vault already in the target is normally
   * this same vault, put there by another computer, and adopting it is what makes a second device
   * work at all. This is only ever true because someone was shown `'mismatch'` and chose to take the
   * folder over, which discards the other vault's only synced copy.
   */
  readonly replaceExisting?: boolean;
}

/**
 * Move to `target`, or explain why not.
 *
 * Never throws. Every failure is a {@link MigrationFailure} the UI turns into a sentence, because
 * every one of them is something the person in front of the screen has to decide what to do about.
 */
export async function migrateProvider(
  target: ProviderId,
  deps: MigrationDeps,
): Promise<MigrationResult> {
  const settings = await readSettings();
  const from = settings.providerId;
  const repo = await deps.repository();
  if (repo === null) return { ok: false, providerId: from, reason: 'locked' };

  const to = providerFor(target, deps);
  const items = repo.items();

  try {
    await repo.flush();

    if (target === 'chrome') {
      const room = fitsInChromeSync(repo, items);
      if (!room.fits) {
        return {
          ok: false,
          providerId: from,
          reason: 'too-large',
          fits: room.capacity,
          items: room.bookmarks,
        };
      }
    }

    deps.onPhase?.('authorizing');
    await to.init();

    deps.onPhase?.('uploading');
    const stamp = await placeVault(repo, to, items, deps.replaceExisting ?? false);
    if (stamp === 'mismatch') return { ok: false, providerId: from, reason: 'mismatch' };

    deps.onPhase?.('verifying');
    if (!(await verify(repo, to, items))) {
      return { ok: false, providerId: from, reason: 'verify' };
    }

    // Everything above this line is reversible by doing nothing. Everything below it is the flip.
    deps.onPhase?.('switching');
    await writeSettings({ ...(await readSettings()), providerId: target });
    await clearBase();
    await saveBase(repo.cipher(), items, {
      lastSyncedRev: repo.header().vaultRev,
      providerId: target,
      syncedAt: now(deps),
      remoteHash: stamp.contentHash,
    });

    const clearSource = deps.clearSource ?? target === 'drive';
    if (clearSource && from !== target) {
      deps.onPhase?.('cleaning');
      // Best-effort: the vault is already safely in the new backend and verified there, so failing
      // to tidy the old one must not undo a migration that worked.
      try {
        await providerFor(from, deps).disconnect();
      } catch {
        /* the old copy stays; harmless, and the user can clear it from settings */
      }
    }

    deps.onPhase?.('done');
    return { ok: true, providerId: target };
  } catch (error) {
    return { ok: false, providerId: from, reason: failureOf(error) };
  }
}

/**
 * Put the vault in the target backend, or adopt what is already there.
 *
 * `'mismatch'` rather than an exception because it is not an error in the mechanism: it means the
 * target holds a vault this key cannot open, which is a situation with legitimate answers on both
 * sides — keep this vault and take the folder over, or keep that one and join it — and none of them
 * is ours to choose. Note it is *not* evidence of a different password: a vault created a second
 * time with the same one has a new random DEK and is just as unreadable, which is precisely the case
 * a profile that lost its `storage.local` lands in.
 *
 * `replaceExisting` is that first answer, and it can only arrive from someone who was told. The
 * deletion is what makes the push that follows work: `pushLight` compares against what was found,
 * and a stamp for a vault that is no longer there would fail its own precondition.
 */
async function placeVault(
  repo: VaultRepository,
  to: SyncProvider,
  items: ItemMap,
  replaceExisting: boolean,
): Promise<{ contentHash: string } | 'mismatch'> {
  let expect = await to.peek();
  if (expect !== null) {
    const pulled = await to.pullLight();
    if (pulled !== null) {
      try {
        await repo.openEncrypted(pulled);
      } catch (error) {
        if (!(error instanceof CorruptVaultError)) throw error;
        if (!replaceExisting) return 'mismatch';
        // "Clear the target", spelled the way each backend spells it: Drive keeps its files through
        // a disconnect and deletes them on request, `storage.sync` has only the destructive one.
        if (to.deleteRemote === undefined) await to.disconnect();
        else await to.deleteRemote();
        expect = null;
      }
    }
  }
  // Pushed even when something was already there and opened: the merge that follows needs a base,
  // and the base has to describe a remote this device actually wrote. `expect` is what was found, so
  // a device writing in the gap is refused rather than overwritten.
  const vault = await repo.sealSnapshot(items, repo.header().vaultRev);
  return await to.pushLight(vault, expect);
}

/**
 * Read it back, and check it is the same vault.
 *
 * The item comparison is `sameItems`, the same one the engine uses to decide whether two sides
 * agree — so "verified" here means exactly what "nothing to push" means there.
 */
async function verify(
  repo: VaultRepository,
  to: SyncProvider,
  items: ItemMap,
): Promise<boolean> {
  const stamp = await to.peek();
  if (stamp?.vaultRev !== repo.header().vaultRev) return false;
  const pulled = await to.pullLight();
  if (pulled === null) return false;
  try {
    return sameItems(await repo.openEncrypted(pulled), items);
  } catch {
    return false;
  }
}

/**
 * Would this vault fit in `chrome.storage.sync`?
 *
 * Measured against the same 95 % block ratio the quota bar uses, and the capacity estimate is the
 * honest one: the average cost of *this vault's own* items, not a figure from the documentation. A
 * vault of 2,000 bookmarks with long notes and one of 2,000 bare URLs do not have the same answer.
 */
export function fitsInChromeSync(
  repo: VaultRepository,
  items: ItemMap,
): { fits: boolean; capacity: number; bookmarks: number } {
  // Rebuilt from the item set rather than read off the header: `BucketMeta.parts` counts provider
  // items, which is a `storage.sync` unit and means nothing about a vault that has been living on
  // Drive. The items themselves are the one thing that is exact on both tiers.
  const projected = projectSyncUsage(
    repo.header(),
    estimatedBucketSizes(repo, items),
    SYNC_QUOTA_BYTES,
  );
  const bookmarks = [...items.values()].filter((item) => !isDeleted(item)).length;
  const usable = SYNC_QUOTA_BYTES * BLOCK_RATIO;
  const perItem = bookmarks === 0 ? 0 : projected.totalBytes / bookmarks;
  return {
    fits: projected.totalBytes <= usable,
    capacity: perItem === 0 ? bookmarks : Math.floor(usable / perItem),
    bookmarks,
  };
}

/** Sealed sizes per bucket, from the local working copy's own header. */
function estimatedBucketSizes(
  repo: VaultRepository,
  items: ItemMap,
): Map<number, number> {
  const header = repo.header();
  const perBucket = new Map<number, number>();
  for (const meta of header.buckets) perBucket.set(meta.i, 0);

  // Items are spread over the buckets by a hash of their id, so an even split is the right model at
  // any size this matters at — and the *total* is what the ceiling is about, not its distribution.
  const total = [...items.values()].reduce((sum, item) => sum + JSON.stringify(item).length, 0);
  const share = header.bucketCount === 0 ? total : Math.ceil(total / header.bucketCount);
  for (const index of perBucket.keys()) {
    perBucket.set(index, share === 0 ? 0 : sealedEstimate(share));
  }
  return perBucket;
}

function sealedEstimate(plaintextBytes: number): number {
  // Bookmark JSON compresses 3–4× reliably; a third is the conservative middle, and over-estimating
  // is the safe direction for a "will it fit?" question.
  return Math.ceil(plaintextBytes / 3) + 64;
}

function failureOf(error: unknown): MigrationFailure {
  if (error instanceof AuthRequired) return 'auth';
  if (error instanceof Offline) return 'offline';
  return 'unknown';
}

function providerFor(id: ProviderId, deps: MigrationDeps): SyncProvider {
  const custom = deps.provider;
  if (custom !== undefined) return custom(id);
  return id === 'drive'
    ? new DriveSyncProvider({
        cipher: async () => (await deps.repository())?.cipher() ?? null,
      })
    : new ChromeSyncProvider();
}

function now(deps: MigrationDeps): number {
  return (deps.now ?? Date.now)();
}
