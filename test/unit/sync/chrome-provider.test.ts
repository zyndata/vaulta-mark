/**
 * `ChromeSyncProvider` against the real `chrome.storage.sync` limits (ARCHITECTURE §5.2).
 *
 * The mock enforces `QUOTA_BYTES`, `QUOTA_BYTES_PER_ITEM`, `MAX_ITEMS` and both write-rate
 * ceilings, so a provider that writes an 8 KB value or floods the budget fails here rather than in
 * the field. The provider never decrypts anything, so the "vault" in these tests is a header and a
 * few maps of arbitrary bytes — which is the point of the interface.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toBase64Url, type Bytes } from '../../../src/crypto/codec.js';
import {
  ChromeSyncProvider,
  SYNC_BUCKET_PREFIX,
  SYNC_META_KEY,
  partKey,
  stampOf,
} from '../../../src/sync/chrome-provider.js';
import {
  CorruptRemote,
  HeavyTierUnsupported,
  PreconditionFailed,
  QuotaExceeded,
} from '../../../src/sync/provider.js';
import { WriteBudget, type BudgetStore } from '../../../src/sync/rate.js';
import { SYNC_PART_CHARS, partsFor } from '../../../src/storage/quota.js';
import { SCHEMA_VERSION, VAULT_MAGIC, type EncryptedVault, type VaultHeader } from '../../../src/vault/types.js';
import { installChromeMock, itemBytes, uninstallChromeMock, SYNC_LIMITS, type ChromeMock } from '../../mocks/chrome.js';

let mock: ChromeMock;
let budgetLog: number[] = [];

const budgetStore: BudgetStore = {
  read: () => Promise.resolve(budgetLog),
  write: (stamps) => {
    budgetLog = [...stamps];
    return Promise.resolve();
  },
};

function provider(): ChromeSyncProvider {
  return new ChromeSyncProvider({
    budget: new WriteBudget({ now: () => mock.clock.now(), store: budgetStore }),
    now: () => mock.clock.now(),
  });
}

/** Deterministic pseudo-ciphertext: the provider never looks inside, only at the length. */
function bytes(length: number, seed = 1): Bytes {
  const out = new Uint8Array(new ArrayBuffer(length));
  for (let index = 0; index < length; index++) out[index] = (index * 31 + seed) % 251;
  return out;
}

function vault(buckets: ReadonlyMap<number, Bytes>, vaultRev = 1, bucketCount = 4): EncryptedVault {
  const header: VaultHeader = {
    magic: VAULT_MAGIC,
    schemaVersion: SCHEMA_VERSION,
    kdf: { alg: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: toBase64Url(new Uint8Array(32)) },
    wrappedDek: { iv: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(64) },
    vaultRev,
    bucketCount,
    buckets: Array.from({ length: bucketCount }, (_unused, i) => {
      const sealed = buckets.get(i);
      return {
        i,
        rev: vaultRev,
        parts: sealed === undefined ? 0 : partsFor(sealed.length),
        // Stands in for `HMAC(k_hmac, plaintext)`: the provider only ever compares tags for
        // equality, so what matters is that identical content produces an identical tag.
        tag: sealed === undefined ? 'empty' : `tag-${String(sealed.length)}-${String(sealed[0])}`,
      };
    }),
    createdAt: 1,
    updatedAt: 1,
    deviceId: 'device-under-test',
  };
  return { header, buckets };
}

beforeEach(() => {
  mock = installChromeMock();
  budgetLog = [];
});

afterEach(() => {
  uninstallChromeMock();
});

/* ------------------------------------------------------------------ the happy path */

describe('peek and push', () => {
  it('peeks at nothing when no device has ever pushed', async () => {
    expect(await provider().peek()).toBeNull();
    expect(await provider().pullLight()).toBeNull();
  });

  it('creates the remote, and reads only the header to say so', async () => {
    const local = vault(new Map([[0, bytes(400)]]));
    const stamp = await provider().pushLight(local, null);

    expect(stamp.vaultRev).toBe(1);
    expect(await provider().peek()).toEqual(stamp);

    const keys = Object.keys(mock.storage.sync.snapshot());
    expect(keys).toContain(SYNC_META_KEY);
    expect(keys).toContain(partKey(0, 0));
  });

  it('round-trips every bucket byte for byte', async () => {
    const buckets = new Map([
      [0, bytes(400, 3)],
      [2, bytes(21_000, 7)],
    ]);
    await provider().pushLight(vault(buckets), null);

    const pulled = await provider().pullLight();
    expect(pulled).not.toBeNull();
    expect([...pulled!.buckets.keys()].sort()).toEqual([0, 2]);
    expect([...pulled!.buckets.get(0)!]).toEqual([...buckets.get(0)!]);
    expect([...pulled!.buckets.get(2)!]).toEqual([...buckets.get(2)!]);
  });

  it('splits a bucket into parts that each fit Chrome’s per-item cap', async () => {
    // 21,000 bytes is 28,000 base64url characters — four parts at 7,600 each.
    await provider().pushLight(vault(new Map([[0, bytes(21_000)]])), null);

    const snapshot = mock.storage.sync.snapshot();
    const parts = Object.keys(snapshot).filter((key) => key.startsWith(SYNC_BUCKET_PREFIX));
    expect(parts).toHaveLength(4);
    for (const key of parts) {
      expect((snapshot[key] as string).length).toBeLessThanOrEqual(SYNC_PART_CHARS);
      expect(itemBytes(key, snapshot[key])).toBeLessThanOrEqual(SYNC_LIMITS.QUOTA_BYTES_PER_ITEM);
    }
  });
});

/* ------------------------------------------------------------------ writing as little as possible */

describe('what a push actually writes', () => {
  it('writes buckets before the header, always', async () => {
    const calls: string[][] = [];
    const original = mock.storage.sync.set;
    mock.storage.sync.set = (items) => {
      calls.push(Object.keys(items));
      return original(items);
    };

    await provider().pushLight(vault(new Map([[0, bytes(400)]])), null);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([partKey(0, 0)]);
    expect(calls[1]).toEqual([SYNC_META_KEY]);
  });

  it('skips a bucket whose plaintext tag did not change', async () => {
    const first = new Map([
      [0, bytes(400, 1)],
      [1, bytes(400, 2)],
    ]);
    const stamp = await provider().pushLight(vault(first, 1), null);

    // Bucket 1 is re-sealed with completely different ciphertext — a fresh IV changes every byte —
    // but its plaintext, and therefore its tag, is the same. It must not be written again.
    const second = new Map([
      [0, bytes(410, 1)],
      [1, bytes(400, 2)],
    ]);
    const written: string[] = [];
    const original = mock.storage.sync.set;
    mock.storage.sync.set = (items) => {
      written.push(...Object.keys(items));
      return original(items);
    };

    await provider().pushLight(vault(second, 2), stamp);
    expect(written).toContain(partKey(0, 0));
    expect(written).not.toContain(partKey(1, 0));
  });

  it('removes the parts a shrinking bucket no longer needs', async () => {
    const stamp = await provider().pushLight(vault(new Map([[0, bytes(21_000)]])), null);
    expect(Object.keys(mock.storage.sync.snapshot())).toContain(partKey(0, 3));

    await provider().pushLight(vault(new Map([[0, bytes(400)]]), 2), stamp);
    const keys = Object.keys(mock.storage.sync.snapshot());
    expect(keys).toContain(partKey(0, 0));
    expect(keys).not.toContain(partKey(0, 1));
    expect(keys).not.toContain(partKey(0, 3));
  });

  it('spends at most three writes on a whole push', async () => {
    const stamp = await provider().pushLight(vault(new Map([[0, bytes(21_000)]])), null);
    const before = budgetLog.length;
    await provider().pushLight(vault(new Map([[0, bytes(400)]]), 2), stamp);
    expect(budgetLog.length - before).toBeLessThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ compare-and-swap */

describe('compare-and-swap', () => {
  it('refuses a push whose expected stamp is stale, and says what is there now', async () => {
    const stale = await provider().pushLight(vault(new Map([[0, bytes(400)]])), null);
    const current = await provider().pushLight(vault(new Map([[0, bytes(500)]]), 2), stale);

    await expect(
      provider().pushLight(vault(new Map([[0, bytes(600)]]), 3), stale),
    ).rejects.toBeInstanceOf(PreconditionFailed);

    try {
      await provider().pushLight(vault(new Map([[0, bytes(600)]]), 3), stale);
    } catch (error) {
      expect((error as PreconditionFailed).current).toEqual(current);
    }
  });

  it('refuses to create a remote that already exists', async () => {
    await provider().pushLight(vault(new Map([[0, bytes(400)]])), null);
    await expect(
      provider().pushLight(vault(new Map([[0, bytes(400)]]), 2), null),
    ).rejects.toBeInstanceOf(PreconditionFailed);
  });

  it('notices a remote that moved between the check and the write', async () => {
    const stamp = await provider().pushLight(vault(new Map([[0, bytes(400)]])), null);

    // Another device lands its header in the window between our verification read and our own set.
    const original = mock.storage.sync.set;
    mock.storage.sync.set = async (items) => {
      await original(items);
      if (SYNC_META_KEY in items) {
        mock.storage.sync.set = original;
        await original({ [SYNC_META_KEY]: vault(new Map(), 99).header });
      }
    };

    await expect(
      provider().pushLight(vault(new Map([[0, bytes(500)]]), 2), stamp),
    ).rejects.toBeInstanceOf(PreconditionFailed);
  });

  it('gives the same stamp for the same header and a different one for a changed bucket', async () => {
    const one = await stampOf(vault(new Map([[0, bytes(400)]])).header, 0);
    const same = await stampOf(vault(new Map([[0, bytes(400)]])).header, 0);
    const other = await stampOf(vault(new Map([[0, bytes(401)]])).header, 0);
    expect(same.contentHash).toBe(one.contentHash);
    expect(other.contentHash).not.toBe(one.contentHash);
  });
});

/* ------------------------------------------------------------------ failure */

describe('when things are wrong', () => {
  it('refuses a vault that would not fit in the quota', async () => {
    // Comfortably past 102,400 bytes once base64url has added its third.
    await expect(
      provider().pushLight(vault(new Map([[0, bytes(90_000)]])), null),
    ).rejects.toBeInstanceOf(QuotaExceeded);
  });

  it('reports a header it cannot read as a corrupt remote', async () => {
    await mock.storage.sync.set({ [SYNC_META_KEY]: { not: 'a header' } });
    await expect(provider().peek()).rejects.toBeInstanceOf(CorruptRemote);
    await expect(provider().pullLight()).rejects.toBeInstanceOf(CorruptRemote);
  });

  it('reports a torn push — a header promising a part that is not there', async () => {
    await provider().pushLight(vault(new Map([[0, bytes(21_000)]])), null);
    await mock.storage.sync.remove(partKey(0, 2));
    await expect(provider().pullLight()).rejects.toBeInstanceOf(CorruptRemote);
  });

  it('reports a part that is not base64url', async () => {
    await provider().pushLight(vault(new Map([[0, bytes(400)]])), null);
    await mock.storage.sync.set({ [partKey(0, 0)]: 'not base64url!!' });
    await expect(provider().pullLight()).rejects.toBeInstanceOf(CorruptRemote);
  });
});

/* ------------------------------------------------------------------ the rest of the interface */

describe('capabilities and housekeeping', () => {
  it('has no heavy tier, and says so both ways', async () => {
    const chrome_ = provider();
    expect(chrome_.capabilities.heavyTier).toBe(false);
    expect(chrome_.capabilities.maxLightBytes).toBe(SYNC_LIMITS.QUOTA_BYTES);
    // A missing preview is a fact, not a failure; storing one is a caller bug.
    await expect(chrome_.getThumb()).resolves.toBeNull();
    await expect(chrome_.putThumb()).rejects.toBeInstanceOf(HeavyTierUnsupported);
    await expect(chrome_.deleteThumb()).rejects.toBeInstanceOf(HeavyTierUnsupported);
  });

  it('reports usage against the documented ceiling, with the warn and block bands', async () => {
    await provider().pushLight(vault(new Map([[0, bytes(400)]])), null);
    const usage = await provider().usage();
    expect(usage.quotaBytes).toBe(SYNC_LIMITS.QUOTA_BYTES);
    expect(usage.usedBytes).toBeGreaterThan(0);
    expect((await provider().quota()).level).toBe('ok');
  });

  it('takes the vault out of the sync area on disconnect', async () => {
    await provider().pushLight(vault(new Map([[0, bytes(400)]])), null);
    await mock.storage.sync.set({ 'unrelated.key': 'kept' });

    await provider().disconnect();

    const keys = Object.keys(mock.storage.sync.snapshot());
    expect(keys).toEqual(['unrelated.key']);
    // Nothing to remove is not an error, and must not spend a write.
    const before = budgetLog.length;
    await provider().disconnect();
    expect(budgetLog).toHaveLength(before);
  });

  it('initialises without touching storage', async () => {
    await provider().init();
    expect(Object.keys(mock.storage.sync.snapshot())).toEqual([]);
  });
});
