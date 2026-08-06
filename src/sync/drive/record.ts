/**
 * `vm.drive` — what this profile remembers about its Drive connection.
 *
 * Two rules decide what may live here, and they pull in opposite directions.
 *
 * - **It is `storage.local`, so it is plaintext, so it may hold no vault content (INV-6).** File
 *   ids and a folder id describe *where* the ciphertext is kept, not what is in it; the account
 *   address describes who is signed in. None of that is a bookmark.
 * - **The refresh token is the exception that is sealed anyway.** It is not vault content either,
 *   but it is a standing grant on someone's Drive that outlives the browser session, and sealing it
 *   under `k_items` (ARCHITECTURE §13.2) makes an unlocked vault the precondition for using it. It
 *   is stored here as base64url of the sealed bytes and is meaningless without the vault key.
 *
 * The access token is deliberately **not** here. It lives in `chrome.storage.session`, which is
 * memory-backed and emptied when the browser exits — the same custody the DEK gets, for the same
 * reason.
 */

import { fromBase64Url, toBase64Url } from '../../crypto/codec.js';
import type { VaultCipher } from '../../storage/repo.js';

/** `storage.local`. Cleared by `clearVault()` along with everything else under `vm.`. */
export const DRIVE_KEY = 'vm.drive';

/** `storage.session`. The access token and nothing else. */
export const DRIVE_TOKEN_KEY = 'vm.driveToken';

/** Which of the two authentication routes this profile is on (ARCHITECTURE §13.2). */
export type AuthMode = 'identity' | 'web';

export interface DriveRecord {
  /**
   * `identity` when `chrome.identity.getAuthToken` worked — the profile is signed into Chrome and
   * Chrome owns the token. `web` when the PKCE flow was used instead, and we hold a refresh token.
   */
  readonly mode: AuthMode;
  /** The Drive account, for the settings screen. `null` until the first successful call. */
  readonly email: string | null;
  /** Ids of the objects we created, cached so a `peek()` costs one request rather than three. */
  readonly folderId: string | null;
  readonly fileId: string | null;
  readonly thumbsFolderId: string | null;
  /** Drive's own "open this file" address, learned from the API. Absent until we have created it. */
  readonly webViewLink: string | null;
  /** base64url of the sealed refresh token. `web` mode only; `null` under `identity`. */
  readonly refreshToken: string | null;
}

export const EMPTY_DRIVE_RECORD: DriveRecord = {
  mode: 'identity',
  email: null,
  folderId: null,
  fileId: null,
  thumbsFolderId: null,
  webViewLink: null,
  refreshToken: null,
};

/**
 * Read the record, defaulting every field.
 *
 * Never throws, for the same reason `readSettings` does not: a damaged record must not be able to
 * keep someone out of the settings screen that would let them reconnect. The worst case is a
 * connection that has to be made again.
 */
export async function readDriveRecord(): Promise<DriveRecord> {
  const raw = (await chrome.storage.local.get(DRIVE_KEY))[DRIVE_KEY];
  if (raw === null || typeof raw !== 'object') return EMPTY_DRIVE_RECORD;
  const stored = raw as Partial<DriveRecord>;
  return {
    mode: stored.mode === 'web' ? 'web' : 'identity',
    email: text(stored.email),
    folderId: text(stored.folderId),
    fileId: text(stored.fileId),
    thumbsFolderId: text(stored.thumbsFolderId),
    webViewLink: text(stored.webViewLink),
    refreshToken: text(stored.refreshToken),
  };
}

export async function writeDriveRecord(record: DriveRecord): Promise<void> {
  await chrome.storage.local.set({ [DRIVE_KEY]: record });
}

/** Merge a partial update into the stored record. */
export async function patchDriveRecord(patch: Partial<DriveRecord>): Promise<DriveRecord> {
  const next = { ...(await readDriveRecord()), ...patch };
  await writeDriveRecord(next);
  return next;
}

export async function clearDriveRecord(): Promise<void> {
  await chrome.storage.local.remove(DRIVE_KEY);
  await chrome.storage.session.remove(DRIVE_TOKEN_KEY);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/* ------------------------------------------------------------------ the refresh token */

/**
 * Seal a refresh token for `storage.local`.
 *
 * Under the vault's item key, with its own AAD purpose, so a sealed token cannot be replayed into
 * any other slot — and so that losing the vault key means losing the ability to refresh, which is
 * the property §13.2 asks for.
 */
export async function sealRefreshToken(cipher: VaultCipher, token: string): Promise<string> {
  return toBase64Url(await cipher.seal('oauth', '', { refreshToken: token }));
}

/** Open what {@link sealRefreshToken} wrote. `null` when it is absent or will not open. */
export async function openRefreshToken(
  cipher: VaultCipher,
  sealed: string | null,
): Promise<string | null> {
  if (sealed === null) return null;
  try {
    const payload = await cipher.open('oauth', '', fromBase64Url(sealed));
    const token = (payload as { refreshToken?: unknown }).refreshToken;
    return typeof token === 'string' && token !== '' ? token : null;
  } catch {
    // A token sealed under a key this vault no longer has is a token we cannot use. Treating that
    // as "not connected" sends the user through the consent screen again, which works; treating it
    // as an error would leave Drive permanently broken with no way back through the UI.
    return null;
  }
}

/* ------------------------------------------------------------------ the access token */

export interface AccessToken {
  readonly token: string;
  /** Epoch ms. `0` when the issuer did not say, which is treated as "expires immediately". */
  readonly expiresAt: number;
}

export async function readAccessToken(): Promise<AccessToken | null> {
  const raw = (await chrome.storage.session.get(DRIVE_TOKEN_KEY))[DRIVE_TOKEN_KEY];
  if (raw === null || typeof raw !== 'object') return null;
  const stored = raw as Partial<AccessToken>;
  if (typeof stored.token !== 'string' || stored.token === '') return null;
  return { token: stored.token, expiresAt: typeof stored.expiresAt === 'number' ? stored.expiresAt : 0 };
}

export async function writeAccessToken(token: AccessToken): Promise<void> {
  await chrome.storage.session.set({ [DRIVE_TOKEN_KEY]: token });
}

export async function clearAccessToken(): Promise<void> {
  await chrome.storage.session.remove(DRIVE_TOKEN_KEY);
}
