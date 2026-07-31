/**
 * The merge base and the pending conflicts, on disk (ARCHITECTURE §5.1, §6.2).
 *
 * Both are vault content — the base is a whole copy of the item set, and a conflict record carries
 * two full versions of a bookmark — so the assertion that matters most in this file is **INV-6**:
 * neither may leave a readable title, URL, note or tag anywhere in `storage.local`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CorruptVaultError } from '../../../src/crypto/errors.js';
import { LOCAL_KEYS } from '../../../src/storage/local.js';
import { VaultRepository, type VaultCipher } from '../../../src/storage/repo.js';
import { clearBase, loadBase, loadConflicts, saveBase, saveConflicts } from '../../../src/sync/base.js';
import type { Conflict } from '../../../src/sync/merge.js';
import type { BaseMeta } from '../../../src/vault/types.js';
import { T0, bookmark, folder, itemMap } from '../../helpers/items.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

const PASSWORD = 'a reasonably long master password';

let mock: ChromeMock;
let repo: VaultRepository;
let cipher: VaultCipher;

const META: BaseMeta = {
  lastSyncedRev: 7,
  providerId: 'chrome',
  syncedAt: T0,
  remoteHash: 'aGFzaA',
};

const SECRETS = ['Secret bookmark title', 'https://very-private.example/path', 'a private note', 'privatetag'];

const SAMPLE = itemMap(
  folder('f', { title: 'Secret bookmark title' }),
  bookmark('a', {
    parentId: 'f',
    title: 'Secret bookmark title',
    url: 'https://very-private.example/path',
    note: 'a private note',
    tags: ['privatetag'],
  }),
);

beforeAll(async () => {
  mock = installChromeMock();
  repo = new VaultRepository();
  await repo.create(PASSWORD);
  await repo.flush();
  cipher = repo.cipher();
}, 30_000);

afterAll(() => {
  uninstallChromeMock();
});

beforeEach(async () => {
  await clearBase();
  await saveConflicts(cipher, []);
});

/** Every stored value, as one string — what an attacker with the profile directory would read. */
function storedText(): string {
  return JSON.stringify(mock.storage.local.snapshot());
}

describe('the merge base', () => {
  it('is absent until a sync has succeeded', async () => {
    expect(await loadBase(cipher)).toBeNull();
  });

  it('round-trips an item set, and the bookkeeping beside it', async () => {
    await saveBase(cipher, SAMPLE, META);
    const loaded = await loadBase(cipher);
    expect(loaded).not.toBeNull();
    expect([...loaded!.keys()].sort()).toEqual(['a', 'f']);
    expect(loaded!.get('a')?.title).toBe('Secret bookmark title');
  });

  it('stores nothing a reader of storage.local could understand (INV-6)', async () => {
    await saveBase(cipher, SAMPLE, META);
    const text = storedText();
    expect(text).toContain(LOCAL_KEYS.base);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  it('is forgotten on request, bookkeeping and all', async () => {
    await saveBase(cipher, SAMPLE, META);
    await clearBase();
    expect(await loadBase(cipher)).toBeNull();
    expect(storedText()).not.toContain(LOCAL_KEYS.baseMeta);
  });

  it('refuses a base sealed for something else', async () => {
    // Sealed with the right key under the wrong purpose: the AAD binds a blob to its slot, so this
    // is the replay a `bucket` ciphertext dropped into `vm.base` would be.
    const wrong = await cipher.seal('export', '', { items: [] });
    await mock.storage.local.set({ [LOCAL_KEYS.base]: bytesToBase64Url(wrong) });
    await expect(loadBase(cipher)).rejects.toBeInstanceOf(CorruptVaultError);
  });
});

/* ------------------------------------------------------------------ conflicts */

function conflict(id: string): Conflict {
  return {
    id,
    kind: 'field',
    fields: ['title'],
    mine: bookmark(id, { title: 'Secret bookmark title', note: 'a private note' }),
    theirs: bookmark(id, { title: 'Their version' }),
    base: bookmark(id),
    detectedAt: T0,
    remoteDevice: 'the-other-one',
  };
}

describe('pending conflicts', () => {
  it('start empty and round-trip whole', async () => {
    expect(await loadConflicts(cipher)).toEqual([]);
    await saveConflicts(cipher, [conflict('a'), conflict('b')]);

    const loaded = await loadConflicts(cipher);
    expect(loaded.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(loaded[0]?.mine.title).toBe('Secret bookmark title');
    expect(loaded[0]?.theirs.title).toBe('Their version');
    expect(loaded[0]?.remoteDevice).toBe('the-other-one');
  });

  it('carry no readable vault content either (INV-6)', async () => {
    await saveConflicts(cipher, [conflict('a')]);
    const text = storedText();
    expect(text).toContain(LOCAL_KEYS.conflicts);
    for (const secret of SECRETS.slice(0, 3)) expect(text).not.toContain(secret);
  });

  it('remove the key entirely rather than storing an empty container', async () => {
    await saveConflicts(cipher, [conflict('a')]);
    await saveConflicts(cipher, []);
    expect(storedText()).not.toContain(LOCAL_KEYS.conflicts);
    expect(await loadConflicts(cipher)).toEqual([]);
  });

  it('drops a record that is not a usable conflict rather than surfacing half of one', async () => {
    // Written by an older build, or by a bug. The bytes authenticate; the shape does not, and a
    // half-item reaching the resolution UI would let someone "keep theirs" on nothing.
    const damaged = await cipher.seal('conflicts', '', {
      v: 2,
      conflicts: [
        { id: 'ok', kind: 'field', mine: bookmark('ok'), theirs: bookmark('ok'), detectedAt: 1 },
        { id: 'no-kind', mine: bookmark('x'), theirs: bookmark('x'), detectedAt: 1 },
        { id: 'no-sides', kind: 'field', detectedAt: 1 },
        'not an object',
      ],
    });
    await mock.storage.local.set({ [LOCAL_KEYS.conflicts]: bytesToBase64Url(damaged) });

    const loaded = await loadConflicts(cipher);
    expect(loaded.map((entry) => entry.id)).toEqual(['ok']);
    expect(loaded[0]?.fields).toEqual([]);
    expect(loaded[0]?.base).toBeNull();
  });

  it('reports a file that is not a conflict file at all', async () => {
    const nonsense = await cipher.seal('conflicts', '', { v: 2, conflicts: 'not an array' });
    await mock.storage.local.set({ [LOCAL_KEYS.conflicts]: bytesToBase64Url(nonsense) });
    await expect(loadConflicts(cipher)).rejects.toBeInstanceOf(CorruptVaultError);
  });
});

/** The same encoding `storage/local.ts` uses; imported indirectly to keep this file readable. */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
