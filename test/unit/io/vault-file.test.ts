/**
 * Restoring from either kind of `.vmv` — and, as ever, refusing to.
 *
 * The case that motivated this file: someone downloads `vaultamark-vault.vmv` out of their own Drive,
 * opens *Restore from a backup*, types the master password, and is told it is not a VaultaMark
 * export. It is a VaultaMark vault; it is simply the sync container rather than a backup, and the two
 * shared an extension and nothing else. So the round trip below is the real one — a repository is
 * created, filled and exported the way the engine pushes it, encoded exactly as the Drive provider
 * encodes it, and handed to the importer as text.
 *
 * Everything after that is the hostile-input table `import-encrypted.test.ts` sets the pattern for.
 * The distinction it exists to protect is the same one: `WrongPasswordError` sends someone back to
 * their password manager and `CorruptVaultError` sends them to their other copy, and reporting either
 * one as the other wastes the first and loses the second.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { toBase64Url } from '../../../src/crypto/codec.js';
import {
  CorruptVaultError,
  UnsupportedSchemaError,
  WrongPasswordError,
} from '../../../src/crypto/errors.js';
import { MIN_KDF_ITERATIONS } from '../../../src/crypto/kdf.js';
import { exportVault, serializeVmv } from '../../../src/io/export-encrypted.js';
import { openVaultFile, parseVaultFile, previewOfFile } from '../../../src/io/vault-file.js';
import { VaultRepository } from '../../../src/storage/repo.js';
import { encodeVault } from '../../../src/sync/drive/container.js';
import { SCHEMA_VERSION } from '../../../src/vault/types.js';
import { T0, bookmark, folder, itemMap, liveIds } from '../../helpers/items.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

const PASSWORD = 'correct horse battery staple';

/**
 * One real sync container, built once.
 *
 * PBKDF2 at 600,000 iterations is half a second by design, and this file opens the container several
 * times — so the *file* is shared and the tests that need a derivation pay for their own.
 */
let container: string;

/** The same items, sealed as a backup instead, so both branches are exercised by one suite. */
let backup: string;

beforeAll(async () => {
  installChromeMock();
  try {
    const repo = new VaultRepository({ now: () => T0, coalesceMs: 60_000 });
    await repo.create(PASSWORD);
    await repo.apply([
      { kind: 'add', input: { type: 'folder', id: 'f1', title: 'Work' } },
      {
        kind: 'add',
        input: { type: 'bookmark', id: 'b1', parentId: 'f1', title: 'A thing', url: 'https://example.com/b1' },
      },
      {
        kind: 'add',
        input: { type: 'bookmark', id: 'b2', title: 'Another thing', url: 'https://example.com/b2' },
      },
    ]);
    await repo.flush();
    container = new TextDecoder().decode(encodeVault(await repo.exportEncrypted()));
  } finally {
    uninstallChromeMock();
  }

  backup = serializeVmv(
    await exportVault([folder('f1'), bookmark('b1', { parentId: 'f1' })], PASSWORD, {
      version: '1.0.0',
      now: () => T0,
    }),
  );
}, 60_000);

beforeEach(() => {
  installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

/** A copy of the container with one field damaged, as text. */
function damaged(change: (file: Record<string, unknown>) => void): string {
  const file = JSON.parse(container) as Record<string, unknown>;
  change(file);
  return JSON.stringify(file);
}

/** The container's header, for the damage helpers that reach into it. */
function headerOf(file: Record<string, unknown>): Record<string, unknown> {
  return file['header'] as Record<string, unknown>;
}

describe('recognising a file', () => {
  it('reads the sync container Drive holds', () => {
    const parsed = parseVaultFile(container);
    expect(parsed.kind).toBe('sync');
  });

  it('still reads a backup, by its magic string', () => {
    const parsed = parseVaultFile(backup);
    expect(parsed.kind).toBe('backup');
  });

  it.each([
    ['empty', ''],
    ['not JSON at all', 'this is not a vault'],
    ['truncated mid-object', '{"v":1,"header":{"magic":"VAULT'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a bare number', '42'],
  ])('rejects %s as unreadable', (_label, text) => {
    expect(() => parseVaultFile(text)).toThrow(CorruptVaultError);
  });

  it('rejects an unrelated JSON file as not ours, rather than as damaged', () => {
    // The sniff is structural on the container, so this is the case that would go wrong if it were
    // written as "anything without a magic string is a container": someone's `package.json` has to
    // fail as the wrong file, not as a vault that needs recovering.
    expect(() => parseVaultFile(JSON.stringify({ name: 'something', version: '1.0.0' }))).toThrow(
      CorruptVaultError,
    );
  });

  it('rejects a file claiming our magic but nothing else', () => {
    expect(() => parseVaultFile(JSON.stringify({ magic: 'SOMETHING-ELSE' }))).toThrow(
      CorruptVaultError,
    );
  });

  it.each([
    ['an unknown container version', (file: Record<string, unknown>) => (file['v'] = 99)],
    ['no bucket table', (file: Record<string, unknown>) => delete file['buckets']],
    [
      'a bucket that is not base64url',
      (file: Record<string, unknown>) => ((file['buckets'] as Record<string, unknown>)['0'] = '!!'),
    ],
    ['a header that is not a vault header', (file: Record<string, unknown>) => (headerOf(file)['magic'] = 'nope')],
    ['no wrapped key', (file: Record<string, unknown>) => delete headerOf(file)['wrappedDek']],
    [
      'an unknown KDF algorithm',
      (file: Record<string, unknown>) =>
        ((headerOf(file)['kdf'] as Record<string, unknown>)['alg'] = 'scrypt'),
    ],
    [
      'too few iterations',
      (file: Record<string, unknown>) =>
        ((headerOf(file)['kdf'] as Record<string, unknown>)['iterations'] = MIN_KDF_ITERATIONS - 1),
    ],
    [
      'a salt that is not base64url',
      (file: Record<string, unknown>) =>
        ((headerOf(file)['kdf'] as Record<string, unknown>)['salt'] = 'not base64!'),
    ],
  ])('rejects a container with %s', (_label, change) => {
    expect(() => parseVaultFile(damaged(change))).toThrow(CorruptVaultError);
  });

  it('reports a schema from the future as unsupported, not as damage', () => {
    // The file is fine and this build is old. Telling somebody their vault is corrupt when it is
    // merely newer is how a good copy gets deleted.
    expect(() =>
      parseVaultFile(damaged((file) => (headerOf(file)['schemaVersion'] = SCHEMA_VERSION + 1))),
    ).toThrow(UnsupportedSchemaError);
  });

  it('reports a truncated upload as damage', () => {
    // The header promises buckets the file does not carry — what a torn upload leaves behind.
    expect(() => parseVaultFile(damaged((file) => (file['buckets'] = {})))).toThrow(
      CorruptVaultError,
    );
  });
});

describe('opening a sync container', () => {
  it('returns the items the vault held', async () => {
    const parsed = parseVaultFile(container);
    const items = await openVaultFile(parsed, PASSWORD);
    expect(liveIds(items)).toEqual(['b1', 'b2', 'f1']);
    expect(items.get('b1')?.title).toBe('A thing');
  }, 30_000);

  it('answers a wrong password as a wrong password', async () => {
    const parsed = parseVaultFile(container);
    await expect(openVaultFile(parsed, 'not the master password')).rejects.toThrow(
      WrongPasswordError,
    );
  }, 30_000);

  it('answers a bucket sealed under another key as damage, not as a typo', async () => {
    // Reachable only past the wrapped-key check, which is the whole point of the split: everything
    // after the password is known to be right is a file that has been tampered with or truncated.
    const parsed = parseVaultFile(
      damaged((file) => {
        const buckets = file['buckets'] as Record<string, string>;
        const [first] = Object.keys(buckets);
        if (first !== undefined) buckets[first] = toBase64Url(new Uint8Array(64));
      }),
    );
    await expect(openVaultFile(parsed, PASSWORD)).rejects.toThrow(CorruptVaultError);
  }, 30_000);
});

describe('previewing', () => {
  it('describes a container as a synced vault, dated by its last change', async () => {
    const parsed = parseVaultFile(container);
    const items = await openVaultFile(parsed, PASSWORD);
    const preview = previewOfFile(parsed, items, itemMap());

    expect(preview.origin).toBe('sync');
    expect(preview.bookmarks).toBe(2);
    expect(preview.folders).toBe(1);
    expect(preview.createdAt).toBe(T0);
    // A container carries no writing version, and inventing one would be the preview making
    // something up about where the file came from.
    expect(preview.createdBy).toBe('');
    // Thumbnails are their own Drive files; none of them is in this one.
    expect(preview.includesThumbs).toBe(false);
  }, 30_000);

  it('counts what the vault already has, against the same items', async () => {
    const parsed = parseVaultFile(container);
    const items = await openVaultFile(parsed, PASSWORD);
    const preview = previewOfFile(parsed, items, itemMap(bookmark('b1'), folder('f1')));
    expect(preview.known).toBe(2);
  }, 30_000);

  it('still describes a backup as a backup', async () => {
    const parsed = parseVaultFile(backup);
    const items = await openVaultFile(parsed, PASSWORD);
    const preview = previewOfFile(parsed, items, itemMap());
    expect(preview.origin).toBe('backup');
    expect(preview.createdBy).toBe('VaultaMark 1.0.0');
  }, 30_000);
});
