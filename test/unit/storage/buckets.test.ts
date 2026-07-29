import { describe, expect, it } from 'vitest';

import { sha256 } from '../../../src/crypto/hash.js';
import { utf8 } from '../../../src/crypto/codec.js';
import {
  assembleBuckets,
  bucketOf,
  bucketsOf,
  disassembleBuckets,
  liveItems,
  nextBucketCount,
  rebalance,
  shouldRebalance,
} from '../../../src/storage/buckets.js';
import { InvalidMutationError } from '../../../src/vault/errors.js';
import { addItem, deleteItem, type MutationContext } from '../../../src/vault/model.js';
import {
  DEFAULT_BUCKET_COUNT,
  type BucketPayload,
  type ItemMap,
  type VaultItem,
} from '../../../src/vault/types.js';

const NOW = 1_750_000_000_000;

function ctx(prefix: string): MutationContext {
  let next = 0;
  return { now: NOW, rev: 1, newId: () => `${prefix}-${String(++next)}` };
}

function vaultOf(count: number): ItemMap {
  let items: ItemMap = new Map();
  const context = ctx('item');
  for (let i = 0; i < count; i++) {
    items = addItem(
      items,
      { type: 'bookmark', url: `https://example.org/${String(i)}`, title: `Item ${String(i)}` },
      context,
    ).items;
  }
  return items;
}

describe('bucketOf', () => {
  it('matches the spec formula: SHA-256(itemId)[0..4] as big-endian uint32 % bucketCount', async () => {
    const id = 'b1f2c3d4-0000-4000-8000-000000000001';
    const digest = await sha256(utf8(id));
    const expected =
      new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(0, false) % 16;
    expect(await bucketOf(id, 16)).toBe(expected);
  });

  it('is deterministic, so every device agrees without coordinating', async () => {
    const id = 'stable-id';
    expect(await bucketOf(id, 16)).toBe(await bucketOf(id, 16));
  });

  it('spreads ids across every bucket', async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(await bucketOf(`id-${String(i)}`, DEFAULT_BUCKET_COUNT));
    expect(seen.size).toBe(DEFAULT_BUCKET_COUNT);
  });

  it('rejects a bucket count that is not a positive integer', async () => {
    await expect(bucketOf('x', 0)).rejects.toThrow(InvalidMutationError);
    await expect(bucketOf('x', 1.5)).rejects.toThrow(InvalidMutationError);
  });
});

describe('bucketsOf', () => {
  it('resolves every id once', async () => {
    const assignments = await bucketsOf(['a', 'b', 'a'], 8);
    expect(assignments.size).toBe(2);
    expect(assignments.get('a')).toBe(await bucketOf('a', 8));
  });
});

describe('assembleBuckets', () => {
  it('places every item in exactly one bucket and leaves no index missing', async () => {
    const items = vaultOf(200);
    const buckets = await assembleBuckets(items.values(), DEFAULT_BUCKET_COUNT);
    expect(buckets.size).toBe(DEFAULT_BUCKET_COUNT);
    expect(disassembleBuckets(buckets.values())).toHaveLength(items.size);

    for (const [index, payload] of buckets) {
      for (const item of payload.items) {
        expect(await bucketOf(item.id, DEFAULT_BUCKET_COUNT)).toBe(index);
      }
    }
  });

  it('sorts items by id inside a bucket, so the same set always serialises the same way', async () => {
    const items = [...vaultOf(60).values()];
    const forwards = await assembleBuckets(items, 4);
    const backwards = await assembleBuckets(items.toReversed(), 4);
    expect(JSON.stringify([...forwards])).toBe(JSON.stringify([...backwards]));
  });

  it('does not move an item when its content changes', async () => {
    const items = vaultOf(1);
    const item = [...items.values()][0]!;
    const renamed: VaultItem = { ...item, title: 'A completely different title' };
    expect(await bucketOf(renamed.id, 16)).toBe(await bucketOf(item.id, 16));
  });
});

describe('rebalance', () => {
  it('preserves every item when 16 buckets become 32', async () => {
    const items = vaultOf(500);
    const before = await assembleBuckets(items.values(), DEFAULT_BUCKET_COUNT);
    const after = await rebalance(items.values(), nextBucketCount(DEFAULT_BUCKET_COUNT));

    expect(after.size).toBe(32);
    const beforeIds = disassembleBuckets(before.values())
      .map((item) => item.id)
      .toSorted();
    const afterIds = disassembleBuckets(after.values())
      .map((item) => item.id)
      .toSorted();
    expect(afterIds).toEqual(beforeIds);
    expect(afterIds).toHaveLength(500);
  });

  it('assigns every item to a bucket valid for the new count', async () => {
    const items = vaultOf(120);
    const after = await rebalance(items.values(), 32);
    for (const [index, payload] of after) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(32);
      for (const item of payload.items) expect(await bucketOf(item.id, 32)).toBe(index);
    }
  });
});

describe('shouldRebalance', () => {
  it('triggers above 60 % of the per-bucket budget and not below', () => {
    expect(shouldRebalance([100, 200, 4_800], 8_000)).toBe(false);
    expect(shouldRebalance([100, 200, 4_801], 8_000)).toBe(true);
    expect(shouldRebalance([], 8_000)).toBe(false);
  });
});

describe('liveItems', () => {
  it('drops tombstones', () => {
    const items = vaultOf(3);
    const id = [...items.keys()][0]!;
    const deleted = deleteItem(items, id, ctx('del')).items;
    expect(liveItems(deleted.values())).toHaveLength(2);
  });
});

describe('disassembleBuckets', () => {
  it('is the inverse of assembleBuckets', async () => {
    const items = vaultOf(37);
    const payloads: BucketPayload[] = [...(await assembleBuckets(items.values(), 8)).values()];
    expect(
      disassembleBuckets(payloads)
        .map((item) => item.id)
        .toSorted(),
    ).toEqual([...items.keys()].toSorted());
  });
});
