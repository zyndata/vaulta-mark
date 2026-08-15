/**
 * `DriveSyncProvider` — the opt-in transport, on the user's own Google Drive (ARCHITECTURE §13).
 *
 * It is the same interface the Chrome tier implements and the same bytes cross it: the provider
 * moves an {@link EncryptedVault} and never sees a key. What it buys is room — 50 MB of light tier
 * against `storage.sync`'s 100 KB — and the heavy tier, which is what Phase 11's thumbnails need.
 * What it costs is an OAuth consent screen and an account, which is why it is opt-in and why the
 * Chrome tier stays the default.
 *
 * Four things differ from the Chrome provider, and all four are consequences of it being one file
 * rather than a hundred key/value items:
 *
 * - **There is no "buckets before header" ordering to get right.** The whole vault is one upload,
 *   and Drive replaces a file's contents atomically, so the torn state §5.4.1 orders writes to
 *   survive cannot occur here. A failed upload leaves the previous revision intact.
 * - **`peek()` is one request and downloads nothing** — `fields=modifiedTime,version,md5Checksum,
 *   appProperties`, about 300 bytes. `appProperties.vmRev` is authoritative and `md5Checksum` is
 *   the cross-check (§13.4).
 * - **The compare-and-swap is real, when Drive gives us an `ETag`.** Where it does not, this falls
 *   back to the same read-verify-write the Chrome tier uses, and correctness still rests on the
 *   merge engine being idempotent.
 * - **`disconnect()` leaves the user's files alone.** They are ordinary Drive objects in an
 *   ordinary folder; deleting them behind a "stop syncing" button would be taking something that is
 *   not ours. Deleting them is a second, explicit action ({@link DriveSyncProvider.deleteRemote}).
 */

import type { VaultCipher } from '../../storage/repo.js';
import type { EncryptedVault } from '../../vault/types.js';
import {
  CorruptRemote,
  PreconditionFailed,
  type ProviderCapabilities,
  type ProviderUsage,
  type RemoteStamp,
  type SyncProvider,
} from '../provider.js';
import { DriveApi, FOLDER_MIME, type DriveFile } from './api.js';
import { DriveAuth } from './auth.js';
import { decodeVault, encodeVault } from './container.js';
import { patchDriveRecord, readDriveRecord } from './record.js';

/** §13.3. Ordinary, user-visible names — the file is meant to be findable and copyable. */
export const DRIVE_FOLDER_NAME = 'VaultaMark';
export const VAULT_FILE_NAME = 'vaultamark-vault.vmv';
export const THUMBS_FOLDER_NAME = 'thumbs';

export function thumbFileName(itemId: string): string {
  return `t_${itemId}.vmt`;
}

/**
 * The light tier's ceiling on Drive: 50 MB.
 *
 * Not a Drive limit — it is a limit on how large a vault this design stays sensible for. The whole
 * file is re-uploaded on every push, so a light tier measured in hundreds of megabytes would mean
 * a hundred-megabyte upload every time a title changed.
 */
export const DRIVE_MAX_LIGHT_BYTES = 50 * 1024 * 1024;

export interface DriveSyncProviderOptions {
  readonly auth?: DriveAuth;
  readonly api?: DriveApi;
  /** The unlocked vault's cipher, for the sealed refresh token. `null` while locked. */
  readonly cipher?: () => Promise<VaultCipher | null>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export class DriveSyncProvider implements SyncProvider {
  readonly id = 'drive' as const;

  readonly capabilities: ProviderCapabilities = {
    heavyTier: true,
    maxLightBytes: DRIVE_MAX_LIGHT_BYTES,
  };

  readonly #auth: DriveAuth;
  readonly #api: DriveApi;
  readonly #now: () => number;

  constructor(options: DriveSyncProviderOptions = {}) {
    this.#auth =
      options.auth ??
      new DriveAuth({
        ...(options.cipher === undefined ? {} : { cipher: options.cipher }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    this.#api =
      options.api ??
      new DriveApi({
        auth: this.#auth,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.random === undefined ? {} : { random: options.random }),
      });
    this.#now = options.now ?? (() => Date.now());
  }

  get auth(): DriveAuth {
    return this.#auth;
  }

  /**
   * Prove we can talk to Drive, and learn who we are talking as.
   *
   * Non-interactive: `init()` runs on every sync trigger, and a background probe that could put a
   * consent screen on screen is not a background probe. Connecting is a separate, explicit act.
   */
  async init(): Promise<void> {
    const record = await readDriveRecord();
    if (record.email !== null) return;
    const email = await this.#api.account();
    if (email !== null) await patchDriveRecord({ email });
  }

  /** One metadata request, no payload, no decryption (§13.4). */
  async peek(): Promise<RemoteStamp | null> {
    const file = await this.#vaultFile();
    return file === null ? null : stampOf(file, this.#now());
  }

  async pullLight(): Promise<EncryptedVault | null> {
    const file = await this.#vaultFile();
    if (file === null) return null;
    const bytes = await this.#api.download(file.id);
    if (bytes === null) return null;
    return decodeVault(bytes);
  }

  /**
   * Write the vault.
   *
   * `expect` is the stamp the caller was working from. The remote is read first and compared
   * against it, and the `ETag` from that read is sent as `If-Match` so that a device writing in the
   * gap between the two is caught by Drive rather than by us — which is the one thing the Chrome
   * tier genuinely cannot do.
   */
  async pushLight(vault: EncryptedVault, expect: RemoteStamp | null): Promise<RemoteStamp> {
    const current = await this.#vaultFile();
    const currentStamp = current === null ? null : stampOf(current, this.#now());
    if (!sameStamp(currentStamp, expect)) throw new PreconditionFailed(currentStamp);

    const media = encodeVault(vault);
    const appProperties = {
      vmRev: String(vault.header.vaultRev),
      vmSchema: String(vault.header.schemaVersion),
    };

    const written =
      current === null
        ? await this.#api.upload(null, {
            name: VAULT_FILE_NAME,
            parents: [await this.#folderId()],
            mimeType: 'application/octet-stream',
            appProperties,
            media,
          })
        : await this.#api.upload(current.id, {
            appProperties,
            media,
            ...(current.etag === undefined ? {} : { etag: current.etag }),
          });

    await patchDriveRecord({
      fileId: written.id,
      ...(written.webViewLink === undefined ? {} : { webViewLink: written.webViewLink }),
    });
    return stampOf(written, this.#now());
  }

  /* ---------------------------------------------------------------- the heavy tier */

  async getThumb(itemId: string): Promise<Uint8Array | null> {
    const file = await this.#thumbFile(itemId);
    if (file === null) return null;
    return await this.#api.download(file.id);
  }

  async putThumb(itemId: string, blob: Uint8Array): Promise<void> {
    const existing = await this.#thumbFile(itemId);
    const media = new Uint8Array(blob);
    const appProperties = { vmItem: itemId };
    if (existing === null) {
      await this.#api.upload(null, {
        name: thumbFileName(itemId),
        parents: [await this.#thumbsFolderId()],
        mimeType: 'application/octet-stream',
        appProperties,
        media,
      });
      return;
    }
    await this.#api.upload(existing.id, { appProperties, media });
  }

  async deleteThumb(itemId: string): Promise<void> {
    const file = await this.#thumbFile(itemId);
    if (file !== null) await this.#api.remove(file.id);
  }

  /* ---------------------------------------------------------------- housekeeping */

  /**
   * Drive's own numbers, not the vault's.
   *
   * A Workspace account with pooled storage reports no limit at all, which comes back as `0`; the
   * UI draws no bar rather than a wrong one.
   */
  async usage(): Promise<ProviderUsage> {
    return await this.#api.storage();
  }

  /**
   * Stop using Drive, and leave everything in it exactly where it is.
   *
   * The opposite of the Chrome provider's disconnect, and deliberately: `storage.sync` is a shared
   * area where a leftover copy would keep being pulled by other devices, while a Drive file is a
   * file in someone's own Drive. Ours to stop writing, not ours to delete.
   */
  async disconnect(): Promise<void> {
    await this.#auth.revoke();
    await patchDriveRecord({ fileId: null, folderId: null, thumbsFolderId: null, email: null });
  }

  /** The explicit second step: remove the folder we created. Only ever from a confirmed choice. */
  async deleteRemote(): Promise<void> {
    const record = await readDriveRecord();
    const folderId = record.folderId ?? (await this.#findFolder())?.id ?? null;
    if (folderId !== null) await this.#api.remove(folderId);
    await patchDriveRecord({ fileId: null, folderId: null, thumbsFolderId: null });
  }

  /* ---------------------------------------------------------------- locating things */

  /**
   * The vault file, by cached id where we have one.
   *
   * The cached id is checked rather than trusted: a user can delete the file from Drive, and the id
   * we remember then names something that is not there. A `null` from the metadata read falls
   * through to a search by name, and a search that finds nothing means "no remote yet" — which is
   * the same state a fresh install is in, and is handled by creating one.
   */
  async #vaultFile(): Promise<DriveFile | null> {
    const record = await readDriveRecord();
    if (record.fileId !== null) {
      const known = await this.#api.metadata(record.fileId);
      if (known !== null) return known;
      await patchDriveRecord({ fileId: null });
    }
    const found = await this.#search(VAULT_FILE_NAME, record.folderId);
    if (found !== null) {
      await patchDriveRecord({
        fileId: found.id,
        ...(found.webViewLink === undefined ? {} : { webViewLink: found.webViewLink }),
      });
    }
    return found;
  }

  async #thumbFile(itemId: string): Promise<DriveFile | null> {
    const record = await readDriveRecord();
    return await this.#search(thumbFileName(itemId), record.thumbsFolderId);
  }

  async #search(name: string, parentId: string | null): Promise<DriveFile | null> {
    const clauses = [`name = '${escapeQuery(name)}'`, 'trashed = false'];
    if (parentId !== null) clauses.push(`'${escapeQuery(parentId)}' in parents`);
    const files = await this.#api.list(clauses.join(' and '));
    // Newest first, so a user who somehow ended up with two takes the one they last wrote. Rare,
    // and the alternative — refusing to sync until they tidy their Drive — is worse.
    return files[0] ?? null;
  }

  async #folderId(): Promise<string> {
    const record = await readDriveRecord();
    if (record.folderId !== null) return record.folderId;
    const existing = await this.#findFolder();
    const folder = existing ?? (await this.#api.createFolder(DRIVE_FOLDER_NAME));
    await patchDriveRecord({ folderId: folder.id });
    return folder.id;
  }

  async #thumbsFolderId(): Promise<string> {
    const record = await readDriveRecord();
    if (record.thumbsFolderId !== null) return record.thumbsFolderId;
    const parent = await this.#folderId();
    const files = await this.#api.list(
      `name = '${THUMBS_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false and '${escapeQuery(parent)}' in parents`,
    );
    const folder = files[0] ?? (await this.#api.createFolder(THUMBS_FOLDER_NAME, parent));
    await patchDriveRecord({ thumbsFolderId: folder.id });
    return folder.id;
  }

  async #findFolder(): Promise<DriveFile | null> {
    const files = await this.#api.list(
      `name = '${DRIVE_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    );
    return files[0] ?? null;
  }
}

/**
 * A stamp from Drive's metadata.
 *
 * `appProperties.vmRev` is the authority on the revision, because it is what *we* wrote alongside
 * the bytes; `md5Checksum` is the content hash, and is Drive's own, computed over the file it
 * actually holds. A file with no `vmRev` was not written by us and is not a vault we can reason
 * about — which the missing checksum makes the engine treat as a remote to repair.
 */
export function stampOf(file: DriveFile, modifiedAt: number): RemoteStamp {
  const rev = Number(file.appProperties?.['vmRev'] ?? Number.NaN);
  if (!Number.isFinite(rev)) {
    throw new CorruptRemote('The Drive vault file carries no VaultaMark revision.');
  }
  return {
    vaultRev: rev,
    contentHash: file.md5Checksum ?? '',
    modifiedAt: file.modifiedTime === undefined ? modifiedAt : Date.parse(file.modifiedTime),
  };
}

function sameStamp(a: RemoteStamp | null, b: RemoteStamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.vaultRev === b.vaultRev && a.contentHash === b.contentHash;
}

/**
 * Escape a value going into a Drive query string.
 *
 * The names we search for are constants, so this is not defending against an injection today — it
 * is defending against the day one of them becomes a variable. A Drive query is a little language
 * with `'` as its string delimiter and `\` as its escape.
 */
function escapeQuery(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
}
