/**
 * A thin Drive v3 client — the six calls VaultaMark makes, and the retry policy around them
 * (ARCHITECTURE §13.4, §13.6).
 *
 * It is not a general Drive library and should not become one. Every method here exists because
 * `DriveSyncProvider` needs it, and the surface being this small is what makes "the only thing this
 * extension can do to your Drive is manage its own file" checkable by reading one file.
 *
 * Three behaviours are load-bearing:
 *
 * - **`fields=` on every read.** A metadata request that does not name its fields comes back with
 *   Drive's default projection, and a freshness probe that downloads more than four values is a
 *   freshness probe that costs what a download costs. §13.4's whole point is that `peek()` is
 *   ~300 bytes.
 * - **Backoff with full jitter, honouring `Retry-After`.** On `403 rateLimitExceeded` /
 *   `userRateLimitExceeded` and on every `5xx`. Base 1 s, cap 60 s, six attempts. Full jitter
 *   rather than a fixed schedule because the failure mode being defended against is *every device
 *   retrying in lockstep*.
 * - **A failed `fetch` is {@link Offline}, not an error.** `fetch` rejects with a `TypeError` for
 *   a dropped connection, a DNS failure and a blocked request alike; none of them is something the
 *   user did, and all of them resolve themselves.
 */

import type { Bytes } from '../../crypto/codec.js';
import {
  AuthRequired,
  CorruptRemote,
  Offline,
  PreconditionFailed,
  QuotaExceeded,
  RateLimited,
  SyncError,
} from '../provider.js';
import type { DriveAuth } from './auth.js';

const FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';
const ABOUT_ENDPOINT = 'https://www.googleapis.com/drive/v3/about';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** §13.6. Base 1 s, cap 60 s, six attempts. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;
export const MAX_ATTEMPTS = 6;

/** The metadata projection every read asks for. Four values, ~300 bytes (§13.4). */
export const STAMP_FIELDS = 'id,modifiedTime,version,md5Checksum,appProperties,webViewLink';

export interface DriveFile {
  readonly id: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly modifiedTime?: string;
  readonly version?: string;
  readonly md5Checksum?: string;
  readonly appProperties?: Readonly<Record<string, string>>;
  readonly webViewLink?: string;
  /** Not part of the resource: the `ETag` response header, when Drive sent one. */
  readonly etag?: string;
}

export interface DriveApiOptions {
  readonly auth: DriveAuth;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Injected so tests do not spend a minute proving the backoff waits a minute. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface UploadRequest {
  readonly name?: string;
  readonly parents?: readonly string[];
  readonly mimeType?: string;
  readonly appProperties?: Readonly<Record<string, string>>;
  /** Absent for a metadata-only write. */
  readonly media?: Bytes;
  /** Sent as `If-Match` when present. Drive answers `412` if the file moved on (§13.5). */
  readonly etag?: string;
}

export class DriveApi {
  readonly #auth: DriveAuth;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options: DriveApiOptions) {
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
  }

  /** The signed-in account. `drive.file` is enough for `about.get` with a `user` projection. */
  async account(): Promise<string | null> {
    const about = (await this.#json(
      `${ABOUT_ENDPOINT}?fields=user(emailAddress)`,
      { method: 'GET' },
    )) as { user?: { emailAddress?: string } };
    return about.user?.emailAddress ?? null;
  }

  async storage(): Promise<{ usedBytes: number; quotaBytes: number }> {
    const about = (await this.#json(`${ABOUT_ENDPOINT}?fields=storageQuota`, { method: 'GET' })) as {
      storageQuota?: { usage?: string; limit?: string };
    };
    return {
      usedBytes: Number(about.storageQuota?.usage ?? 0),
      // A Workspace account with pooled storage reports no limit at all. `0` is how the provider
      // says "there is no ceiling to draw a bar against", which is honest and rare.
      quotaBytes: Number(about.storageQuota?.limit ?? 0),
    };
  }

  /**
   * Files matching a Drive query, newest first.
   *
   * Under `drive.file` this can only ever return files this extension created, which is why looking
   * one up by name is safe: there is no other `vaultamark-vault.vmv` in scope to find.
   */
  async list(query: string): Promise<DriveFile[]> {
    const url =
      `${FILES_ENDPOINT}?q=${encodeURIComponent(query)}` +
      `&fields=${encodeURIComponent(`files(${STAMP_FIELDS})`)}` +
      '&orderBy=modifiedTime desc&pageSize=10&spaces=drive';
    const page = (await this.#json(url, { method: 'GET' })) as { files?: DriveFile[] };
    return page.files ?? [];
  }

  /** One file's metadata, and nothing else. This is what makes `peek()` cheap. */
  async metadata(fileId: string, fields: string = STAMP_FIELDS): Promise<DriveFile | null> {
    try {
      return await this.#file(
        `${FILES_ENDPOINT}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}`,
        { method: 'GET' },
      );
    } catch (error) {
      // §13.6: a 404 on the vault file means "no remote yet", not a failure. The user may have
      // deleted it from Drive, which is their file and their right.
      if (error instanceof NotFound) return null;
      throw error;
    }
  }

  async createFolder(name: string, parentId?: string): Promise<DriveFile> {
    return await this.upload(null, {
      name,
      mimeType: FOLDER_MIME,
      ...(parentId === undefined ? {} : { parents: [parentId] }),
    });
  }

  /**
   * Create or replace a file, metadata and contents in one request.
   *
   * One request rather than two is not an optimization: §13.5 requires `appProperties.vmRev` to be
   * written *in the same request as the media*, or a crash between them leaves a file whose
   * declared revision and whose contents disagree — which every other device would then believe.
   */
  async upload(fileId: string | null, request: UploadRequest): Promise<DriveFile> {
    const metadata: Record<string, unknown> = {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.mimeType === undefined ? {} : { mimeType: request.mimeType }),
      ...(request.appProperties === undefined ? {} : { appProperties: request.appProperties }),
      // Drive refuses `parents` on an update; a file is moved with `addParents` instead, which we
      // never need because we only ever create in the right place.
      ...(request.parents === undefined || fileId !== null ? {} : { parents: [...request.parents] }),
    };

    const query = `?fields=${encodeURIComponent(STAMP_FIELDS)}`;
    const headers: Record<string, string> = {};
    if (request.etag !== undefined) headers['If-Match'] = request.etag;

    if (request.media === undefined) {
      const url = fileId === null ? `${FILES_ENDPOINT}${query}` : `${FILES_ENDPOINT}/${encodeURIComponent(fileId)}${query}`;
      return await this.#file(url, {
        method: fileId === null ? 'POST' : 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      });
    }

    const boundary = `vmb${Math.floor(this.#random() * 1e12).toString(36)}`;
    const body = multipart(boundary, metadata, request.media);
    const url =
      (fileId === null
        ? `${UPLOAD_ENDPOINT}${query}`
        : `${UPLOAD_ENDPOINT}/${encodeURIComponent(fileId)}${query}`) + '&uploadType=multipart';
    return await this.#file(url, {
      method: fileId === null ? 'POST' : 'PATCH',
      headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  /** The payload. The only call in this file that moves more than a few hundred bytes. */
  async download(fileId: string): Promise<Bytes | null> {
    try {
      const response = await this.#request(
        `${FILES_ENDPOINT}/${encodeURIComponent(fileId)}?alt=media`,
        { method: 'GET' },
      );
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof NotFound) return null;
      throw error;
    }
  }

  async remove(fileId: string): Promise<void> {
    try {
      await this.#request(`${FILES_ENDPOINT}/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    } catch (error) {
      // Already gone is the outcome we wanted.
      if (!(error instanceof NotFound)) throw error;
    }
  }

  /* ---------------------------------------------------------------- transport */

  async #json(url: string, init: RequestInit): Promise<unknown> {
    return (await this.#read(url, init)).body;
  }

  /**
   * A file resource, with its `ETag` header folded in.
   *
   * Drive v3 dropped `etag` from the resource itself but still answers with the header, and it is
   * the only precondition token the API offers — so it is carried on the object rather than being
   * thrown away with the response, and `pushLight` sends it back as `If-Match` (§13.5).
   */
  async #file(url: string, init: RequestInit): Promise<DriveFile> {
    const { body, response } = await this.#read(url, init);
    const etag = response.headers.get('ETag');
    return { ...(body as DriveFile), ...(etag === null ? {} : { etag }) };
  }

  async #read(url: string, init: RequestInit): Promise<{ body: unknown; response: Response }> {
    const response = await this.#request(url, init);
    if (response.status === 204) return { body: {}, response };
    try {
      return { body: await response.json(), response };
    } catch (cause) {
      throw new CorruptRemote('Drive answered with something that is not JSON.', { cause });
    }
  }

  /**
   * One request, with the token attached, retried according to §13.6.
   *
   * The `401` path is separate from the backoff loop on purpose: a rejected token is not congestion
   * and waiting does not help it. It gets exactly one refresh and one retry, and then it is an
   * {@link AuthRequired} the user can act on.
   */
  async #request(url: string, init: RequestInit): Promise<Response> {
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const token = await this.#auth.token();
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);

      let response: Response;
      try {
        response = await this.#fetch(url, { ...init, headers });
      } catch (cause) {
        throw new Offline('Could not reach Google Drive.', { cause });
      }

      if (response.ok) return response;

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        await this.#auth.invalidate(token);
        continue;
      }

      const failure = await describe(response);
      if (attempt + 1 < MAX_ATTEMPTS && retryable(response.status, failure.reason)) {
        await this.#sleep(this.#waitFor(attempt, response.headers.get('Retry-After')));
        continue;
      }
      throw toSyncError(response.status, failure);
    }
  }

  /**
   * How long to wait before the next attempt.
   *
   * `Retry-After` wins when the server sent one — it knows something we do not. Otherwise
   * exponential with **full** jitter: a uniform draw from `[0, min(cap, base·2^n)]`, so a hundred
   * devices that failed at the same instant do not come back at the same instant.
   */
  #waitFor(attempt: number, retryAfter: string | null): number {
    const stated = retryAfter === null ? Number.NaN : Number(retryAfter);
    if (Number.isFinite(stated) && stated >= 0) return Math.min(BACKOFF_CAP_MS, stated * 1_000);
    return Math.floor(this.#random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt));
  }
}

/** A 404, which several call sites treat as "not there yet" rather than as a failure. */
export class NotFound extends SyncError {}

interface Failure {
  readonly reason: string;
  readonly message: string;
}

async function describe(response: Response): Promise<Failure> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    };
    return {
      reason: body.error?.errors?.[0]?.reason ?? '',
      message: body.error?.message ?? response.statusText,
    };
  } catch {
    return { reason: '', message: response.statusText };
  }
}

const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
]);

function retryable(status: number, reason: string): boolean {
  if (status >= 500) return true;
  return status === 403 && RATE_LIMIT_REASONS.has(reason);
}

function toSyncError(status: number, failure: Failure): SyncError {
  if (status === 404) return new NotFound(failure.message);
  if (status === 412) return new PreconditionFailed(null, { cause: new Error(failure.message) });
  if (status === 401 || status === 403) {
    if (failure.reason === 'storageQuotaExceeded') return new QuotaExceeded(0, 0);
    if (RATE_LIMIT_REASONS.has(failure.reason)) return new RateLimited(BACKOFF_CAP_MS);
    return new AuthRequired(failure.message);
  }
  if (status === 429) return new RateLimited(BACKOFF_CAP_MS);
  if (status >= 500) return new RateLimited(BACKOFF_CAP_MS);
  return new CorruptRemote(`Drive refused the request: ${String(status)} ${failure.message}`);
}

/**
 * A `multipart/related` body: the metadata part, then the bytes.
 *
 * Assembled as a `Blob` rather than a string because the second part is binary — ciphertext put
 * through a string would be mangled by whatever encoding `fetch` chose, silently, and the damage
 * would only show up on the device that pulled it.
 */
function multipart(
  boundary: string,
  metadata: Record<string, unknown>,
  media: Bytes,
): Blob {
  return new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    media,
    `\r\n--${boundary}--\r\n`,
  ]);
}
