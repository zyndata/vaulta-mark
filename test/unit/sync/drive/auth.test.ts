/**
 * Getting a Drive token, by both routes (ARCHITECTURE §13.2).
 *
 * The cipher here is a stand-in: it round-trips a value through JSON rather than sealing it. What
 * `auth.ts` needs from a cipher is "a way to make the refresh token unreadable without the vault",
 * and the sealing itself is proved in `test/unit/storage/codec.test.ts`. Substituting it keeps
 * these tests off a 600,000-iteration KDF they are not about.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { utf8, utf8Decode, type Bytes } from '../../../../src/crypto/codec.js';
import type { VaultCipher } from '../../../../src/storage/repo.js';
import { AuthRequired, Offline } from '../../../../src/sync/provider.js';
import { DriveAuth, DRIVE_SCOPE } from '../../../../src/sync/drive/auth.js';
import {
  patchDriveRecord,
  readAccessToken,
  readDriveRecord,
  writeAccessToken,
} from '../../../../src/sync/drive/record.js';
import { DriveMock } from '../../../mocks/drive.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../../mocks/chrome.js';

const CLIENT_ID = '1234-test.apps.googleusercontent.com';

const cipher: VaultCipher = {
  seal: (_purpose, _id, value) => Promise.resolve(utf8(JSON.stringify(value))),
  open: (_purpose, _id, sealed) => Promise.resolve(JSON.parse(utf8Decode(sealed)) as unknown),
};

let chromeMock: ChromeMock;
let drive: DriveMock;
let now = 1_800_000_000_000;

function auth(options: { cipher?: () => Promise<VaultCipher | null> } = {}): DriveAuth {
  return new DriveAuth({
    clientId: CLIENT_ID,
    fetch: drive.fetch,
    now: () => now,
    cipher: options.cipher ?? (() => Promise.resolve(cipher)),
    randomBytes: (count) => new Uint8Array(count).fill(7),
  });
}

beforeEach(() => {
  now = 1_800_000_000_000;
  drive = new DriveMock({ now: () => now });
  chromeMock = installChromeMock({ grantedPermissions: ['identity'] });
});

afterEach(() => {
  uninstallChromeMock();
});

describe('the Chrome identity route', () => {
  it('asks for exactly one scope, and only drive.file', async () => {
    await auth().token({ interactive: true });
    expect(chromeMock.identity.calls).toEqual([
      { interactive: true, scopes: ['https://www.googleapis.com/auth/drive.file'] },
    ]);
    expect(DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  });

  it('caches the token in storage.session and reuses it', async () => {
    const subject = auth();
    expect(await subject.token()).toBe('chrome-identity-token');
    expect(await subject.token()).toBe('chrome-identity-token');
    expect(chromeMock.identity.calls).toHaveLength(1);
    // `storage.session`, never `storage.local`: an access token is a credential and the session
    // area is the one that empties when the browser does.
    expect(chromeMock.storage.session.snapshot()['vm.driveToken']).toBeDefined();
    expect(chromeMock.storage.local.snapshot()['vm.driveToken']).toBeUndefined();
  });

  it('stops trusting a cached token a minute before it expires', async () => {
    await writeAccessToken({ token: 'stale', expiresAt: now + 30_000 });
    expect(await auth().token()).toBe('chrome-identity-token');
  });

  it('tells Chrome to drop a token that was rejected', async () => {
    const subject = auth();
    const token = await subject.token();
    await subject.invalidate(token);
    expect(chromeMock.identity.removedTokens).toEqual(['chrome-identity-token']);
    expect(await readAccessToken()).toBeNull();
  });

  it('refuses without a consent screen when Chrome demands one', async () => {
    chromeMock.identity.needsInteraction = true;
    await expect(auth().token()).rejects.toBeInstanceOf(AuthRequired);
  });

  it('says so plainly when the build has no OAuth client', async () => {
    const unconfigured = new DriveAuth({ clientId: '', fetch: drive.fetch });
    expect(unconfigured.configured).toBe(false);
    await expect(unconfigured.token({ interactive: true })).rejects.toBeInstanceOf(AuthRequired);
  });

  it('needs the optional identity permission to exist at all', async () => {
    chromeMock.grantedPermissions.delete('identity');
    await expect(auth().token({ interactive: true })).rejects.toBeInstanceOf(AuthRequired);
  });
});

describe('the PKCE fallback', () => {
  beforeEach(() => {
    // A profile that is not signed into Chrome: `getAuthToken` rejects, which is the only signal
    // Chrome gives and the entire reason this route exists.
    chromeMock.identity.token = null;
  });

  it('falls back to the web flow on an interactive call, and remembers that it had to', async () => {
    const token = await auth().token({ interactive: true });
    expect(token).toBe('web-access-token');
    expect((await readDriveRecord()).mode).toBe('web');
  });

  it('sends a S256 challenge and never a client secret', async () => {
    await auth().token({ interactive: true });
    const url = new URL(chromeMock.identity.authFlowUrls[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).not.toBe('');
    expect(url.searchParams.get('scope')).toBe(DRIVE_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    const exchange = drive.requests.find((request) => request.url.includes('oauth2.googleapis.com'));
    expect(String(exchange?.url)).not.toContain('client_secret');
  });

  it('seals the refresh token rather than storing it in the clear', async () => {
    await auth().token({ interactive: true });
    const stored = (await readDriveRecord()).refreshToken;
    expect(stored).not.toBeNull();
    expect(JSON.stringify(chromeMock.storage.local.snapshot())).not.toContain('web-refresh-token');
    expect(await cipher.open('oauth', '', decode(stored ?? ''))).toEqual({
      refreshToken: 'web-refresh-token',
    });
  });

  it('drops a refresh token that arrives while the vault is locked', async () => {
    await auth({ cipher: () => Promise.resolve(null) }).token({ interactive: true });
    // Nothing to seal it with, and writing a standing Drive grant to disk in the clear is the one
    // outcome §13.2 rules out. The connection still works for this session.
    expect((await readDriveRecord()).refreshToken).toBeNull();
  });

  it('refreshes silently once it has a refresh token', async () => {
    const subject = auth();
    await subject.token({ interactive: true });
    chromeMock.identity.authFlowUrls.length = 0;
    await chrome.storage.session.clear();

    expect(await subject.token()).toBe('web-access-token');
    expect(chromeMock.identity.authFlowUrls).toHaveLength(0);
  });

  it('forgets a refresh token Google no longer accepts, and asks for consent again', async () => {
    const subject = auth();
    await subject.token({ interactive: true });
    await chrome.storage.session.clear();
    drive.rejectedRefreshTokens.add('web-refresh-token');

    await expect(subject.token()).rejects.toBeInstanceOf(AuthRequired);
    expect((await readDriveRecord()).refreshToken).toBeNull();
  });

  it('reports no network as Offline rather than as something the user must fix', async () => {
    await patchDriveRecord({ mode: 'web' });
    const offline = new DriveAuth({
      clientId: CLIENT_ID,
      cipher: () => Promise.resolve(cipher),
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      now: () => now,
    });
    await patchDriveRecord({ refreshToken: await sealed('web-refresh-token') });
    await expect(offline.token({ interactive: true })).rejects.toBeInstanceOf(Offline);
  });

  it('reports a closed authorization window as AuthRequired', async () => {
    chromeMock.identity.webAuthFlow = () => null;
    await expect(auth().token({ interactive: true })).rejects.toBeInstanceOf(AuthRequired);
  });

  it('reports a redirect that carries an error instead of a code', async () => {
    chromeMock.identity.webAuthFlow = () => 'https://x.chromiumapp.org/?error=access_denied';
    await expect(auth().token({ interactive: true })).rejects.toBeInstanceOf(AuthRequired);
  });
});

describe('revoking', () => {
  it('hands the grant back and forgets the token', async () => {
    const subject = auth();
    await subject.token({ interactive: true });
    await subject.revoke();

    expect(drive.revoked).toEqual(['chrome-identity-token']);
    expect(await readAccessToken()).toBeNull();
  });

  it('completes even when the revoke request fails', async () => {
    await writeAccessToken({ token: 'chrome-identity-token', expiresAt: now + 3_600_000 });
    const offline = new DriveAuth({
      clientId: CLIENT_ID,
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      now: () => now,
    });
    await offline.revoke();
    expect(await readAccessToken()).toBeNull();
  });
});

function decode(value: string): Bytes {
  return Uint8Array.from(atob(value.replace(/-/gu, '+').replace(/_/gu, '/')), (char) =>
    char.charCodeAt(0),
  );
}

async function sealed(token: string): Promise<string> {
  const bytes = await cipher.seal('oauth', '', { refreshToken: token });
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}
