/**
 * The sync orchestrator (ARCHITECTURE §6.3): what runs, in what order, and what happens when it is
 * interrupted.
 *
 * Everything here is written for a runtime that can be killed at any instruction. An MV3 service
 * worker is torn down after ~30 seconds of inactivity, so there is no such thing as a sync that is
 * "in progress" across a wake: every trigger re-derives the whole situation from three durable
 * facts — `vm.baseMeta`, the local buckets, and a fresh `peek()` — and does the right thing from
 * wherever it finds itself. Nothing is remembered in a module variable that matters.
 *
 * The order of writes is the part worth reading twice:
 *
 * 1. **The merged vault is written locally first.** A crash after this leaves a device holding the
 *    merge it computed, which is the one copy nobody else can reconstruct.
 * 2. **Conflicts are persisted next**, before anything is pushed, so a crash cannot lose the record
 *    of a disagreement while still pushing the resolution of it.
 * 3. **Then the push**, buckets before header (the provider's job).
 * 4. **The merge base is written last, and only after the push succeeded**, because the base means
 *    exactly one thing: *this is what the remote has*. Writing it earlier would be a lie the next
 *    merge believes.
 *
 * And the rule that makes all of it safe: {@link merge} is idempotent, so redoing any step costs
 * work rather than data.
 */

import { CorruptVaultError } from '../crypto/errors.js';
import { readBaseMeta, readSettings } from '../storage/local.js';
import type { VaultCipher, VaultRepository } from '../storage/repo.js';
import type { BaseMeta, EncryptedVault, ItemMap, VaultHeader } from '../vault/types.js';
import { loadBase, loadConflicts, saveBase, saveConflicts } from './base.js';
import { ChromeSyncProvider } from './chrome-provider.js';
import { DriveSyncProvider } from './drive/provider.js';
import { merge, outboundView, sameItems, type Conflict } from './merge.js';
import {
  AuthRequired,
  CorruptRemote,
  Offline,
  PreconditionFailed,
  QuotaExceeded,
  RateLimited,
  VaultMismatch,
  type ProviderId,
  type RemoteStamp,
  type SyncProvider,
} from './provider.js';

/** Where the state machine is. Reported to the UI; never persisted. */
export type SyncPhase =
  | 'idle'
  | 'peeking'
  | 'pulling'
  | 'merging'
  | 'pushing'
  /** Finished, but there are unresolved conflicts. The vault is fully usable. */
  | 'conflict'
  | 'error'
  /** The vault is locked, so there is nothing to sync and no key to sync it with. */
  | 'locked';

/** The wire form of a sync failure. Same reasoning as `ErrorCode` in `shared/messages.ts`. */
export type SyncErrorCode =
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'OFFLINE'
  | 'AUTH_REQUIRED'
  | 'CORRUPT_REMOTE'
  | 'PRECONDITION_FAILED'
  | 'VAULT_LOCKED'
  /** Two different vaults are sharing one sync area. Neither is damaged; they cannot be merged. */
  | 'VAULT_MISMATCH'
  | 'UNKNOWN';

export interface SyncStatus {
  readonly phase: SyncPhase;
  readonly providerId: ProviderId;
  /** Epoch ms of the last successful sync, or `null` if this device has never completed one. */
  readonly lastSyncedAt: number | null;
  readonly conflicts: number;
  readonly error: SyncErrorCode | null;
  /** How long to wait before the next attempt is worth making, when the error says so. */
  readonly retryAfterMs: number | null;
  readonly usedBytes: number;
  readonly quotaBytes: number;
}

/** Everything the engine needs from the rest of the extension, injected so it stays testable. */
export interface EngineDeps {
  /** The unlocked vault, or `null`. Enforces the idle deadline before answering (session.ts). */
  readonly repository: () => Promise<VaultRepository | null>;
  readonly provider?: (id: ProviderId) => SyncProvider;
  readonly now?: () => number;
  /** Told after a sync changed the local item set, so open UIs reload. */
  readonly onVaultChanged?: () => void | Promise<void>;
  readonly onStatus?: (status: SyncStatus) => void | Promise<void>;
}

/** How long a local change waits for its neighbours before it is pushed (§6.3). */
export const LOCAL_CHANGE_DEBOUNCE_MS = 3_000;

export interface SyncOptions {
  /**
   * Push even when nothing looks to have moved.
   *
   * Resolving a conflict as "keep mine" changes no bookmark — the item already holds this device's
   * version, and the only thing that moved is the record that was keeping it out of the outbound
   * view. Without this the engine would see an unchanged `vaultRev`, conclude there was nothing to
   * send, and leave the resolution on one device.
   */
  readonly force?: boolean;
}

let deps: EngineDeps | null = null;
let inFlight: Promise<SyncStatus> | null = null;
/** Set when a trigger arrives during a sync: the run in flight cannot include what it did not see. */
let rerun = false;
let debounce: ReturnType<typeof setTimeout> | null = null;
let phase: SyncPhase = 'idle';
let lastError: SyncErrorCode | null = null;
let retryAfterMs: number | null = null;

export function configureSync(next: EngineDeps): void {
  deps = next;
}

/** Test seam: drop the injected dependencies, the cached provider, and any pending debounce. */
export function resetSync(): void {
  if (debounce !== null) clearTimeout(debounce);
  debounce = null;
  deps = null;
  inFlight = null;
  rerun = false;
  phase = 'idle';
  lastError = null;
  retryAfterMs = null;
  chromeProvider = null;
  driveProvider = null;
}

/**
 * A local change happened. Push it, once the burst it belongs to has settled.
 *
 * Debounced rather than immediate because a bulk tag of forty bookmarks is one revision but arrives
 * as one message, and because typing a note is a change per keystroke to everything upstream of the
 * repository's own coalescer.
 */
export function scheduleSync(delayMs: number = LOCAL_CHANGE_DEBOUNCE_MS): void {
  if (debounce !== null) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void syncNow();
  }, delayMs);
}

/**
 * At most one freshness probe a minute, across every wake event (§13.4).
 *
 * The triggers are all the same question asked by different parts of the browser — the browser
 * started, the worker woke, the machine came back from idle — and on Drive each one costs a network
 * request. Sixty seconds is the ceiling §13.4 sets.
 */
export const PROBE_INTERVAL_MS = 60_000;

/** `storage.session`: memory-backed, so it survives a worker teardown and not a browser restart. */
const PROBE_KEY = 'vm.probedAt';

/**
 * A wake event happened; check whether the remote moved, but not too often.
 *
 * The last probe time lives in `storage.session` rather than in a module variable **because the
 * variable would be the thing being defended against**: MV3 tears the worker down every ~30 seconds,
 * so a module-scope timestamp resets exactly as often as the events this is coalescing arrive, and
 * the coalescing would do nothing at all in the field while passing every test.
 */
export async function probe(force = false): Promise<void> {
  try {
    const at = now();
    if (!force) {
      const last = (await chrome.storage.session.get(PROBE_KEY))[PROBE_KEY];
      if (typeof last === 'number' && at - last < PROBE_INTERVAL_MS) return;
    }
    await chrome.storage.session.set({ [PROBE_KEY]: at });
  } catch {
    // Same guard, and the same reason, as `attempt()` below: this is reached from a timer and from
    // browser events, and a timer can fire into a world that is no longer there — a worker torn
    // down between the wake and the deadline, an extension being reloaded. Nobody to report it to.
    return;
  }
  await syncNow();
}

/**
 * Run a sync, or join the one already running.
 *
 * Single-flight: concurrent triggers coalesce into one run, and a trigger that arrives *during* a
 * run schedules exactly one more afterwards — the run in flight peeked before that change existed
 * and cannot be assumed to have carried it.
 */
export async function syncNow(options: SyncOptions = {}): Promise<SyncStatus> {
  if (inFlight !== null) {
    rerun = true;
    return await inFlight;
  }
  const run = (async () => {
    try {
      return await attempt(options.force === true);
    } finally {
      inFlight = null;
    }
  })();
  inFlight = run;
  const result = await run;
  if (rerun) {
    rerun = false;
    return await syncNow(options);
  }
  return result;
}

export async function status(): Promise<SyncStatus> {
  const settings = await readSettings();
  const meta = await readBaseMeta();
  const repo = await deps?.repository();
  const conflicts = repo === null || repo === undefined ? 0 : (await loadConflicts(repo.cipher())).length;
  const usage =
    repo === null || repo === undefined
      ? { usedBytes: 0, quotaBytes: 0 }
      : await usageOf(providerFor(settings.providerId));
  return {
    phase: repo === null || repo === undefined ? 'locked' : conflicts > 0 ? 'conflict' : phase,
    providerId: settings.providerId,
    lastSyncedAt: meta?.syncedAt ?? null,
    conflicts,
    error: lastError,
    retryAfterMs,
    ...usage,
  };
}

/**
 * How much room the backend reports, or zeroes.
 *
 * Deliberately swallows: `usage()` is a network request on the Drive tier, so it fails whenever
 * Drive is disconnected, unauthorized or unreachable — and a status line that cannot say "sync needs
 * you to sign in again" because asking how full the disk is threw on the way to saying it would be
 * the failure reporting its own failure. The quota bar is absent; everything else still answers.
 */
async function usageOf(provider: SyncProvider): Promise<{ usedBytes: number; quotaBytes: number }> {
  try {
    return await provider.usage();
  } catch {
    return { usedBytes: 0, quotaBytes: 0 };
  }
}

/* ------------------------------------------------------------------ the run */

/**
 * One run, and the outer guard that makes {@link syncNow} incapable of rejecting.
 *
 * The guard is not belt-and-braces. A sync is reached from a timer, and a timer can fire into a
 * world that is no longer there: an MV3 worker torn down between the debounce and its deadline, an
 * extension being reloaded, a test swapping the `chrome` global out from under it. There is nobody
 * to report that to and nothing to retry it against — but an unhandled rejection from a background
 * task is noise in a console that is supposed to stay empty, and in a service worker it is noise
 * nobody will ever read.
 */
async function attempt(force: boolean): Promise<SyncStatus> {
  try {
    const repo = await deps?.repository();
    if (repo === null || repo === undefined) {
      phase = 'locked';
      return await status();
    }

    const settings = await readSettings();
    const provider = providerFor(settings.providerId);
    lastError = null;
    retryAfterMs = null;

    try {
      await provider.init();
      const changed = await run(repo, provider, settings.providerId, force);
      if (changed) await deps?.onVaultChanged?.();
    } catch (error) {
      phase = 'error';
      lastError = toSyncErrorCode(error);
      retryAfterMs = error instanceof RateLimited ? error.retryAfterMs : null;
    }

    const current = await status();
    await deps?.onStatus?.(current);
    return current;
  } catch (error) {
    phase = 'error';
    lastError = toSyncErrorCode(error);
    return {
      phase,
      providerId: 'chrome',
      lastSyncedAt: null,
      conflicts: 0,
      error: lastError,
      retryAfterMs: null,
      usedBytes: 0,
      quotaBytes: 0,
    };
  }
}

/** The state machine proper. Returns whether the local item set changed. */
async function run(
  repo: VaultRepository,
  provider: SyncProvider,
  providerId: ProviderId,
  force: boolean,
): Promise<boolean> {
  const cipher = repo.cipher();
  // Anything the coalescer is still holding is part of "what this device has", and a push that
  // raced it would send a vault one edit behind and immediately need another round trip.
  await repo.flush();

  phase = 'peeking';
  const remote = await provider.peek();
  const meta = await readBaseMeta();
  const conflicts = await loadConflicts(cipher);
  const header = repo.header();

  if (remote === null) {
    // Nothing there yet: this device is the one that creates the remote vault.
    await publish(repo, provider, providerId, repo.items(), conflicts, header.vaultRev, null);
    return false;
  }

  const remoteMoved = meta?.remoteHash !== remote.contentHash;
  const localMoved = meta?.lastSyncedRev !== header.vaultRev;

  if (!remoteMoved && !localMoved && !force) {
    phase = conflicts.length > 0 ? 'conflict' : 'idle';
    return false;
  }

  if (!remoteMoved) {
    try {
      await publish(repo, provider, providerId, repo.items(), conflicts, header.vaultRev, remote);
      return false;
    } catch (error) {
      // Someone wrote between the peek and the push. Their stamp is on the error, so there is
      // nothing to re-read: fall straight through to the merge.
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }

  return await reconcile(repo, provider, providerId, conflicts);
}

/**
 * Pull, merge, write, push.
 *
 * The pull is unconditional here even when the local side is clean: a "fast-path pull" that skipped
 * the merge would have to trust that `lastSyncedRev` describes the local vault exactly, and the one
 * case where it does not — a pending conflict, where the local side deliberately differs from what
 * was last pushed — is exactly the case where overwriting local would discard the user's version.
 * The merge is cheap and it is right in both cases.
 */
async function reconcile(
  repo: VaultRepository,
  provider: SyncProvider,
  providerId: ProviderId,
  pending: readonly Conflict[],
): Promise<boolean> {
  phase = 'pulling';
  const cipher = repo.cipher();

  let pulled;
  try {
    pulled = await provider.pullLight();
  } catch (error) {
    if (!(error instanceof CorruptRemote)) throw error;
    // A torn remote: parts from one push under a header from another, which the bucket tags catch.
    // Repairing it by pushing this device's copy loses nothing — a torn remote is a *partial* copy
    // of some device's local state, and that device still has all of it and will push again.
    await publish(
      repo,
      provider,
      providerId,
      repo.items(),
      pending,
      repo.header().vaultRev,
      await provider.peek(),
    );
    return false;
  }
  if (pulled === null) {
    await publish(repo, provider, providerId, repo.items(), pending, repo.header().vaultRev, null);
    return false;
  }

  phase = 'merging';
  let remoteItems: ItemMap;
  try {
    remoteItems = await repo.openEncrypted(pulled);
  } catch (error) {
    // Authenticated bytes that will not open under this vault's key are not corruption — they are
    // somebody else's vault. Saying so is the difference between a status a user can act on and one
    // that retries forever without explaining itself.
    if (error instanceof CorruptVaultError) {
      throw new VaultMismatch('The synced vault was written by a different vault.', { cause: error });
    }
    throw error;
  }
  const base = await loadBase(cipher);
  const local = repo.items();
  const header = repo.header();

  const result = merge(base, local, remoteItems, {
    now: now(),
    remoteDevice: pulled.header.deviceId,
  });

  const conflicts = mergeConflictSets(pending, result.conflicts);
  const outbound = outboundView(result.merged, conflicts);

  /*
   * The remote already holds what we were about to send it.
   *
   * This is the case that decides whether two devices ever settle. Without it, every merge would
   * end in a push at a fresh revision, the other device would see a moved remote, merge, push back
   * at a fresher one, and the two would trade revisions forever without a single bookmark
   * changing. Adopting the remote's `vaultRev` verbatim here — rather than inventing a higher one —
   * is what lets both sides agree they are done.
   */
  if (sameItems(outbound, remoteItems)) {
    await repo.replaceAll(result.merged, { ...pulled.header, vaultRev: pulled.header.vaultRev });
    await saveConflicts(cipher, conflicts);
    await saveBase(cipher, outbound, {
      lastSyncedRev: pulled.header.vaultRev,
      providerId,
      syncedAt: now(),
      remoteHash: (await provider.peek())?.contentHash ?? '',
    });
    phase = conflicts.length > 0 ? 'conflict' : 'idle';
    return result.changed.length > 0;
  }

  const rev = Math.max(header.vaultRev, pulled.header.vaultRev) + 1;
  await repo.replaceAll(result.merged, adoptHeader(header, pulled.header, rev));
  await saveConflicts(cipher, conflicts);
  await publish(repo, provider, providerId, result.merged, conflicts, rev, await provider.peek());
  return result.changed.length > 0;
}

/**
 * Seal, push, and record the result as the new merge base.
 *
 * What goes out is {@link outboundView}: this device's vault with the *remote* side put back for
 * every unresolved conflict. That is §6.5 in one line — nothing is pushed for a conflicted item, so
 * the other device's answer survives untouched, while the rest of the vault keeps syncing normally.
 */
async function publish(
  repo: VaultRepository,
  provider: SyncProvider,
  providerId: ProviderId,
  items: ItemMap,
  conflicts: readonly Conflict[],
  vaultRev: number,
  expect: RemoteStamp | null,
): Promise<void> {
  phase = 'pushing';
  const outbound = outboundView(items, conflicts);
  const vault = await repo.sealSnapshot(outbound, vaultRev);
  const stamp = await provider.pushLight(vault, expect);

  const meta: BaseMeta = {
    lastSyncedRev: vaultRev,
    providerId,
    syncedAt: now(),
    remoteHash: stamp.contentHash,
  };
  await saveBase(repo.cipher(), outbound, meta);
  phase = conflicts.length > 0 ? 'conflict' : 'idle';
}

/**
 * The header the merged vault commits under.
 *
 * `kdf` and `wrappedDek` are vault-global rather than per-device — they are how a password changed
 * on one machine reaches the others — so they come from whichever side is further along. Everything
 * else that identifies *this install*, `deviceId` above all, is preserved by `replaceAll`.
 */
function adoptHeader(local: VaultHeader, remote: VaultHeader, rev: number): VaultHeader {
  const authoritative = remote.vaultRev > local.vaultRev ? remote : local;
  return {
    ...local,
    kdf: authoritative.kdf,
    wrappedDek: authoritative.wrappedDek,
    bucketCount: authoritative.bucketCount,
    createdAt: Math.min(local.createdAt, remote.createdAt),
    vaultRev: rev,
  };
}

/**
 * Fold freshly detected conflicts into the ones already waiting.
 *
 * Keyed by item id, newest wins: a second disagreement about the same bookmark supersedes the
 * first, because the record carries whole versions and the older pair is a snapshot of a state
 * neither device is in any more.
 */
function mergeConflictSets(
  pending: readonly Conflict[],
  fresh: readonly Conflict[],
): readonly Conflict[] {
  const byId = new Map(pending.map((conflict) => [conflict.id, conflict]));
  for (const conflict of fresh) byId.set(conflict.id, conflict);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ------------------------------------------------------------------ adopting a synced vault */

/**
 * Is there a vault waiting in the sync area?
 *
 * One `peek()` — the header and nothing else, no ciphertext and no key. Asked by a profile that has
 * no vault of its own, to decide whether to offer *unlock* or *create*. Never throws: a backend
 * that cannot answer is not a reason to keep someone out of a screen, and the worst case is being
 * offered the create flow when a synced vault existed after all.
 */
export async function hasRemoteVault(): Promise<boolean> {
  try {
    const settings = await readSettings();
    return (await providerFor(settings.providerId).peek()) !== null;
  } catch {
    return false;
  }
}

/** The synced vault as ciphertext, with the stamp it was read at. `null` if there is none. */
export async function fetchRemote(): Promise<{ vault: EncryptedVault; stamp: RemoteStamp } | null> {
  const settings = await readSettings();
  const provider = providerFor(settings.providerId);
  await provider.init();
  const stamp = await provider.peek();
  if (stamp === null) return null;
  const vault = await provider.pullLight();
  return vault === null ? null : { vault, stamp };
}

/**
 * Record a freshly adopted vault as the merge base.
 *
 * Without this the next sync would see no base, treat every item as a local add, and push the whole
 * vault straight back at the device it just came from. With it, the first sync after adoption
 * correctly concludes there is nothing to do.
 */
export async function markAdopted(
  repo: VaultRepository,
  items: ItemMap,
  stamp: RemoteStamp,
  vaultRev: number,
): Promise<void> {
  const settings = await readSettings();
  await saveBase(repo.cipher(), items, {
    lastSyncedRev: vaultRev,
    providerId: settings.providerId,
    syncedAt: now(),
    remoteHash: stamp.contentHash,
  });
}

/* ------------------------------------------------------------------ conflict resolution */

export type Resolution = 'mine' | 'theirs' | 'both';

/**
 * What resolving a conflict does to the vault, expressed as the item the local side should hold.
 *
 * `mine` keeps what is already there and simply drops the record, which is what lets the next push
 * carry it: an item stops being overlaid with the remote side the moment its conflict is gone.
 * `theirs` adopts the other version. `both` keeps this device's and adds theirs beside it under a
 * fresh id, which is the only answer that loses nothing at all — and the only one available when
 * one side is a tombstone, where "keep both" would mean keeping a deletion.
 */
export function canKeepBoth(conflict: Conflict): boolean {
  return conflict.kind !== 'edit-delete';
}

export async function listConflicts(repo: VaultRepository): Promise<Conflict[]> {
  return await loadConflicts(repo.cipher());
}

/** Drop conflict records by item id, leaving the rest pending. */
export async function forgetConflicts(
  repo: VaultRepository,
  ids: readonly string[],
): Promise<Conflict[]> {
  const cipher = repo.cipher();
  const dropped = new Set(ids);
  const kept = (await loadConflicts(cipher)).filter((conflict) => !dropped.has(conflict.id));
  await saveConflicts(cipher, kept);
  return kept;
}

/* ------------------------------------------------------------------ plumbing */

export function toSyncErrorCode(error: unknown): SyncErrorCode {
  if (error instanceof QuotaExceeded) return 'QUOTA_EXCEEDED';
  if (error instanceof RateLimited) return 'RATE_LIMITED';
  if (error instanceof Offline) return 'OFFLINE';
  if (error instanceof AuthRequired) return 'AUTH_REQUIRED';
  if (error instanceof CorruptRemote) return 'CORRUPT_REMOTE';
  if (error instanceof PreconditionFailed) return 'PRECONDITION_FAILED';
  if (error instanceof VaultMismatch) return 'VAULT_MISMATCH';
  return 'UNKNOWN';
}

let chromeProvider: SyncProvider | null = null;
let driveProvider: SyncProvider | null = null;

/**
 * The live provider for a settings value.
 *
 * Cached per worker because both are cheap to hold and neither keeps state that matters across a
 * teardown — the Drive one's file ids live in `storage.local` and its token in `storage.session`,
 * precisely so that a worker Chrome killed mid-sync rebuilds them rather than re-authorizing.
 */
function providerFor(id: ProviderId): SyncProvider {
  const custom = deps?.provider;
  if (custom !== undefined) return custom(id);
  if (id === 'drive') {
    driveProvider ??= new DriveSyncProvider({ cipher: () => vaultCipher() });
    return driveProvider;
  }
  chromeProvider ??= new ChromeSyncProvider();
  return chromeProvider;
}

/**
 * The unlocked vault's cipher, for the one thing on the Drive path that has to be sealed.
 *
 * `null` while the vault is locked, which is the honest answer and the one that makes a refresh
 * token unusable without the master password (§13.2). Never throws: this is asked for on a path
 * that already has to work when the vault is locked.
 */
async function vaultCipher(): Promise<VaultCipher | null> {
  try {
    return (await deps?.repository())?.cipher() ?? null;
  } catch {
    return null;
  }
}

function now(): number {
  return (deps?.now ?? Date.now)();
}

