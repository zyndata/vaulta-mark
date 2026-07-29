/**
 * Byte accounting, and the projection of "does this vault still fit in `chrome.storage.sync`?"
 * (ARCHITECTURE §5.2, §5.3).
 *
 * Phase 7 is what enforces this; Phase 3 computes it, because the numbers depend only on the local
 * working copy and the answer has to be available *before* a user is offered the sync tier. Running
 * out of `storage.sync` quota mid-push is the failure mode this exists to make impossible: the
 * write fails, the header still points at the old revision, and the user is left with a vault that
 * says it is syncing and is not.
 *
 * The projection is deliberately pessimistic — it counts what a push would cost, not what the last
 * one did — because being wrong in the optimistic direction means telling someone their bookmarks
 * are safely synced when they are not.
 */

import { ENVELOPE_OVERHEAD_BYTES } from '../crypto/envelope.js';
import { PAD_BLOCK_BYTES } from '../crypto/codec.js';
import { canonicalJson } from '../vault/model.js';
import type { VaultHeader } from '../vault/types.js';

/** Chrome's documented `chrome.storage.sync` ceiling. */
export const SYNC_QUOTA_BYTES = 102_400;

/**
 * Base64url characters we allow in one provider item.
 *
 * Chrome's `QUOTA_BYTES_PER_ITEM` is 8,192 and charges the key name plus the JSON encoding of the
 * value — so the quotes count, and so does `vm.s.b15.3`. 7,600 leaves headroom for both without
 * having to compute the key length at every call site.
 */
export const SYNC_PART_CHARS = 7_600;

/** Warn here (§5.3). Early enough that "connect Drive" is a decision, not a rescue. */
export const WARN_RATIO = 0.7;
/** Block new adds here. Edits and deletes still work — a full vault must not be a stuck vault. */
export const BLOCK_RATIO = 0.95;

export type QuotaLevel = 'ok' | 'warn' | 'full';

export interface SyncProjection {
  /** Bytes the plaintext header would occupy. */
  readonly headerBytes: number;
  /** Bytes the base64url-encoded bucket parts would occupy, key names included. */
  readonly bucketBytes: number;
  readonly totalBytes: number;
  readonly quotaBytes: number;
  /** `totalBytes / quotaBytes`, clamped at nothing — it is allowed to exceed 1. */
  readonly ratio: number;
  /** Provider items the push would need, against Chrome's `MAX_ITEMS` of 512. */
  readonly parts: number;
  readonly level: QuotaLevel;
}

/** base64url is 4 characters per 3 bytes, unpadded. */
export function base64UrlLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4 - ((3 - (byteLength % 3)) % 3);
}

/** How many provider items a sealed bucket of this size needs. An empty bucket needs none. */
export function partsFor(sealedBytes: number): number {
  if (sealedBytes === 0) return 0;
  return Math.ceil(base64UrlLength(sealedBytes) / SYNC_PART_CHARS);
}

/**
 * What one sealed bucket costs in the sync tier: its base64url length plus the key name and the two
 * JSON quotes Chrome charges for each part.
 */
export function syncBytesFor(sealedBytes: number, bucketIndex: number): number {
  const parts = partsFor(sealedBytes);
  if (parts === 0) return 0;
  const keyOverhead = parts * (`vm.s.b${bucketIndex}.${parts}`.length + 2);
  return base64UrlLength(sealedBytes) + keyOverhead;
}

/** Project what pushing this exact local state to `chrome.storage.sync` would cost. */
export function projectSyncUsage(
  header: VaultHeader,
  sealedBuckets: ReadonlyMap<number, number>,
  quotaBytes: number = SYNC_QUOTA_BYTES,
): SyncProjection {
  const headerBytes = canonicalJson(header).length + 'vm.s.meta'.length;

  let bucketBytes = 0;
  let parts = 0;
  for (const [index, sealedBytes] of sealedBuckets) {
    bucketBytes += syncBytesFor(sealedBytes, index);
    parts += partsFor(sealedBytes);
  }

  const totalBytes = headerBytes + bucketBytes;
  const ratio = totalBytes / quotaBytes;
  return {
    headerBytes,
    bucketBytes,
    totalBytes,
    quotaBytes,
    ratio,
    parts: parts + 1, // + the header item
    level: quotaLevel(ratio),
  };
}

export function quotaLevel(ratio: number): QuotaLevel {
  if (ratio >= BLOCK_RATIO) return 'full';
  if (ratio >= WARN_RATIO) return 'warn';
  return 'ok';
}

/**
 * A rough sealed size for `plaintextBytes` of payload, without doing the work.
 *
 * Used for "will this fit?" before committing, where actually gzipping every bucket to find out
 * would cost more than the answer is worth. Assumes no compression, so it over-estimates by the
 * 3–4× that bookmark JSON reliably achieves — over-estimating is the safe direction here.
 */
export function estimateSealedBytes(plaintextBytes: number): number {
  const padded = Math.ceil((4 + plaintextBytes) / PAD_BLOCK_BYTES) * PAD_BLOCK_BYTES;
  return padded + ENVELOPE_OVERHEAD_BYTES;
}
