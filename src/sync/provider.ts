/**
 * The `SyncProvider` boundary (ARCHITECTURE §6.1) — the seam between "the vault" and "wherever the
 * vault is kept".
 *
 * A provider moves {@link EncryptedVault} bytes and **never sees a key**. That is the whole point of
 * the interface: adding the Drive backend was a networking exercise, not a cryptographic
 * one, and nothing on the other side of this file can weaken the vault however it is implemented.
 *
 * The two contracts a provider has to honour, both of which the merge engine depends on:
 *
 * - **`peek()` must not download the payload.** It answers with a {@link RemoteStamp} and nothing
 *   else. The sync engine peeks on every trigger — a browser start, a wake, a change on another
 *   device — and a peek that fetched the vault would turn the cheap "is there anything new?"
 *   question into the expensive one.
 * - **`pushLight()` is a compare-and-swap.** It is given the stamp the caller last saw, and must
 *   fail with {@link PreconditionFailed} rather than overwrite a remote that moved since. Neither
 *   backend offers a real CAS, so both approximate it — which is exactly why the merge engine is
 *   idempotent: a lost race costs a re-merge, never a bookmark.
 */

import type { EncryptedVault } from '../vault/types.js';

/** A provider's answer to "has anything changed?", metadata only. */
export interface RemoteStamp {
  readonly vaultRev: number;
  /** `md5Checksum` on Drive, a hash of `vm.s.meta` on Chrome sync. Cheap change detection. */
  readonly contentHash: string;
  readonly modifiedAt: number;
}

export interface ProviderCapabilities {
  /** Whether thumbnails (the heavy tier) can be stored here at all. */
  readonly heavyTier: boolean;
  /** The ceiling the light tier has to fit inside, in bytes. */
  readonly maxLightBytes: number;
}

export interface ProviderUsage {
  readonly usedBytes: number;
  readonly quotaBytes: number;
}

export type ProviderId = 'chrome' | 'drive';

export interface SyncProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;

  init(): Promise<void>;
  /** Metadata-only freshness probe. MUST NOT download the payload. `null` means "no remote yet". */
  peek(): Promise<RemoteStamp | null>;
  pullLight(): Promise<EncryptedVault | null>;
  /** Compare-and-swap: fails with {@link PreconditionFailed} if the remote moved past `expect`. */
  pushLight(vault: EncryptedVault, expect: RemoteStamp | null): Promise<RemoteStamp>;

  getThumb(itemId: string): Promise<Uint8Array | null>;
  putThumb(itemId: string, blob: Uint8Array): Promise<void>;
  deleteThumb(itemId: string): Promise<void>;

  usage(): Promise<ProviderUsage>;
  /** Stop using this backend. Does not delete what is already there unless the provider says so. */
  disconnect(): Promise<void>;

  /**
   * Remove the vault from this backend while staying connected to it.
   *
   * Optional, and only meaningful where disconnecting deliberately *keeps* the copy: a Drive file is
   * the user's own, so `disconnect()` leaves it and deleting it is a second explicit act.
   * `storage.sync` has no such distinction — the keys **are** the copy, which is why the Chrome
   * provider's `disconnect()` is documented as destructive — so it does not implement this and a
   * caller that needs "clear the target" falls back to disconnecting there.
   */
  deleteRemote?(): Promise<void>;
}

/* ------------------------------------------------------------------ the error taxonomy */

/**
 * Base class for everything a provider throws.
 *
 * Same rule as the rest of the project: nothing crosses this boundary as a bare `Error`, because
 * the engine's response differs completely between "you are out of quota" (stop, tell the user, and
 * offer Drive), "you are going too fast" (wait exactly this long), and "someone else wrote first"
 * (re-merge and try again).
 */
export class SyncError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The vault no longer fits in the backend. Recoverable only by deleting or moving to Drive. */
export class QuotaExceeded extends SyncError {
  constructor(
    readonly usedBytes: number,
    readonly quotaBytes: number,
    options?: ErrorOptions,
  ) {
    super(`Sync storage is full: ${usedBytes} of ${quotaBytes} bytes.`, options);
  }
}

/** The write-rate budget is spent. `retryAfterMs` is how long until it is not. */
export class RateLimited extends SyncError {
  constructor(
    readonly retryAfterMs: number,
    options?: ErrorOptions,
  ) {
    super(`Sync write budget exhausted; retry in ${retryAfterMs} ms.`, options);
  }
}

/**
 * The remote moved since the stamp the caller was working from.
 *
 * Carries the stamp that is there now, so the engine can go straight to a merge instead of peeking
 * again for something it already knows.
 */
export class PreconditionFailed extends SyncError {
  constructor(
    readonly current: RemoteStamp | null,
    options?: ErrorOptions,
  ) {
    super('The remote vault changed since it was last read.', options);
  }
}

/** No network. Expected, frequent, and not an error worth showing until it persists. */
export class Offline extends SyncError {}

/** The backend needs the user to sign in or re-grant. Drive is the only source. */
export class AuthRequired extends SyncError {}

/** A thumbnail operation on a provider that has no heavy tier. Check `capabilities` first. */
export class HeavyTierUnsupported extends SyncError {
  constructor(providerId: ProviderId, options?: ErrorOptions) {
    super(`The ${providerId} sync provider cannot store thumbnails.`, options);
  }
}

/** What came back is not a vault: a truncated part set, an unreadable header, a torn push. */
export class CorruptRemote extends SyncError {}

/**
 * The synced vault cannot be opened with this device's key.
 *
 * Raised by the engine rather than by a provider — the provider moves bytes and has no way to know
 * — but it belongs to this taxonomy because it is what a caller has to distinguish. It means two
 * *different* vaults are sharing one sync area, which normally means someone created a second vault
 * on a profile that already had one waiting. Neither side is damaged and neither will overwrite the
 * other; they simply cannot be merged, and the only ways out are to destroy one of them or to move
 * one to a different backend.
 */
export class VaultMismatch extends SyncError {}
