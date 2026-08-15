/**
 * The `.vmv` round trip against a real repository — Phase 8's Definition of done.
 *
 * "Export → wipe → import restores the vault" is the sentence the whole phase is measured by, and
 * the interesting word in it is *restores*: not "produces a vault with the same number of bookmarks
 * in it", but the same items, field for field, tombstones included. So the assertion is a deep
 * comparison of the item sets and not a count.
 *
 * The two failure modes are asserted here rather than only at the unit level, because the property
 * that matters is about the **vault**, not about the parser: a wrong password and a damaged file
 * must both leave the existing vault exactly as it was. An importer that half-applies is worse than
 * one that refuses.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Bytes } from '../../src/crypto/codec.js';
import { CorruptVaultError, WrongPasswordError } from '../../src/crypto/errors.js';
import { exportVault, serializeVmv } from '../../src/io/export-encrypted.js';
import { applyImport, openVmv, parseVmv } from '../../src/io/import-encrypted.js';
import { rollbackOffer, restoreRollback } from '../../src/io/rollback.js';
import { loadConflicts } from '../../src/sync/base.js';
import { outboundView } from '../../src/sync/merge.js';
import { LOCAL_KEYS } from '../../src/storage/local.js';
import { VaultRepository } from '../../src/storage/repo.js';
import { canonicalJson } from '../../src/vault/model.js';
import { ROLLBACK_TTL_MS, type ItemMap, type VaultItem } from '../../src/vault/types.js';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
  type StorageSnapshot,
} from '../mocks/chrome.js';

const PASSWORD = 'correct horse battery staple';
const EXPORT_PASSWORD = 'a different password for the file';
const NOW = 1_750_000_000_000;

let mock: ChromeMock;

/**
 * One created vault, reused — the same trick `repo.test.ts` uses, and for the same reason.
 *
 * PBKDF2 at 600,000 iterations is half a second of CPU by design. Creating a vault per test would
 * spend it eleven times over in a suite that runs in parallel with two wall-clock budget
 * assertions elsewhere. The `.vmv` derivations below are *not* skipped: those are what this file
 * is about.
 */
let seeded: StorageSnapshot | null = null;
let seededDek: Bytes;

async function freshVault(): Promise<VaultRepository> {
  const repo = new VaultRepository({ coalesceMs: 60_000 });
  if (seeded === null) {
    await repo.create(PASSWORD);
    await repo.flush();
    seeded = structuredClone(mock.storage.local.snapshot());
    seededDek = repo.exportDek();
    return repo;
  }
  await mock.storage.local.set(structuredClone(seeded));
  // The path a restarted service worker takes (ARCHITECTURE §7.1): the key is already in hand.
  await repo.unlockWithDek(seededDek);
  return repo;
}

/** A vault with a folder, three bookmarks with everything on them, and one tombstone. */
async function seedVault(repo: VaultRepository): Promise<void> {
  const [work] = await repo.apply([{ kind: 'add', input: { type: 'folder', title: 'Work' } }]);
  await repo.apply([
    {
      kind: 'add',
      input: {
        type: 'bookmark',
        url: 'https://example.com/spec',
        title: 'Spec',
        parentId: work?.id ?? 'root',
        tags: ['reading', 'work'],
        note: 'chapter 3',
      },
    },
    { kind: 'add', input: { type: 'bookmark', url: 'https://example.com/', title: 'Home' } },
    { kind: 'add', input: { type: 'bookmark', url: 'https://gone.test/', title: 'Gone' } },
  ]);
  const doomed = repo.getAll().find((item) => item.title === 'Gone');
  await repo.apply([{ kind: 'delete', id: doomed?.id ?? '' }]);
  await repo.flush();
}

/** The comparison the definition of done is written in: contents, not ciphertext. */
function contents(items: ItemMap): string[] {
  return [...items.values()]
    .map((item: VaultItem) => canonicalJson(item))
    .sort();
}

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('export → wipe → import', () => {
  it('restores the vault contents exactly', async () => {
    const source = await freshVault();
    await seedVault(source);
    const before = contents(source.items());
    // One folder and three bookmarks, one of the bookmarks a tombstone.
    expect(before).toHaveLength(4);

    const text = serializeVmv(
      await exportVault(source.getAll({ includeDeleted: true }), EXPORT_PASSWORD, { now: () => NOW }),
    );

    // Wipe: a new profile, a new vault, a different master password. Nothing of the old one is
    // left — which is the situation the backup exists for.
    await source.destroy();
    uninstallChromeMock();
    mock = installChromeMock();
    const restored = new VaultRepository({ coalesceMs: 60_000 });
    await restored.create('an entirely different master password');
    await restored.flush();

    const items = await openVmv(parseVmv(text), EXPORT_PASSWORD);
    await applyImport(restored, items, 'replace', { now: () => NOW });

    expect(contents(restored.items())).toEqual(before);
    // Including the tombstone: a restored vault that forgot a deletion re-adds it everywhere the
    // moment it syncs.
    expect(restored.getAll({ includeDeleted: true })).toHaveLength(4);
    expect(restored.getAll()).toHaveLength(3);
  }, 60_000);

  it('survives a lock and unlock, so the import really reached storage', async () => {
    const source = await freshVault();
    await seedVault(source);
    const before = contents(source.items());
    const text = serializeVmv(
      await exportVault(source.getAll({ includeDeleted: true }), PASSWORD, { now: () => NOW }),
    );
    await source.destroy();

    const restored = new VaultRepository({ coalesceMs: 60_000 });
    await restored.create(PASSWORD);
    await applyImport(restored, await openVmv(parseVmv(text), PASSWORD), 'replace', {
      now: () => NOW,
    });
    await restored.lock();

    const reopened = new VaultRepository({ coalesceMs: 60_000 });
    await reopened.unlock(PASSWORD);
    expect(contents(reopened.items())).toEqual(before);
  }, 60_000);
});

describe('a refused import', () => {
  it('leaves the vault untouched when the password is wrong', async () => {
    const repo = await freshVault();
    await seedVault(repo);
    const before = contents(repo.items());
    const rev = repo.header().vaultRev;

    const text = serializeVmv(await exportVault([], EXPORT_PASSWORD, { now: () => NOW }));
    await expect(openVmv(parseVmv(text), 'wrong')).rejects.toThrow(WrongPasswordError);

    expect(contents(repo.items())).toEqual(before);
    expect(repo.header().vaultRev).toBe(rev);
    expect(mock.storage.local.snapshot()[LOCAL_KEYS.rollback]).toBeUndefined();
  }, 60_000);

  it('leaves the vault untouched when the file is damaged', async () => {
    const repo = await freshVault();
    await seedVault(repo);
    const before = contents(repo.items());

    const file = await exportVault([], EXPORT_PASSWORD, { now: () => NOW });
    const truncated = serializeVmv(file).slice(0, 120);
    expect(() => parseVmv(truncated)).toThrow(CorruptVaultError);

    expect(contents(repo.items())).toEqual(before);
    expect(mock.storage.local.snapshot()[LOCAL_KEYS.rollback]).toBeUndefined();
  }, 60_000);
});

describe('merge mode', () => {
  it('adds what is new and conflicts on what disagrees, rather than overwriting', async () => {
    const repo = await freshVault();
    await seedVault(repo);

    // A backup of this vault, with one bookmark edited on the other side and one new one — which
    // is exactly what re-importing a stale backup of the same vault looks like.
    const exported = repo.getAll({ includeDeleted: true }).map((item) =>
      item.title === 'Home' ? { ...item, title: 'Home (from the backup)' } : item,
    );
    const [spec] = repo.getAll().filter((item) => item.title === 'Spec');
    const extra: VaultItem = {
      id: 'imported-only',
      type: 'bookmark',
      parentId: 'root',
      title: 'Only in the file',
      url: 'https://imported.test/',
      createdAt: NOW,
      updatedAt: NOW,
      order: 'a5',
      rev: 1,
    };
    const text = serializeVmv(
      await exportVault([...exported, extra], EXPORT_PASSWORD, { now: () => NOW }),
    );

    const result = await applyImport(
      repo,
      await openVmv(parseVmv(text), EXPORT_PASSWORD),
      'merge',
      { now: () => NOW },
    );

    expect(result.added).toBe(1);
    expect(result.conflicts).toBe(1);
    // The local side is what the vault shows while the disagreement is unresolved (§6.5)...
    expect(repo.getAll().find((item) => item.id === spec?.id)?.title).toBe('Spec');
    expect(repo.getAll().map((item) => item.title)).toContain('Home');
    expect(repo.getAll().map((item) => item.title)).toContain('Only in the file');
    // ...and nothing was lost: the file's version is in the conflict record.
    const conflicts = await loadConflicts(repo.cipher());
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.theirs.title).toBe('Home (from the backup)');
    expect(conflicts[0]?.origin).toBe('import');
  }, 60_000);

  it('does not push the file version to other devices while the conflict is open', async () => {
    // The rule §6.5 states is about protecting the *other device's* answer. A file is not a device
    // and has no answer to protect, so what syncs is what the vault shows.
    const repo = await freshVault();
    await seedVault(repo);
    const exported = repo
      .getAll({ includeDeleted: true })
      .map((item) => (item.title === 'Home' ? { ...item, title: 'From the file' } : item));
    const text = serializeVmv(await exportVault(exported, PASSWORD, { now: () => NOW }));

    await applyImport(repo, await openVmv(parseVmv(text), PASSWORD), 'merge', { now: () => NOW });
    const conflicts = await loadConflicts(repo.cipher());
    const outbound = outboundView(repo.items(), conflicts);

    const pushed = [...outbound.values()].find((item) => item.id === conflicts[0]?.id);
    expect(pushed?.title).toBe('Home');
  }, 60_000);

  it('does not resurrect a deletion carried in the file', async () => {
    const repo = await freshVault();
    await seedVault(repo);
    const text = serializeVmv(
      await exportVault(repo.getAll({ includeDeleted: true }), PASSWORD, { now: () => NOW }),
    );

    await applyImport(repo, await openVmv(parseVmv(text), PASSWORD), 'merge', { now: () => NOW });
    expect(repo.getAll().map((item) => item.title)).not.toContain('Gone');
  }, 60_000);
});

describe('replace mode', () => {
  it('keeps a one-shot undo for 24 hours', async () => {
    const repo = await freshVault();
    await seedVault(repo);
    const before = contents(repo.items());

    const text = serializeVmv(await exportVault([], PASSWORD, { now: () => NOW }));
    const result = await applyImport(repo, await openVmv(parseVmv(text), PASSWORD), 'replace', {
      now: () => NOW,
    });

    expect(result.rollback).toBe(true);
    expect(repo.getAll()).toHaveLength(0);
    await expect(rollbackOffer(NOW)).resolves.toMatchObject({
      available: true,
      createdAt: NOW,
      expiresAt: NOW + ROLLBACK_TTL_MS,
    });

    await restoreRollback(repo, NOW + 1_000);
    expect(contents(repo.items())).toEqual(before);
  }, 60_000);

  it('spends the undo once', async () => {
    const repo = await freshVault();
    await seedVault(repo);
    const text = serializeVmv(await exportVault([], PASSWORD, { now: () => NOW }));
    await applyImport(repo, await openVmv(parseVmv(text), PASSWORD), 'replace', { now: () => NOW });

    await restoreRollback(repo, NOW);
    await expect(rollbackOffer(NOW)).resolves.toMatchObject({ available: false });
    await expect(restoreRollback(repo, NOW)).rejects.toThrow(CorruptVaultError);
  }, 60_000);

  it('discards the undo once it has expired, rather than keeping a copy of the vault forever', async () => {
    const repo = await freshVault();
    await seedVault(repo);
    const text = serializeVmv(await exportVault([], PASSWORD, { now: () => NOW }));
    await applyImport(repo, await openVmv(parseVmv(text), PASSWORD), 'replace', { now: () => NOW });

    await expect(rollbackOffer(NOW + ROLLBACK_TTL_MS + 1)).resolves.toMatchObject({
      available: false,
    });
    const snapshot = mock.storage.local.snapshot();
    expect(snapshot[LOCAL_KEYS.rollback]).toBeUndefined();
    expect(snapshot[LOCAL_KEYS.rollbackMeta]).toBeUndefined();
  }, 60_000);

  it('stores the undo snapshot sealed (INV-6)', async () => {
    const repo = await freshVault();
    await seedVault(repo);
    const text = serializeVmv(await exportVault([], PASSWORD, { now: () => NOW }));
    await applyImport(repo, await openVmv(parseVmv(text), PASSWORD), 'replace', { now: () => NOW });

    const stored = JSON.stringify(mock.storage.local.snapshot());
    expect(stored).not.toContain('example.com');
    expect(stored).not.toContain('Spec');
    expect(stored).not.toContain('chapter 3');
  }, 60_000);
});
