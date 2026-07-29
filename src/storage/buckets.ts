/**
 * Bucket assignment (ARCHITECTURE §5.4).
 *
 * ```
 * bucketOf(itemId, bucketCount) = SHA-256(itemId)[0..4] as uint32 % bucketCount
 * ```
 *
 * **Why bucket at all.** Every seal uses a fresh random IV, so re-encrypting the vault changes
 * every byte of ciphertext. A single-blob layout would therefore mean that adding one bookmark
 * rewrites the entire vault — on the Chrome-sync tier, that is ~13 items of the 512 available and a
 * meaningful slice of the 120-writes-per-minute budget, every time anyone edits a title. Bucketing
 * turns one edit into one bucket rewrite.
 *
 * **Why hash the id and not the content.** The assignment has to be deterministic (every device
 * must agree without coordinating), uniform (buckets stay balanced with no rebalancing logic for
 * normal growth), and independent of everything mutable — renaming a bookmark must not move it
 * between buckets, or a rename would dirty two.
 */

import { sha256 } from '../crypto/hash.js';
import { utf8 } from '../crypto/codec.js';
import { InvalidMutationError } from '../vault/errors.js';
import { isDeleted, type BucketPayload, type VaultItem } from '../vault/types.js';

/** Which bucket an item belongs to. Async because SHA-256 is; results are worth caching. */
export async function bucketOf(itemId: string, bucketCount: number): Promise<number> {
  assertBucketCount(bucketCount);
  const digest = await sha256(utf8(itemId));
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  return view.getUint32(0, false) % bucketCount;
}

/** Bucket assignments for many items in one pass, keyed by item id. */
export async function bucketsOf(
  itemIds: Iterable<string>,
  bucketCount: number,
): Promise<Map<string, number>> {
  assertBucketCount(bucketCount);
  const out = new Map<string, number>();
  for (const id of itemIds) {
    if (out.has(id)) continue;
    out.set(id, await bucketOf(id, bucketCount));
  }
  return out;
}

/**
 * Group items into bucket payloads.
 *
 * Every index in `[0, bucketCount)` gets an entry, empty ones included, so callers never have to
 * distinguish "bucket 7 is empty" from "bucket 7 was forgotten" — a distinction that would decide
 * whether a stale ciphertext gets deleted or silently kept.
 *
 * Items are sorted by id within a bucket so that identical item sets serialise to identical JSON,
 * which is what makes the plaintext HMAC tag a usable "did this change?" signal (§5.2).
 */
export async function assembleBuckets(
  items: Iterable<VaultItem>,
  bucketCount: number,
): Promise<Map<number, BucketPayload>> {
  assertBucketCount(bucketCount);
  const grouped = new Map<number, VaultItem[]>();
  for (let i = 0; i < bucketCount; i++) grouped.set(i, []);

  for (const item of items) {
    const index = await bucketOf(item.id, bucketCount);
    grouped.get(index)?.push(item);
  }

  const out = new Map<number, BucketPayload>();
  for (const [index, bucketItems] of grouped) {
    bucketItems.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.set(index, { items: bucketItems });
  }
  return out;
}

/** Flatten bucket payloads back into one item list. The inverse of {@link assembleBuckets}. */
export function disassembleBuckets(payloads: Iterable<BucketPayload>): VaultItem[] {
  const out: VaultItem[] = [];
  for (const payload of payloads) out.push(...payload.items);
  return out;
}

/**
 * The next bucket count. Doubling keeps the modulus a clean power of two of the previous one,
 * which is not required for correctness but keeps the reshuffle predictable.
 */
export function nextBucketCount(bucketCount: number): number {
  assertBucketCount(bucketCount);
  return bucketCount * 2;
}

/**
 * Whether the vault has outgrown its bucket count.
 *
 * §5.4: double when the largest bucket exceeds 60 % of what one bucket may occupy. Overshooting is
 * expensive on the sync tier (a part that no longer fits has to split), and rebalancing is a full
 * rewrite, so the trigger sits well below the ceiling rather than at it.
 */
export function shouldRebalance(
  sealedSizes: Iterable<number>,
  budgetBytesPerBucket: number,
  fillRatio = 0.6,
): boolean {
  let largest = 0;
  for (const size of sealedSizes) largest = Math.max(largest, size);
  return largest > budgetBytesPerBucket * fillRatio;
}

/**
 * Re-group every item for a new bucket count.
 *
 * A rebalance is one atomic commit that rewrites everything, and is treated as a normal (if large)
 * push. It happens roughly once per 1,000 items, so paying a full rewrite for it is the right
 * trade against carrying incremental-reshuffle machinery that would run on every write.
 */
export async function rebalance(
  items: Iterable<VaultItem>,
  bucketCount: number,
): Promise<Map<number, BucketPayload>> {
  return assembleBuckets(items, bucketCount);
}

/** Live items only — what `getAll()` returns. Tombstones stay in the buckets regardless. */
export function liveItems(items: Iterable<VaultItem>): VaultItem[] {
  return [...items].filter((item) => !isDeleted(item));
}

function assertBucketCount(bucketCount: number): void {
  if (!Number.isSafeInteger(bucketCount) || bucketCount < 1) {
    throw new InvalidMutationError(
      `Bucket count ${String(bucketCount)} is not a positive integer.`,
    );
  }
}
