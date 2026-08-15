/**
 * The same two devices, over Google Drive.
 *
 * This is the payoff of the `SyncProvider` interface and the reason Phase 7 built one before there
 * was anything to abstract over: every scenario in `test/helpers/two-device.ts` — merges, conflicts,
 * tombstones, reattachment, two hundred random interleavings — runs unchanged over a completely
 * different transport, and converges to the same bucket tag tables.
 *
 * Two things differ, and both live in this file rather than in the suite.
 *
 * - **The devices share a `DriveMock`, not a storage area.** Each device keeps its own `vm.drive`
 *   in its own `storage.local`, which is right: file ids and the access token are per-profile, and
 *   the *file* is what is shared.
 * - **A Drive push cannot tear the way a `storage.sync` push can.** The whole vault goes up in one
 *   request and Drive replaces a file's contents atomically, so the only way to produce a
 *   half-written remote is for something outside our code to truncate it — which is what `tear`
 *   does here, and what the engine must survive either way.
 */

import { DriveApi } from '../../src/sync/drive/api.js';
import { DriveAuth } from '../../src/sync/drive/auth.js';
import { DriveSyncProvider, VAULT_FILE_NAME } from '../../src/sync/drive/provider.js';
import { DriveMock } from '../mocks/drive.js';
import { describeTwoDeviceSync } from '../helpers/two-device.js';

let drive: DriveMock;
let now: () => number = () => Date.now();

describeTwoDeviceSync({
  name: 'Google Drive',

  reset(clock) {
    now = () => clock.now();
    drive = new DriveMock({ now });
  },

  attach() {
    // Nothing to share: the file is the shared thing, and each profile finds it by name the first
    // time it looks. That is the same path a second real computer takes.
  },

  provider() {
    const auth = new DriveAuth({ clientId: 'test-client', fetch: drive.fetch, now });
    return new DriveSyncProvider({
      auth,
      api: new DriveApi({ auth, fetch: drive.fetch, sleep: () => Promise.resolve() }),
      now,
    });
  },

  remoteFingerprint() {
    const file = drive.vaultFile();
    return file === undefined ? 'none' : `${String(file.version)}:${String(file.content.length)}`;
  },

  async tear(push) {
    // Half the bytes arrive, the metadata part having gone first, and then the connection drops —
    // so the file carries the new revision over a truncated body and the pushing device never
    // learns whether it worked. The merge base is therefore *not* advanced, which is the property
    // that makes this recoverable: the device still knows it has something the remote does not.
    drive.truncateNextUpload = true;
    await push();
    expect(drive.vaultFile()?.name).toBe(VAULT_FILE_NAME);
  },
});
