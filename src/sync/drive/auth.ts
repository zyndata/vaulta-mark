/**
 * Getting an access token for Drive, by whichever of the two routes this profile can use
 * (ARCHITECTURE §13.2).
 *
 * **The primary route is `chrome.identity.getAuthToken`.** Chrome owns the token, refreshes it,
 * and revokes it when the user signs out; the extension never sees a refresh token and never
 * stores a credential. That is the whole reason it is the primary route, and it is available only
 * to a profile that is signed into Chrome.
 *
 * **The fallback is `launchWebAuthFlow` with PKCE**, for a profile that is not. There is no client
 * secret — `code_challenge_method=S256` is what replaces it, which is what makes shipping this in a
 * public package acceptable at all. It produces a refresh token, and a refresh token is a standing
 * grant on someone's Drive that outlives the browser session, so it is sealed under `k_items`
 * before it is written down: refreshing then requires an unlocked vault.
 *
 * Two things here are deliberately *not* errors:
 *
 * - **A 401 is one retry, not a failure.** The cached token is dropped and one interactive-free
 *   attempt is made before {@link AuthRequired} is raised, because Chrome hands out tokens that
 *   expire while a sync is in flight and re-prompting for that would be absurd.
 * - **No network is {@link Offline}, not {@link AuthRequired}.** They look identical from a failed
 *   `fetch` and mean completely different things to the user: one resolves itself, the other needs
 *   them to do something.
 */

import { toBase64Url, utf8, type Bytes } from '../../crypto/codec.js';
import { sha256 } from '../../crypto/hash.js';
import type { VaultCipher } from '../../storage/repo.js';
import { AuthRequired, Offline } from '../provider.js';
import {
  clearAccessToken,
  openRefreshToken,
  patchDriveRecord,
  readAccessToken,
  readDriveRecord,
  sealRefreshToken,
  writeAccessToken,
  type AuthMode,
} from './record.js';

/**
 * The one scope, ever (D22, §13.1).
 *
 * `drive.file` sees only files this extension created. Full `drive` is a Restricted scope and would
 * put an annual CASA Tier-2 assessment between us and every release.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://accounts.google.com/o/oauth2/revoke';

/** The optional permissions Drive sync needs. Requested together, in context, never at install. */
export const DRIVE_PERMISSIONS: chrome.permissions.Permissions = {
  permissions: ['identity'],
  origins: ['https://www.googleapis.com/*'],
};

export async function hasDrivePermissions(): Promise<boolean> {
  return await chrome.permissions.contains(DRIVE_PERMISSIONS);
}

/** Must be called from a page during a user gesture — Chrome refuses this from a worker. */
export async function requestDrivePermissions(): Promise<boolean> {
  return await chrome.permissions.request(DRIVE_PERMISSIONS);
}

export async function dropDrivePermissions(): Promise<boolean> {
  return await chrome.permissions.remove(DRIVE_PERMISSIONS);
}

/** How long before a token's stated expiry we stop trusting it. One in-flight request's worth. */
const EXPIRY_MARGIN_MS = 60_000;

export interface DriveAuthOptions {
  /**
   * The OAuth client id, from the manifest.
   *
   * Read at construction rather than baked in, because a development build and a Store build have
   * different extension ids and therefore different clients (RELEASE §5).
   */
  readonly clientId?: string;
  /** The unlocked vault's cipher, for the refresh token. `null` while the vault is locked. */
  readonly cipher?: () => Promise<VaultCipher | null>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomBytes?: (count: number) => Bytes;
}

export interface TokenOptions {
  /** Allow a consent screen. False everywhere except the connect button (§13.2). */
  readonly interactive?: boolean;
}

export class DriveAuth {
  readonly #clientId: string;
  readonly #cipher: () => Promise<VaultCipher | null>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #randomBytes: (count: number) => Bytes;

  constructor(options: DriveAuthOptions = {}) {
    this.#clientId = options.clientId ?? manifestClientId();
    this.#cipher = options.cipher ?? (() => Promise.resolve(null));
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => Date.now());
    this.#randomBytes =
      options.randomBytes ?? ((count) => crypto.getRandomValues(new Uint8Array(count)));
  }

  /** Whether this build was given an OAuth client at all. False in a source build with no `.env`. */
  get configured(): boolean {
    return this.#clientId !== '';
  }

  /**
   * An access token, from the cache if it is still good.
   *
   * Non-interactive by default: every sync trigger passes through here, and a background probe that
   * could put a consent screen in front of someone is a background probe nobody would forgive.
   */
  async token(options: TokenOptions = {}): Promise<string> {
    const cached = await readAccessToken();
    if (cached !== null && cached.expiresAt - EXPIRY_MARGIN_MS > this.#now()) return cached.token;
    return await this.#acquire(options.interactive === true);
  }

  /**
   * This token was rejected. Forget it, so the next call gets a new one.
   *
   * Under `identity` that means telling Chrome as well — its own cache is the one that would
   * otherwise hand the same dead token back.
   */
  async invalidate(token: string): Promise<void> {
    await clearAccessToken();
    const record = await readDriveRecord();
    if (record.mode !== 'identity') return;
    const identity = chrome.identity as typeof chrome.identity | undefined;
    try {
      await identity?.removeCachedAuthToken({ token });
    } catch {
      // The namespace is gone because the permission was revoked mid-flight. There is nothing to
      // invalidate in that case, and the next `token()` will say so properly.
    }
  }

  /**
   * Hand the grant back to Google, and forget everything we hold.
   *
   * Best-effort by design: a revoke that fails because the network is down must not stop a
   * disconnect from completing locally. The user asked to stop using Drive; leaving them connected
   * because a request failed would be the wrong way round to be wrong.
   */
  async revoke(): Promise<void> {
    const cached = await readAccessToken();
    if (cached !== null) {
      try {
        await this.#fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(cached.token)}`, {
          method: 'POST',
        });
      } catch {
        // Offline, or the token had already expired. Either way it is not ours any more.
      }
      await this.invalidate(cached.token);
    }
    await clearAccessToken();
  }

  /* ---------------------------------------------------------------- acquisition */

  async #acquire(interactive: boolean): Promise<string> {
    if (!this.configured) {
      throw new AuthRequired('This build has no Google OAuth client configured.');
    }
    const record = await readDriveRecord();
    if (record.mode === 'web') return await this.#acquireWeb(interactive);

    try {
      return await this.#acquireIdentity(interactive);
    } catch (error) {
      // A profile that is not signed into Chrome cannot use `getAuthToken` at all — that is the
      // situation the PKCE flow exists for, and it is indistinguishable from a refusal until we
      // try. Only an interactive call may fall through: doing it in the background would open a
      // consent window nobody asked for.
      if (!interactive || error instanceof Offline) throw error;
      const token = await this.#acquireWeb(true);
      await patchDriveRecord({ mode: 'web' });
      return token;
    }
  }

  /** Chrome's own token service. Returns a bare token or `{ token }`, depending on the version. */
  async #acquireIdentity(interactive: boolean): Promise<string> {
    const identity = chrome.identity as typeof chrome.identity | undefined;
    if (identity === undefined) {
      throw new AuthRequired('The "identity" permission has not been granted.');
    }
    let result: unknown;
    try {
      result = await identity.getAuthToken({ interactive, scopes: [DRIVE_SCOPE] });
    } catch (cause) {
      throw new AuthRequired('Chrome would not issue a Drive token.', { cause });
    }
    const token =
      typeof result === 'string' ? result : ((result as { token?: unknown } | null)?.token ?? null);
    if (typeof token !== 'string' || token === '') {
      throw new AuthRequired('Chrome answered with no Drive token.');
    }
    // Chrome does not say how long its token is good for. An hour is Google's standard lifetime,
    // and being wrong costs one 401 and one retry, which is a path that has to work anyway.
    await writeAccessToken({ token, expiresAt: this.#now() + 3_600_000 });
    return token;
  }

  /** The PKCE route: refresh if we can, and only ask the user when we cannot. */
  async #acquireWeb(interactive: boolean): Promise<string> {
    const refreshed = await this.#refresh();
    if (refreshed !== null) return refreshed;
    if (!interactive) {
      throw new AuthRequired('Drive needs to be reconnected.');
    }
    return await this.#authorize();
  }

  async #refresh(): Promise<string | null> {
    const cipher = await this.#cipher();
    if (cipher === null) return null;
    const record = await readDriveRecord();
    const refreshToken = await openRefreshToken(cipher, record.refreshToken);
    if (refreshToken === null) return null;

    const body = new URLSearchParams({
      client_id: this.#clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    // Anything but a token back means Google no longer accepts this grant — the user revoked
    // access from their account page, or it aged out. Dropping it turns the next interactive call
    // into a clean re-consent instead of an error nobody can act on. {@link Offline} is deliberately
    // *not* caught: a refresh that failed because there is no network has a perfectly good token
    // behind it, and throwing it away would mean a consent screen every time a train enters a
    // tunnel.
    const response = await this.#postToken(body);
    if (response === null) {
      await patchDriveRecord({ refreshToken: null });
      return null;
    }
    return await this.#store(response, cipher);
  }

  /**
   * The consent screen.
   *
   * `access_type=offline` plus `prompt=consent` because a repeat authorization returns no refresh
   * token unless it is asked for explicitly — and a connection that works until the next browser
   * restart and then silently stops is worse than one that never worked.
   */
  async #authorize(): Promise<string> {
    const identity = chrome.identity as typeof chrome.identity | undefined;
    if (identity === undefined) {
      throw new AuthRequired('The "identity" permission has not been granted.');
    }
    const verifier = toBase64Url(this.#randomBytes(64));
    const challenge = toBase64Url(await sha256(utf8(verifier)));
    const redirectUri = identity.getRedirectURL();

    const url = `${AUTH_ENDPOINT}?${new URLSearchParams({
      client_id: this.#clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: DRIVE_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    }).toString()}`;

    let redirect: string | undefined;
    try {
      redirect = await identity.launchWebAuthFlow({ url, interactive: true });
    } catch (cause) {
      throw new AuthRequired('The Drive authorization window was closed.', { cause });
    }
    const code = codeFrom(redirect);
    if (code === null) throw new AuthRequired('Drive authorization did not return a code.');

    const response = await this.#postToken(
      new URLSearchParams({
        client_id: this.#clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    );
    if (response === null) throw new AuthRequired('Drive would not exchange the authorization code.');
    await patchDriveRecord({ mode: 'web' });
    return await this.#store(response, await this.#cipher());
  }

  /** POST to the token endpoint. `null` for a refusal; {@link Offline} for no network. */
  async #postToken(body: URLSearchParams): Promise<TokenResponse | null> {
    let response: Response;
    try {
      response = await this.#fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (cause) {
      throw new Offline('Could not reach the Google token endpoint.', { cause });
    }
    if (!response.ok) return null;
    const parsed = (await response.json()) as Partial<TokenResponse>;
    if (typeof parsed.access_token !== 'string' || parsed.access_token === '') return null;
    return {
      access_token: parsed.access_token,
      expires_in: typeof parsed.expires_in === 'number' ? parsed.expires_in : 3_600,
      ...(typeof parsed.refresh_token === 'string' ? { refresh_token: parsed.refresh_token } : {}),
    };
  }

  /**
   * Keep what came back.
   *
   * A refresh token that arrives while the vault is locked is **dropped rather than stored in the
   * clear**. It is a credential; there is no key to seal it with at that moment, and the fallback
   * of writing it plainly to `storage.local` is exactly the outcome §13.2 rules out.
   */
  async #store(response: TokenResponse, cipher: VaultCipher | null): Promise<string> {
    await writeAccessToken({
      token: response.access_token,
      expiresAt: this.#now() + response.expires_in * 1_000,
    });
    if (response.refresh_token !== undefined && cipher !== null) {
      await patchDriveRecord({ refreshToken: await sealRefreshToken(cipher, response.refresh_token) });
    }
    return response.access_token;
  }
}

interface TokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
}

/** The `code` from a redirect the auth flow ended on, or `null` if it carried an error instead. */
function codeFrom(redirect: string | undefined): string | null {
  if (redirect === undefined || redirect === '') return null;
  const at = redirect.indexOf('?');
  if (at < 0) return null;
  const params = new URLSearchParams(redirect.slice(at + 1));
  const code = params.get('code');
  return code === null || code === '' ? null : code;
}

/**
 * The client id the package was built with.
 *
 * From the manifest rather than a constant, because that is where it has to be anyway for
 * `getAuthToken` to work at all — one source, and a build with no OAuth client configured says so
 * honestly instead of failing at the first request with something cryptic.
 */
function manifestClientId(): string {
  const oauth2 = (chrome.runtime.getManifest() as { oauth2?: { client_id?: string } }).oauth2;
  return oauth2?.client_id ?? '';
}

/** The current mode, for the settings screen. */
export async function authMode(): Promise<AuthMode> {
  return (await readDriveRecord()).mode;
}
