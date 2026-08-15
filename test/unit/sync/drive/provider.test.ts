/**
 * `DriveSyncProvider` against a Drive that runs in-process.
 *
 * The vaults here are real: one `VaultRepository`, created once, sealing genuine ciphertext. The
 * provider must never be able to tell the difference between these bytes and a real vault's,
 * because it is written not to look.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { utf8Decode, type Bytes } from '../../../../src/crypto/codec.js';
import { VaultRepository } from '../../../../src/storage/repo.js';
import { DriveApi } from '../../../../src/sync/drive/api.js';
import { DriveAuth } from '../../../../src/sync/drive/auth.js';
import {
  DRIVE_FOLDER_NAME,
  DriveSyncProvider,
  THUMBS_FOLDER_NAME,
  VAULT_FILE_NAME,
  thumbFileName,
} from '../../../../src/sync/drive/provider.js';
import { readDriveRecord } from '../../../../src/sync/drive/record.js';
import { CorruptRemote, PreconditionFailed } from '../../../../src/sync/provider.js';
import type { EncryptedVault } from '../../../../src/vault/types.js';
import { DriveMock } from '../../../mocks/drive.js';
import { installChromeMock, uninstallChromeMock } from '../../../mocks/chrome.js';

const PASSWORD = 'a reasonably long master password';

let drive: DriveMock;
let repo: VaultRepository;
let clock = 1_800_000_000_000;

function provider(): DriveSyncProvider {
  const auth = new DriveAuth({ clientId: 'test-client', fetch: drive.fetch, now: () => clock });
  return new DriveSyncProvider({
    auth,
    api: new DriveApi({ auth, fetch: drive.fetch, sleep: () => Promise.resolve() }),
    now: () => clock,
  });
}

/** A snapshot of the repository's items at a revision, sealed the way the engine would seal it. */
async function snapshot(rev: number): Promise<EncryptedVault> {
  return await repo.sealSnapshot(repo.items(), rev);
}

beforeAll(async () => {
  installChromeMock({ grantedPermissions: ['identity'] });
  repo = new VaultRepository();
  await repo.create(PASSWORD);
  await repo.apply([
    { kind: 'add', input: { type: 'bookmark', id: 'a', url: 'https://example.com/a', title: 'Alpha' } },
  ]);
  await repo.flush();
}, 30_000);

afterAll(() => {
  uninstallChromeMock();
});

beforeEach(async () => {
  drive = new DriveMock({ now: () => clock });
  // A fresh connection every time: `vm.drive` caches the file ids and `vm.driveToken` the access
  // token, and a test that inherited them would be exercising the cache rather than the lookup.
  await forget();
});

async function forget(): Promise<void> {
  await chrome.storage.local.remove('vm.drive');
  await chrome.storage.session.clear();
}

afterEach(() => {
  clock += 1_000;
});

describe('capabilities', () => {
  it('has a heavy tier and 50 MB of light tier', () => {
    expect(provider().capabilities).toEqual({ heavyTier: true, maxLightBytes: 50 * 1024 * 1024 });
  });
});

describe('the first push', () => {
  it('creates the folder and the file, with the revision in appProperties', async () => {
    const subject = provider();
    expect(await subject.peek()).toBeNull();

    const stamp = await subject.pushLight(await snapshot(4), null);
    expect(stamp.vaultRev).toBe(4);

    const folder = drive.byName(DRIVE_FOLDER_NAME);
    const file = drive.byName(VAULT_FILE_NAME);
    expect(folder?.mimeType).toBe('application/vnd.google-apps.folder');
    expect(file?.parents).toEqual([folder?.id]);
    expect(file?.appProperties).toEqual({ vmRev: '4', vmSchema: '2' });
  });

  it('remembers the ids, so the next peek is one request', async () => {
    const subject = provider();
    await subject.pushLight(await snapshot(4), null);
    expect((await readDriveRecord()).fileId).toBe(drive.byName(VAULT_FILE_NAME)?.id);

    drive.requests.length = 0;
    await subject.peek();
    expect(drive.requests).toHaveLength(1);
  });

  it('reuses a folder it already created rather than making a second one', async () => {
    await provider().pushLight(await snapshot(4), null);
    await forget();
    await provider().pushLight(await snapshot(5), await provider().peek());

    const folders = [...drive.files.values()].filter((file) => file.name === DRIVE_FOLDER_NAME);
    expect(folders).toHaveLength(1);
  });
});

describe('peek', () => {
  it('costs one request and downloads no payload', async () => {
    const subject = provider();
    await subject.pushLight(await snapshot(9), null);

    drive.requests.length = 0;
    const stamp = await subject.peek();
    expect(stamp?.vaultRev).toBe(9);
    expect(drive.requests).toHaveLength(1);
    expect(drive.requests[0]?.url).not.toContain('alt=media');
    expect(drive.requests[0]?.url).toContain('fields=');
  });

  it('finds a file the profile has never seen, by name', async () => {
    await provider().pushLight(await snapshot(3), null);
    await forget();
    expect((await provider().peek())?.vaultRev).toBe(3);
  });

  it('answers null when the user deleted the file from their Drive', async () => {
    const subject = provider();
    await subject.pushLight(await snapshot(3), null);
    drive.files.clear();
    expect(await subject.peek()).toBeNull();
    // And forgets the id, so the next push creates rather than 404s forever.
    expect((await readDriveRecord()).fileId).toBeNull();
  });

  it('refuses to reason about a file that carries no VaultaMark revision', async () => {
    const subject = provider();
    await subject.pushLight(await snapshot(3), null);
    const file = drive.byName(VAULT_FILE_NAME);
    if (file !== undefined) file.appProperties = {};
    await expect(subject.peek()).rejects.toBeInstanceOf(CorruptRemote);
  });
});

describe('pull and push', () => {
  it('round-trips the ciphertext', async () => {
    const subject = provider();
    const pushed = await snapshot(6);
    await subject.pushLight(pushed, null);

    const pulled = await subject.pullLight();
    expect(pulled?.header).toEqual(pushed.header);
    expect(await repo.openEncrypted(pulled!)).toEqual(repo.items());
  });

  it('answers null from a pull when there is nothing there', async () => {
    expect(await provider().pullLight()).toBeNull();
  });

  it('refuses a push when the remote moved past the stamp the caller had', async () => {
    const subject = provider();
    const first = await subject.pushLight(await snapshot(1), null);
    await subject.pushLight(await snapshot(2), first);

    await expect(subject.pushLight(await snapshot(3), first)).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
  });

  it('carries the current stamp on the refusal, so the engine need not peek again', async () => {
    const subject = provider();
    const first = await subject.pushLight(await snapshot(1), null);
    await subject.pushLight(await snapshot(2), first);

    await subject.pushLight(await snapshot(3), first).catch((error: unknown) => {
      expect((error as PreconditionFailed).current?.vaultRev).toBe(2);
    });
  });

  it('refuses a first push against a remote that already exists', async () => {
    const subject = provider();
    await subject.pushLight(await snapshot(1), null);
    await expect(subject.pushLight(await snapshot(2), null)).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
  });

  it('reports a file somebody edited by hand as a remote to repair', async () => {
    const subject = provider();
    await subject.pushLight(await snapshot(1), null);
    const file = drive.byName(VAULT_FILE_NAME);
    if (file !== undefined) file.content = new TextEncoder().encode('{"v":1,"oops":true}');
    await expect(subject.pullLight()).rejects.toBeInstanceOf(CorruptRemote);
  });
});

describe('the heavy tier', () => {
  const thumb = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

  it('stores a thumbnail in its own folder, named after the item', async () => {
    const subject = provider();
    await subject.pushLight(await snapshot(1), null);
    await subject.putThumb('item-1', thumb);

    const file = drive.byName(thumbFileName('item-1'));
    expect(file?.appProperties).toEqual({ vmItem: 'item-1' });
    expect(file?.parents).toEqual([drive.byName(THUMBS_FOLDER_NAME)?.id]);
    expect([...(file?.content ?? [])]).toEqual([...thumb]);
  });

  it('reads it back byte for byte', async () => {
    const subject = provider();
    await subject.putThumb('item-1', thumb);
    expect([...((await subject.getThumb('item-1')) ?? [])]).toEqual([...thumb]);
  });

  it('replaces rather than duplicating', async () => {
    const subject = provider();
    await subject.putThumb('item-1', thumb);
    await subject.putThumb('item-1', new Uint8Array([9, 9]));
    expect([...drive.files.values()].filter((file) => file.name === thumbFileName('item-1'))).toHaveLength(1);
    expect([...((await subject.getThumb('item-1')) ?? [])]).toEqual([9, 9]);
  });

  it('answers null for an item with no thumbnail', async () => {
    expect(await provider().getThumb('nothing')).toBeNull();
  });

  it('deletes one, and shrugs at deleting one that is not there', async () => {
    const subject = provider();
    await subject.putThumb('item-1', thumb);
    await subject.deleteThumb('item-1');
    expect(await subject.getThumb('item-1')).toBeNull();
    await expect(subject.deleteThumb('item-1')).resolves.toBeUndefined();
  });
});

describe('connecting and disconnecting', () => {
  it('learns the account address once and keeps it', async () => {
    const subject = provider();
    await subject.init();
    expect((await readDriveRecord()).email).toBe('someone@example.com');

    drive.requests.length = 0;
    await subject.init();
    expect(drive.requests).toHaveLength(0);
  });

  it('reports Drive’s own usage', async () => {
    expect(await provider().usage()).toEqual({ usedBytes: 4_000_000, quotaBytes: 15_000_000_000 });
  });

  it('leaves the user’s files exactly where they are on disconnect', async () => {
    const subject = provider();
    await subject.pushLight(await snapshot(1), null);
    await subject.disconnect();

    expect(drive.byName(VAULT_FILE_NAME)).toBeDefined();
    expect(drive.revoked).toEqual(['chrome-identity-token']);
    expect((await readDriveRecord()).fileId).toBeNull();
  });

  it('deletes them only when asked, as a second explicit step', async () => {
    const subject = provider();
    await subject.pushLight(await snapshot(1), null);
    await subject.deleteRemote();
    expect(drive.byName(DRIVE_FOLDER_NAME)).toBeUndefined();
  });
});

describe('what the file looks like in Drive', () => {
  it('is an ordinary, user-visible file whose contents are ciphertext', async () => {
    await provider().pushLight(await snapshot(1), null);
    const text = utf8Decode(drive.byName(VAULT_FILE_NAME)?.content as Bytes);

    expect(text).toContain('VAULTAMARK');
    // INV-6: the header is plaintext by design and everything else is not. Nothing a bookmark says
    // may appear anywhere in this file.
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('Alpha');
  });
});
