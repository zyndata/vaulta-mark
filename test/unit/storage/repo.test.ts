import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { fromBase64Url, toBase64Url } from '../../../src/crypto/codec.js';
import {
  CorruptVaultError,
  UnsupportedSchemaError,
  WrongPasswordError,
} from '../../../src/crypto/errors.js';
import { LOCAL_KEYS, bucketKey, readHeader } from '../../../src/storage/local.js';
import { VaultRepository } from '../../../src/storage/repo.js';
import { VaultLockedError, VaultStateError, WeakPasswordError } from '../../../src/vault/errors.js';
import {
  DEFAULT_BUCKET_COUNT,
  SCHEMA_VERSION,
  TOMBSTONE_TTL_MS,
  VAULT_MAGIC,
  isDeleted,
  type VaultHeader,
} from '../../../src/vault/types.js';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
  type StorageSnapshot,
} from '../../mocks/chrome.js';

const PASSWORD = 'correct horse battery staple';
const NOW = 1_750_000_000_000;

let mock: ChromeMock;

/**
 * One created vault, reused across the suite.
 *
 * PBKDF2 at 600,000 iterations is ~half a second by design, so creating a vault per test would
 * make this file take minutes. The snapshot is restored into a fresh mock instead, and the tests
 * that genuinely need an unlock pay for one.
 */
let seeded: StorageSnapshot;

/** A repository with the coalescer effectively disabled, so writes happen when a test says so. */
function repository(coalesceMs = 60_000): VaultRepository {
  let next = 0;
  return new VaultRepository({
    now: () => NOW,
    newId: () => `id-${String(++next)}`,
    coalesceMs,
  });
}

function restore(snapshot: StorageSnapshot): void {
  void mock.storage.local.set(structuredClone(snapshot));
}

/** Record the keys of every `storage.local.set` while `run` executes. */
async function capturedWrites(run: () => Promise<void>): Promise<string[][]> {
  const calls: string[][] = [];
  const original = mock.storage.local.set;
  mock.storage.local.set = (items) => {
    calls.push(Object.keys(items));
    return original(items);
  };
  try {
    await run();
  } finally {
    mock.storage.local.set = original;
  }
  return calls;
}

beforeAll(async () => {
  const bootstrap = installChromeMock();
  const repo = repository();
  await repo.create(PASSWORD);
  await repo.flush();
  seeded = bootstrap.storage.local.snapshot();
  uninstallChromeMock();
}, 30_000);

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('create', () => {
  it('writes a plaintext header and no buckets', () => {
    const header = seeded[LOCAL_KEYS.meta] as VaultHeader;
    expect(header.magic).toBe(VAULT_MAGIC);
    expect(header.schemaVersion).toBe(SCHEMA_VERSION);
    expect(header.bucketCount).toBe(DEFAULT_BUCKET_COUNT);
    expect(header.buckets).toHaveLength(DEFAULT_BUCKET_COUNT);
    expect(header.buckets.every((meta) => meta.parts === 0)).toBe(true);
    expect(header.vaultRev).toBe(1);
    // An empty vault stores nothing: sixteen sealed empty payloads would cost ~7 KB of a 100 KB
    // sync quota to say nothing at all.
    expect(Object.keys(seeded).filter((key) => key.startsWith(LOCAL_KEYS.bucketPrefix))).toEqual(
      [],
    );
  });

  it('generates a 32-byte salt and a 48-byte wrapped DEK', () => {
    const header = seeded[LOCAL_KEYS.meta] as VaultHeader;
    expect(fromBase64Url(header.kdf.salt)).toHaveLength(32);
    expect(fromBase64Url(header.wrappedDek.iv)).toHaveLength(12);
    expect(fromBase64Url(header.wrappedDek.ct)).toHaveLength(48);
    expect(header.kdf.iterations).toBe(600_000);
  });

  it('leaves the vault unlocked', async () => {
    restore(seeded);
    const repo = repository();
    expect(repo.locked).toBe(true);
    await expect(repo.exists()).resolves.toBe(true);
  });

  it('refuses to create over an existing vault', async () => {
    restore(seeded);
    await expect(repository().create(PASSWORD)).rejects.toThrow(VaultStateError);
  });

  it('refuses a password below the hard floor, and writes nothing (ARCHITECTURE §4.6)', async () => {
    await expect(repository().create('nine char')).rejects.toThrow(WeakPasswordError);
    expect(mock.storage.local.snapshot()).toEqual({});
  });

  it('counts the floor in code points, not UTF-16 units', async () => {
    // Nine emoji: eighteen UTF-16 units, so a `.length` check would wave this through.
    const nineEmoji = '🔒🔑🐈🍎🌍🚀🎈🧊🦊';
    expect(nineEmoji.length).toBe(18);
    await expect(repository().create(nineEmoji)).rejects.toThrow(WeakPasswordError);
  });
});

describe('the DEK, in and out', () => {
  it('reopens a vault from an exported DEK with no password and no KDF', async () => {
    restore(seeded);
    const first = repository();
    await first.unlock(PASSWORD);
    await first.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
    ]);
    await first.flush();
    const dek = first.exportDek();
    expect(dek).toHaveLength(32);

    const second = repository();
    await second.unlockWithDek(dek);

    expect(second.getAll().map((item) => item.title)).toEqual(['A']);
    await second.lock({ flush: false });
    // The caller keeps ownership of its buffer: locking the second repository must not have
    // zeroed the bytes the first one handed over.
    expect(dek.some((byte) => byte !== 0)).toBe(true);
    await first.lock({ flush: false });
  }, 60_000);

  it('refuses to export a key it does not have', () => {
    expect(() => repository().exportDek()).toThrow(VaultLockedError);
  });

  it('reports a vault from a newer build before adopting the key', async () => {
    restore(seeded);
    const repo = repository();
    await repo.unlock(PASSWORD);
    const dek = repo.exportDek();
    await repo.lock({ flush: false });

    await mock.storage.local.set({
      [LOCAL_KEYS.meta]: { ...(seeded[LOCAL_KEYS.meta] as VaultHeader), schemaVersion: 99 },
    });
    await expect(repository().unlockWithDek(dek)).rejects.toThrow(UnsupportedSchemaError);
  }, 60_000);

  it('refuses when there is no vault', async () => {
    await expect(repository().unlockWithDek(new Uint8Array(32))).rejects.toThrow(VaultStateError);
  });
});

describe('unlock', () => {
  it('refuses when there is no vault', async () => {
    await expect(repository().unlock(PASSWORD)).rejects.toThrow(VaultStateError);
  });

  it('rejects a vault from a newer build before deriving anything', async () => {
    restore(seeded);
    await mock.storage.local.set({
      [LOCAL_KEYS.meta]: { ...(seeded[LOCAL_KEYS.meta] as VaultHeader), schemaVersion: 99 },
    });
    // Cheap on purpose: the user is told to update, not told their password is wrong.
    await expect(repository().unlock(PASSWORD)).rejects.toThrow(UnsupportedSchemaError);
  });

  it('rejects a wrong password without returning a key', async () => {
    restore(seeded);
    const repo = repository();
    await expect(repo.unlock('not the password')).rejects.toThrow(WrongPasswordError);
  }, 30_000);

  it('reports a header that lists a bucket which is not stored', async () => {
    restore(seeded);
    const header = seeded[LOCAL_KEYS.meta] as VaultHeader;
    await mock.storage.local.set({
      [LOCAL_KEYS.meta]: {
        ...header,
        buckets: header.buckets.map((meta) => (meta.i === 0 ? { ...meta, parts: 1 } : meta)),
      },
    });
    await expect(repository().unlock(PASSWORD)).rejects.toThrow(CorruptVaultError);
  }, 30_000);
});

describe('an unlocked vault', () => {
  let repo: VaultRepository;

  beforeEach(async () => {
    restore(seeded);
    repo = repository();
    await repo.unlock(PASSWORD);
  }, 30_000);

  afterEach(async () => {
    await repo.lock({ flush: false });
  });

  it('starts empty', () => {
    expect(repo.getAll()).toEqual([]);
    expect(repo.header().vaultRev).toBe(1);
  });

  it('adds items and bumps the vault revision once per batch', async () => {
    const changed = await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/b', title: 'B' } },
    ]);
    expect(changed).toHaveLength(2);
    expect(repo.getAll()).toHaveLength(2);
    expect(repo.header().vaultRev).toBe(2);
  });

  it('writes only the buckets that changed', async () => {
    await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/b', title: 'B' } },
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/c', title: 'C' } },
    ]);
    await repo.flush();

    const target = repo.getAll()[0]!;
    const writes = await capturedWrites(async () => {
      await repo.apply([{ kind: 'update', id: target.id, patch: { title: 'Renamed' } }]);
      expect(repo.dirtyBuckets().size).toBe(1);
      await repo.flush();
    });

    const bucketWrites = writes.flat().filter((key) => key.startsWith(LOCAL_KEYS.bucketPrefix));
    expect(bucketWrites).toHaveLength(1);
    expect(writes.flat()).toContain(LOCAL_KEYS.meta);
  });

  it('writes nothing for an edit that changes nothing', async () => {
    await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
    ]);
    await repo.flush();
    const target = repo.getAll()[0]!;

    const writes = await capturedWrites(async () => {
      const changed = await repo.apply([{ kind: 'update', id: target.id, patch: { title: 'A' } }]);
      expect(changed).toEqual([]);
      await repo.flush();
    });
    expect(writes).toEqual([]);
    expect(repo.header().vaultRev).toBe(2);
  });

  it('coalesces a burst of edits into one write', async () => {
    const fast = repository(5);
    try {
      restore(seeded);
      await fast.unlock(PASSWORD);
      const writes = await capturedWrites(async () => {
        for (let i = 0; i < 5; i++) {
          await fast.apply([
            {
              kind: 'add',
              input: { type: 'bookmark', url: `https://example.org/${String(i)}`, title: 'x' },
            },
          ]);
        }
        await fast.flush();
      });
      // One `set` for the buckets and one for the header, however many mutations went in.
      expect(writes.length).toBeLessThanOrEqual(2);
    } finally {
      await fast.lock({ flush: false });
    }
  }, 30_000);

  it('excludes tombstones from getAll but keeps them in the payload', async () => {
    await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
    ]);
    const id = repo.getAll()[0]!.id;
    await repo.apply([{ kind: 'delete', id }]);

    expect(repo.getAll()).toEqual([]);
    const withDeleted = repo.getAll({ includeDeleted: true });
    expect(withDeleted).toHaveLength(1);
    expect(isDeleted(withDeleted[0]!)).toBe(true);
    expect(repo.getItem(id)).toBeDefined();
  });

  it('purges tombstones past the TTL and writes the result immediately', async () => {
    const old = new VaultRepository({
      now: () => NOW,
      newId: () => 'old-item',
      coalesceMs: 60_000,
    });
    restore(seeded);
    await old.unlock(PASSWORD);
    try {
      await old.apply([
        { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
      ]);
      await old.apply([{ kind: 'delete', id: 'old-item' }]);
      await old.flush();

      expect(await old.purge(TOMBSTONE_TTL_MS)).toEqual([]);
      expect(await old.purge(-1)).toEqual(['old-item']);
      expect(old.getAll({ includeDeleted: true })).toEqual([]);
      expect(old.dirtyBuckets().size).toBe(0);
    } finally {
      await old.lock({ flush: false });
    }
  }, 30_000);

  it('searches the items it holds and drops the index on a change', async () => {
    await repo.apply([
      {
        kind: 'add',
        input: { type: 'bookmark', url: 'https://example.org/a', title: 'Padding oracles' },
      },
    ]);
    expect(repo.search('padding').map((hit) => hit.item.title)).toEqual(['Padding oracles']);

    const id = repo.getAll()[0]!.id;
    await repo.apply([{ kind: 'update', id, patch: { title: 'Something else' } }]);
    expect(repo.search('padding')).toEqual([]);
    expect(repo.search('something')).toHaveLength(1);
  });

  it('exposes the item map for the pure model functions', async () => {
    await repo.apply([{ kind: 'add', input: { type: 'folder', title: 'Reading' } }]);
    expect(repo.items().size).toBe(1);
  });
});

describe('lock', () => {
  it('forgets the header, the items and the keys', async () => {
    restore(seeded);
    const repo = repository();
    await repo.unlock(PASSWORD);
    await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
    ]);

    await repo.lock();
    expect(repo.locked).toBe(true);
    expect(() => repo.getAll()).toThrow(VaultLockedError);
    expect(() => repo.getItem('x')).toThrow(VaultLockedError);
    expect(() => repo.header()).toThrow(VaultLockedError);
    expect(() => repo.search('a')).toThrow(VaultLockedError);
    expect(() => repo.items()).toThrow(VaultLockedError);
    await expect(repo.apply([])).rejects.toThrow(VaultLockedError);
    await expect(repo.purge()).rejects.toThrow(VaultLockedError);
    await expect(repo.changePassword(PASSWORD, 'x')).rejects.toThrow(VaultLockedError);
  }, 30_000);

  it('flushes pending writes by default, so a lock timer cannot eat the last edit', async () => {
    restore(seeded);
    const repo = repository();
    await repo.unlock(PASSWORD);
    await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
    ]);
    await repo.lock();

    const header = await readHeader();
    expect(header!.vaultRev).toBe(2);
    expect(header!.buckets.some((meta) => meta.parts > 0)).toBe(true);
  }, 30_000);

  it('skips the flush when asked, which is what panic-lock needs', async () => {
    restore(seeded);
    const repo = repository();
    await repo.unlock(PASSWORD);
    await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
    ]);
    await repo.lock({ flush: false });

    expect((await readHeader())!.vaultRev).toBe(1);
  }, 30_000);

  it('is safe to call twice', async () => {
    const repo = repository();
    await repo.lock();
    await expect(repo.lock()).resolves.toBeUndefined();
  });
});

describe('changePassword', () => {
  it('re-wraps 32 bytes and leaves every bucket untouched', async () => {
    restore(seeded);
    const repo = repository();
    await repo.unlock(PASSWORD);
    await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
    ]);
    await repo.flush();

    const before = await readHeader();
    const bucketsBefore = Object.fromEntries(
      Object.entries(mock.storage.local.snapshot()).filter(([key]) =>
        key.startsWith(LOCAL_KEYS.bucketPrefix),
      ),
    );

    await repo.changePassword(PASSWORD, 'a different long passphrase');
    const after = await readHeader();

    expect(after!.wrappedDek).not.toEqual(before!.wrappedDek);
    expect(after!.kdf.salt).not.toBe(before!.kdf.salt);
    // ARCHITECTURE §4.1: no ciphertext moves, so no bucket tag may change.
    expect(after!.buckets.map((meta) => meta.tag)).toEqual(before!.buckets.map((meta) => meta.tag));
    expect(
      Object.fromEntries(
        Object.entries(mock.storage.local.snapshot()).filter(([key]) =>
          key.startsWith(LOCAL_KEYS.bucketPrefix),
        ),
      ),
    ).toEqual(bucketsBefore);
    expect(after!.vaultRev).toBe(before!.vaultRev + 1);

    await repo.lock();
    const reopened = repository();
    await reopened.unlock('a different long passphrase');
    expect(reopened.getAll()).toHaveLength(1);
    await reopened.lock({ flush: false });
  }, 60_000);

  it('refuses a new password below the hard floor', async () => {
    restore(seeded);
    const repo = repository();
    await repo.unlock(PASSWORD);
    try {
      await expect(repo.changePassword(PASSWORD, 'too short')).rejects.toThrow(WeakPasswordError);
      expect((await readHeader())!.kdf.salt).toBe(
        (seeded[LOCAL_KEYS.meta] as VaultHeader).kdf.salt,
      );
    } finally {
      await repo.lock({ flush: false });
    }
  }, 60_000);

  it('refuses a wrong current password even while unlocked', async () => {
    restore(seeded);
    const repo = repository();
    await repo.unlock(PASSWORD);
    try {
      await expect(repo.changePassword('wrong', 'whatever else')).rejects.toThrow(
        WrongPasswordError,
      );
      expect((await readHeader())!.kdf.salt).toBe(
        (seeded[LOCAL_KEYS.meta] as VaultHeader).kdf.salt,
      );
    } finally {
      await repo.lock({ flush: false });
    }
  }, 60_000);
});

describe('destroy', () => {
  it('locks and removes every trace', async () => {
    restore(seeded);
    const repo = repository();
    await repo.unlock(PASSWORD);
    await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
    ]);
    await repo.flush();

    await repo.destroy();
    expect(repo.locked).toBe(true);
    expect(
      Object.keys(mock.storage.local.snapshot()).filter((key) => key.startsWith('vm.')),
    ).toEqual([]);
    await expect(repo.exists()).resolves.toBe(false);
  }, 30_000);
});

describe('damaged storage', () => {
  it('reports a tampered bucket as corruption, not as a wrong password', async () => {
    restore(seeded);
    const repo = repository();
    await repo.unlock(PASSWORD);
    await repo.apply([
      { kind: 'add', input: { type: 'bookmark', url: 'https://example.org/a', title: 'A' } },
    ]);
    await repo.flush();
    const header = repo.header();
    await repo.lock({ flush: false });

    const damagedIndex = header.buckets.find((meta) => meta.parts > 0)!.i;
    const stored = mock.storage.local.snapshot()[bucketKey(damagedIndex)] as string;
    const bytes = fromBase64Url(stored);
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0x01;
    await mock.storage.local.set({ [bucketKey(damagedIndex)]: toBase64Url(bytes) });

    await expect(repository().unlock(PASSWORD)).rejects.toThrow(CorruptVaultError);
  }, 60_000);
});
