import { describe, expect, it } from 'vitest';

import { toBase64Url } from '../../../src/crypto/codec.js';
import {
  BLOCK_RATIO,
  SYNC_PART_CHARS,
  SYNC_QUOTA_BYTES,
  WARN_RATIO,
  base64UrlLength,
  estimateSealedBytes,
  partsFor,
  projectSyncUsage,
  quotaLevel,
  syncBytesFor,
} from '../../../src/storage/quota.js';
import { VAULT_MAGIC, type VaultHeader } from '../../../src/vault/types.js';

const HEADER: VaultHeader = {
  magic: VAULT_MAGIC,
  schemaVersion: 2,
  kdf: { alg: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: toBase64Url(new Uint8Array(32)) },
  wrappedDek: { iv: 'A'.repeat(16), ct: 'A'.repeat(64) },
  vaultRev: 137,
  bucketCount: 16,
  buckets: Array.from({ length: 16 }, (_unused, i) => ({
    i,
    rev: 132,
    parts: 1,
    tag: 'AAAAAAAAAAA',
  })),
  createdAt: 1_750_000_000_000,
  updatedAt: 1_750_000_000_000,
  deviceId: 'device-1',
};

describe('base64UrlLength', () => {
  it('agrees with the encoder for every remainder', () => {
    for (let n = 0; n < 20; n++) {
      expect(base64UrlLength(n), String(n)).toBe(toBase64Url(new Uint8Array(n)).length);
    }
  });
});

describe('partsFor', () => {
  it('needs no provider item for an empty bucket', () => {
    expect(partsFor(0)).toBe(0);
  });

  it('splits at the per-item character budget', () => {
    const oneFullPart = Math.floor((SYNC_PART_CHARS * 3) / 4);
    expect(partsFor(oneFullPart)).toBe(1);
    expect(partsFor(oneFullPart + 1)).toBe(2);
  });
});

describe('syncBytesFor', () => {
  it('charges the key name as well as the value, the way Chrome does', () => {
    const sealed = 3_000;
    expect(syncBytesFor(sealed, 0)).toBeGreaterThan(base64UrlLength(sealed));
  });

  it('charges nothing for an empty bucket', () => {
    expect(syncBytesFor(0, 4)).toBe(0);
  });
});

describe('projectSyncUsage', () => {
  it('reports a small vault as comfortably inside the quota', () => {
    const buckets = new Map(Array.from({ length: 16 }, (_unused, i) => [i, 400]));
    const projection = projectSyncUsage(HEADER, buckets);
    expect(projection.level).toBe('ok');
    expect(projection.quotaBytes).toBe(SYNC_QUOTA_BYTES);
    expect(projection.totalBytes).toBe(projection.headerBytes + projection.bucketBytes);
    expect(projection.parts).toBe(17); // 16 buckets + the header item
  });

  it('counts the header even when there is nothing in the vault', () => {
    const projection = projectSyncUsage(HEADER, new Map());
    expect(projection.bucketBytes).toBe(0);
    expect(projection.headerBytes).toBeGreaterThan(0);
    expect(projection.parts).toBe(1);
  });

  it('warns at 70 % and blocks at 95 %', () => {
    const atWarn = Math.ceil(((SYNC_QUOTA_BYTES * WARN_RATIO) / 16) * 0.75);
    const warn = projectSyncUsage(
      HEADER,
      new Map(Array.from({ length: 16 }, (_u, i) => [i, atWarn])),
    );
    expect(warn.level).toBe('warn');

    const atBlock = Math.ceil(((SYNC_QUOTA_BYTES * BLOCK_RATIO) / 16) * 0.75);
    const full = projectSyncUsage(
      HEADER,
      new Map(Array.from({ length: 16 }, (_u, i) => [i, atBlock])),
    );
    expect(full.level).toBe('full');
  });

  it('is allowed to report a ratio above 1 rather than clamping a real overflow away', () => {
    const projection = projectSyncUsage(HEADER, new Map([[0, 200_000]]));
    expect(projection.ratio).toBeGreaterThan(1);
    expect(projection.level).toBe('full');
  });

  it('stays under the quota at the documented ~600-bookmark comfort ceiling', () => {
    // ARCHITECTURE §5.3: ~75 compressed bytes per bookmark across 16 buckets. Phase 7 measures a
    // real fixture; this pins the arithmetic the estimate is built on.
    const perBucket = estimateSealedBytes(Math.ceil((600 * 75) / 16));
    const projection = projectSyncUsage(
      HEADER,
      new Map(Array.from({ length: 16 }, (_u, i) => [i, perBucket])),
    );
    expect(projection.level).toBe('ok');
  });
});

describe('quotaLevel', () => {
  it('maps ratios to the three states', () => {
    expect(quotaLevel(0)).toBe('ok');
    expect(quotaLevel(WARN_RATIO - 0.01)).toBe('ok');
    expect(quotaLevel(WARN_RATIO)).toBe('warn');
    expect(quotaLevel(BLOCK_RATIO)).toBe('full');
  });
});

describe('estimateSealedBytes', () => {
  it('rounds up to the padding boundary and adds the envelope framing', () => {
    expect(estimateSealedBytes(0)).toBe(256 + 29);
    expect(estimateSealedBytes(252)).toBe(256 + 29);
    expect(estimateSealedBytes(253)).toBe(512 + 29);
  });

  it('over-estimates rather than under-estimates, because compression is not counted', () => {
    expect(estimateSealedBytes(10_000)).toBeGreaterThan(10_000);
  });
});
