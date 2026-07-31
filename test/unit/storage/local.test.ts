import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toBase64Url } from '../../../src/crypto/codec.js';
import { CorruptVaultError } from '../../../src/crypto/errors.js';
import {
  LOCAL_KEYS,
  bucketKey,
  clearVault,
  listVaultKeys,
  localBytesInUse,
  parseHeader,
  readBase,
  readBaseMeta,
  readBucket,
  readBuckets,
  readHeader,
  readSettings,
  writeBase,
  writeBuckets,
  writeHeader,
  writeSettings,
} from '../../../src/storage/local.js';
import {
  DEFAULT_SETTINGS,
  DETAIL_WIDTH,
  IDLE_TIMEOUT_NEVER,
  SIDEBAR_WIDTH,
  VAULT_MAGIC,
  type VaultHeader,
} from '../../../src/vault/types.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

let mock: ChromeMock;

const HEADER: VaultHeader = {
  magic: VAULT_MAGIC,
  schemaVersion: 2,
  kdf: { alg: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: toBase64Url(new Uint8Array(32)) },
  wrappedDek: { iv: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(64) },
  vaultRev: 1,
  bucketCount: 2,
  buckets: [
    { i: 0, rev: 1, parts: 0, tag: 'AAAAAAAAAAA' },
    { i: 1, rev: 1, parts: 0, tag: 'AAAAAAAAAAA' },
  ],
  createdAt: 1,
  updatedAt: 1,
  deviceId: 'device-1',
};

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('header', () => {
  it('round-trips', async () => {
    expect(await readHeader()).toBeNull();
    await writeHeader(HEADER);
    expect(await readHeader()).toEqual(HEADER);
  });

  it('is stored in the clear, by necessity and by design', async () => {
    await writeHeader(HEADER);
    // The KDF parameters cannot sit behind the key they are needed to derive (ARCHITECTURE §3.1).
    const stored = mock.storage.local.snapshot()[LOCAL_KEYS.meta] as VaultHeader;
    expect(stored.kdf.iterations).toBe(600_000);
  });

  it('rejects anything that is not a VaultaMark header', () => {
    expect(() => parseHeader(null)).toThrow(CorruptVaultError);
    expect(() => parseHeader('nope')).toThrow(CorruptVaultError);
    expect(() => parseHeader({ ...HEADER, magic: 'SOMETHINGELSE' })).toThrow(CorruptVaultError);
  });

  it('rejects a header with a field of the wrong type', () => {
    expect(() => parseHeader({ ...HEADER, vaultRev: 'one' })).toThrow(CorruptVaultError);
    expect(() => parseHeader({ ...HEADER, deviceId: 7 })).toThrow(CorruptVaultError);
    expect(() => parseHeader({ ...HEADER, kdf: { alg: 'x' } })).toThrow(CorruptVaultError);
    expect(() => parseHeader({ ...HEADER, kdf: null })).toThrow(CorruptVaultError);
    expect(() => parseHeader({ ...HEADER, wrappedDek: { iv: 'a' } })).toThrow(CorruptVaultError);
    expect(() => parseHeader({ ...HEADER, wrappedDek: null })).toThrow(CorruptVaultError);
    expect(() => parseHeader({ ...HEADER, buckets: 'nope' })).toThrow(CorruptVaultError);
    expect(() => parseHeader({ ...HEADER, buckets: [{ i: 0 }] })).toThrow(CorruptVaultError);
    expect(() => parseHeader({ ...HEADER, buckets: [null] })).toThrow(CorruptVaultError);
  });

  it('does not reject a newer schema version — the repository owns that decision', () => {
    expect(() => parseHeader({ ...HEADER, schemaVersion: 99 })).not.toThrow();
  });
});

describe('buckets', () => {
  it('round-trips sealed bytes as base64url', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    await writeBuckets(new Map([[3, bytes]]));
    expect([...(await readBucket(3))!]).toEqual([...bytes]);
    // Stored as a string: `storage.local` JSON-encodes its values, so a Uint8Array would come
    // back as {"0":1,…} at five bytes of quota per byte of ciphertext.
    expect(typeof mock.storage.local.snapshot()[bucketKey(3)]).toBe('string');
  });

  it('returns null for a bucket that was never stored', async () => {
    expect(await readBucket(9)).toBeNull();
    expect((await readBuckets([9, 10])).size).toBe(0);
  });

  it('removes a bucket when it is written as null', async () => {
    await writeBuckets(new Map([[3, new Uint8Array([1])]]));
    await writeBuckets(new Map([[3, null]]));
    expect(await readBucket(3)).toBeNull();
  });

  it('writes a whole batch in one set call', async () => {
    const calls: unknown[] = [];
    const original = mock.storage.local.set;
    mock.storage.local.set = (items) => {
      calls.push(items);
      return original(items);
    };
    await writeBuckets(
      new Map([
        [0, new Uint8Array([1])],
        [1, new Uint8Array([2])],
      ]),
    );
    expect(calls).toHaveLength(1);
  });

  it('reports a bucket of the wrong stored type as corruption', async () => {
    await mock.storage.local.set({ [bucketKey(2)]: 42 });
    await expect(readBucket(2)).rejects.toThrow(CorruptVaultError);
    await expect(readBuckets([2])).rejects.toThrow(CorruptVaultError);
  });
});

describe('merge base', () => {
  it('round-trips the sealed base and its plaintext bookkeeping', async () => {
    expect(await readBase()).toBeNull();
    expect(await readBaseMeta()).toBeNull();

    const sealed = new Uint8Array([9, 8, 7]);
    const meta = { lastSyncedRev: 4, providerId: 'chrome' as const, syncedAt: 5 };
    await writeBase(sealed, meta);
    expect([...(await readBase())!]).toEqual([...sealed]);
    expect(await readBaseMeta()).toEqual(meta);
  });

  it('reports a base of the wrong stored type as corruption', async () => {
    await mock.storage.local.set({ [LOCAL_KEYS.base]: 42 });
    await expect(readBase()).rejects.toThrow(CorruptVaultError);
  });
});

describe('settings', () => {
  it('returns the defaults when nothing is stored', async () => {
    expect(await readSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('pins the out-of-the-box lock posture', () => {
    // Spelled out rather than left to `DEFAULT_SETTINGS`: this is what a user gets without touching
    // anything, and moving either of them should have to be a deliberate edit here.
    expect(DEFAULT_SETTINGS.idleTimeoutMinutes).toBe(10);
    // Off: it fires on every focus loss, which is a password prompt per alt-tab. Offered, not
    // imposed — the idle timeout already covers walking away from the machine.
    expect(DEFAULT_SETTINGS.lockOnBrowserBlur).toBe(false);
  });

  it('round-trips', async () => {
    const settings = { ...DEFAULT_SETTINGS, theme: 'dark' as const, idleTimeoutMinutes: 30 };
    await writeSettings(settings);
    expect(await readSettings()).toEqual(settings);
  });

  it('keeps a zero idle timeout, which is how "never auto-lock" is stored', async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, idleTimeoutMinutes: IDLE_TIMEOUT_NEVER });
    expect((await readSettings()).idleTimeoutMinutes).toBe(IDLE_TIMEOUT_NEVER);
  });

  it('never throws on a corrupted blob — a bad theme must not lock a user out', async () => {
    await mock.storage.local.set({
      [LOCAL_KEYS.settings]: { theme: 'chartreuse', idleTimeoutMinutes: -5, providerId: 42 },
    });
    expect(await readSettings()).toEqual(DEFAULT_SETTINGS);
    await mock.storage.local.set({
      [LOCAL_KEYS.settings]: { idleTimeoutMinutes: Number.POSITIVE_INFINITY },
    });
    expect((await readSettings()).idleTimeoutMinutes).toBe(DEFAULT_SETTINGS.idleTimeoutMinutes);
    await mock.storage.local.set({ [LOCAL_KEYS.settings]: 'not an object' });
    expect(await readSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('forces a stored pane width back into range', async () => {
    // A width is only as trustworthy as the last thing that wrote it, and a column of −4,000 px is
    // a manager nobody can use again without clearing storage by hand.
    await mock.storage.local.set({
      [LOCAL_KEYS.settings]: { ...DEFAULT_SETTINGS, sidebarWidth: -4_000, detailWidth: 99_999 },
    });
    const settings = await readSettings();
    expect(settings.sidebarWidth).toBe(SIDEBAR_WIDTH.min);
    expect(settings.detailWidth).toBe(DETAIL_WIDTH.max);

    await mock.storage.local.set({
      [LOCAL_KEYS.settings]: { ...DEFAULT_SETTINGS, sidebarWidth: 'wide' },
    });
    expect((await readSettings()).sidebarWidth).toBe(SIDEBAR_WIDTH.initial);
  });

  it('holds no vault content', async () => {
    await writeSettings(DEFAULT_SETTINGS);
    const stored = JSON.stringify(mock.storage.local.snapshot()[LOCAL_KEYS.settings]);
    expect(stored).not.toMatch(/https?:/u);
  });
});

describe('clearVault', () => {
  it('removes every vm. key, including ones this phase does not write', async () => {
    await writeHeader(HEADER);
    await writeBuckets(new Map([[0, new Uint8Array([1])]]));
    await writeSettings(DEFAULT_SETTINGS);
    await mock.storage.local.set({ 'vm.thumbs.abc': 'sealed', 'unrelated.key': 'kept' });

    expect((await listVaultKeys()).length).toBeGreaterThan(3);
    await clearVault();
    expect(await listVaultKeys()).toEqual([]);
    expect(mock.storage.local.snapshot()['unrelated.key']).toBe('kept');
  });

  it('is a no-op on a profile with no vault', async () => {
    await expect(clearVault()).resolves.toBeUndefined();
  });
});

describe('localBytesInUse', () => {
  it('reports what storage.local is charging us', async () => {
    expect(await localBytesInUse()).toBe(0);
    await writeHeader(HEADER);
    expect(await localBytesInUse()).toBeGreaterThan(0);
  });
});
