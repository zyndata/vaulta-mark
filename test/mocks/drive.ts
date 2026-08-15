/**
 * A Google Drive that runs inside the test process.
 *
 * `fetch` is the only thing the Drive path touches that is not ours, so this is the whole seam: it
 * implements the six calls `src/sync/drive/api.ts` makes, plus the OAuth token and revoke
 * endpoints, and keeps a file table you can inspect and corrupt.
 *
 * It reproduces the behaviours the code is written against rather than the whole API:
 *
 * - **`fields=` is honoured.** A metadata read that forgets it comes back with the default
 *   projection, which is how the "peek must not download the payload" test can be a real
 *   assertion rather than a comment.
 * - **`appProperties` round-trip**, because the revision lives there and nowhere else.
 * - **`If-Match` answers `412`**, so the compare-and-swap path is exercised.
 * - **A checksum that changes with the contents.** Not MD5 — a 32-bit FNV-1a in hex. Nothing in
 *   VaultaMark computes an MD5 to compare against; the field is only ever used as "did this
 *   change?", and implementing a real MD5 in a mock would be a hundred lines proving nothing.
 * - **`hosts()`**, which is what the INV-4 assertions are written against.
 */

export interface MockDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  content: Uint8Array;
  modifiedTime: string;
  version: number;
  trashed: boolean;
}

export interface MockDriveRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

export interface DriveMockOptions {
  /** The account `about.get` reports. */
  readonly email?: string;
  readonly usedBytes?: number;
  readonly quotaBytes?: number;
  readonly now?: () => number;
}

/** A canned failure to serve instead of the next matching request. */
export interface QueuedFailure {
  readonly status: number;
  readonly reason?: string;
  readonly retryAfter?: string;
  /** How many requests this failure applies to. Defaults to one. */
  readonly times?: number;
}

export class DriveMock {
  readonly files = new Map<string, MockDriveFile>();
  readonly requests: MockDriveRequest[] = [];
  /** Access tokens the mock considers valid. Anything else gets a `401`. */
  readonly validTokens = new Set<string>(['chrome-identity-token', 'web-access-token']);
  readonly issuedRefreshTokens: string[] = [];
  /** Tokens passed to the revoke endpoint, in order. */
  readonly revoked: string[] = [];
  /** Refresh tokens the token endpoint will refuse — a grant the user withdrew. */
  readonly rejectedRefreshTokens = new Set<string>();
  /**
   * One-shot: the next upload lands half transmitted and then the connection drops.
   *
   * The metadata part of a `multipart/related` body goes first and the media second, so what
   * survives is the new `appProperties` over half the bytes — and the client never learns whether
   * it succeeded. It is the closest thing Drive has to the torn push `storage.sync` can produce.
   */
  truncateNextUpload = false;

  #failures: QueuedFailure[] = [];
  #nextId = 1;
  readonly #email: string;
  readonly #usedBytes: number;
  readonly #quotaBytes: number;
  readonly #now: () => number;

  constructor(options: DriveMockOptions = {}) {
    this.#email = options.email ?? 'someone@example.com';
    this.#usedBytes = options.usedBytes ?? 4_000_000;
    this.#quotaBytes = options.quotaBytes ?? 15_000_000_000;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Serve a failure instead of the next request (or `times` of them). */
  fail(failure: QueuedFailure): void {
    this.#failures.push(failure);
  }

  /** Every host this mock was asked to talk to, deduplicated. The INV-4 assertion. */
  hosts(): string[] {
    return [...new Set(this.requests.map((request) => new URL(request.url).host))].sort();
  }

  /** The vault file, if one has been created. */
  vaultFile(): MockDriveFile | undefined {
    return [...this.files.values()].find((file) => file.name === 'vaultamark-vault.vmv');
  }

  byName(name: string): MockDriveFile | undefined {
    return [...this.files.values()].find((file) => file.name === name && !file.trashed);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    this.requests.push({ method, url, authorization: headers.get('Authorization') });

    const failure = this.#takeFailure();
    if (failure !== undefined) {
      return json(
        { error: { message: 'injected', errors: [{ reason: failure.reason ?? 'backendError' }] } },
        failure.status,
        failure.retryAfter === undefined ? {} : { 'Retry-After': failure.retryAfter },
      );
    }

    const parsed = new URL(url);
    if (parsed.host === 'oauth2.googleapis.com') return this.#token(init);
    if (parsed.host === 'accounts.google.com') return this.#revoke(parsed);

    const token = headers.get('Authorization')?.replace(/^Bearer /u, '') ?? '';
    if (!this.validTokens.has(token)) {
      return json({ error: { message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }, 401);
    }

    if (parsed.pathname === '/drive/v3/about') return this.#about(parsed);
    if (parsed.pathname.startsWith('/upload/drive/v3/files')) {
      return await this.#upload(parsed, init, headers);
    }
    if (parsed.pathname === '/drive/v3/files') {
      return method === 'GET' ? this.#list(parsed) : await this.#upload(parsed, init, headers);
    }
    if (parsed.pathname.startsWith('/drive/v3/files/')) {
      const id = decodeURIComponent(parsed.pathname.slice('/drive/v3/files/'.length));
      if (method === 'DELETE') return this.#delete(id);
      if (method === 'GET') return this.#get(parsed, id);
      return await this.#upload(parsed, init, headers);
    }
    return json({ error: { message: 'Not Found', errors: [{ reason: 'notFound' }] } }, 404);
  };

  /* ---------------------------------------------------------------- endpoints */

  #token(init: RequestInit | undefined): Response {
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const grant = body.get('grant_type');
    if (grant === 'refresh_token') {
      const refresh = body.get('refresh_token') ?? '';
      if (this.rejectedRefreshTokens.has(refresh)) {
        return json({ error: 'invalid_grant' }, 400);
      }
      this.validTokens.add('web-access-token');
      return json({ access_token: 'web-access-token', expires_in: 3600 });
    }
    if (grant === 'authorization_code') {
      if (body.get('code_verifier') === null || body.get('code') === null) {
        return json({ error: 'invalid_request' }, 400);
      }
      this.issuedRefreshTokens.push('web-refresh-token');
      this.validTokens.add('web-access-token');
      return json({
        access_token: 'web-access-token',
        expires_in: 3600,
        refresh_token: 'web-refresh-token',
      });
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }

  #revoke(parsed: URL): Response {
    const token = parsed.searchParams.get('token');
    if (token !== null) {
      this.revoked.push(token);
      this.validTokens.delete(token);
    }
    return json({});
  }

  #about(parsed: URL): Response {
    const fields = parsed.searchParams.get('fields') ?? '';
    const body: Record<string, unknown> = {};
    if (fields.includes('user')) body['user'] = { emailAddress: this.#email };
    if (fields.includes('storageQuota')) {
      body['storageQuota'] = { usage: String(this.#usedBytes), limit: String(this.#quotaBytes) };
    }
    return json(body);
  }

  /**
   * `files.list`, understanding only the query shapes the provider builds: `name = '…'`,
   * `mimeType = '…'`, `'<id>' in parents`, and `trashed = false`.
   */
  #list(parsed: URL): Response {
    const query = parsed.searchParams.get('q') ?? '';
    const name = /name = '((?:[^'\\]|\\.)*)'/u.exec(query)?.[1];
    const mime = /mimeType = '([^']*)'/u.exec(query)?.[1];
    const parent = /'([^']*)' in parents/u.exec(query)?.[1];

    const matches = [...this.files.values()].filter((file) => {
      if (file.trashed) return false;
      if (name !== undefined && file.name !== unescapeQuery(name)) return false;
      if (mime !== undefined && file.mimeType !== mime) return false;
      if (parent !== undefined && !file.parents.includes(parent)) return false;
      return true;
    });
    matches.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
    return json({ files: matches.map((file) => project(file, parsed)) });
  }

  #get(parsed: URL, id: string): Response {
    const file = this.files.get(id);
    if (file === undefined || file.trashed) {
      return json({ error: { message: 'File not found', errors: [{ reason: 'notFound' }] } }, 404);
    }
    if (parsed.searchParams.get('alt') === 'media') {
      return new Response(file.content.slice().buffer, { status: 200 });
    }
    return json(project(file, parsed), 200, { ETag: etagOf(file) });
  }

  /**
   * `files.delete`, **including everything inside a folder**.
   *
   * Drive deletes a folder's contents with it, and a mock that left them behind is not merely
   * imprecise — it produces a state Drive cannot be in, where a file's parent does not exist. That
   * matters here because the provider falls back to searching for `vaultamark-vault.vmv` by name
   * with no parent when it has no cached folder: an orphan left by a "deleted" folder is found by
   * that search, and a caller that had just cleared the folder gets a `PreconditionFailed` for a
   * file the real Drive would have taken away.
   */
  #delete(id: string): Response {
    if (!this.files.delete(id)) {
      return json({ error: { message: 'File not found', errors: [{ reason: 'notFound' }] } }, 404);
    }
    for (const child of [...this.files.values()]) {
      if (child.parents.includes(id)) this.#delete(child.id);
    }
    return new Response(null, { status: 204 });
  }

  async #upload(parsed: URL, init: RequestInit | undefined, headers: Headers): Promise<Response> {
    const path = parsed.pathname;
    const marker = '/files/';
    const at = path.indexOf(marker);
    const id = at < 0 ? null : decodeURIComponent(path.slice(at + marker.length));

    let metadata: Record<string, unknown>;
    let content: Uint8Array | null = null;

    if (parsed.searchParams.get('uploadType') === 'multipart') {
      const parts = await splitMultipart(headers, init?.body);
      metadata = JSON.parse(parts.metadata) as Record<string, unknown>;
      content = parts.media;
    } else {
      metadata = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    }

    const truncate = this.truncateNextUpload;
    this.truncateNextUpload = false;
    if (truncate && content !== null) content = content.slice(0, Math.floor(content.length / 2));

    if (id === null) {
      const file: MockDriveFile = {
        id: `file-${String(this.#nextId++)}`,
        name: text(metadata['name']) ?? 'untitled',
        mimeType: text(metadata['mimeType']) ?? 'application/octet-stream',
        parents: (metadata['parents'] as string[] | undefined) ?? [],
        appProperties: (metadata['appProperties'] as Record<string, string> | undefined) ?? {},
        content: content ?? new Uint8Array(),
        modifiedTime: new Date(this.#now()).toISOString(),
        version: 1,
        trashed: false,
      };
      this.files.set(file.id, file);
      if (truncate) throw new TypeError('the connection dropped mid-upload');
      return json(project(file, parsed), 200, { ETag: etagOf(file) });
    }

    const existing = this.files.get(id);
    if (existing === undefined) {
      return json({ error: { message: 'File not found', errors: [{ reason: 'notFound' }] } }, 404);
    }
    const ifMatch = headers.get('If-Match');
    if (ifMatch !== null && ifMatch !== etagOf(existing)) {
      return json({ error: { message: 'Precondition Failed', errors: [{ reason: 'conditionNotMet' }] } }, 412);
    }
    if (metadata['appProperties'] !== undefined) {
      existing.appProperties = metadata['appProperties'] as Record<string, string>;
    }
    const renamed = text(metadata['name']);
    if (renamed !== null) existing.name = renamed;
    if (content !== null) existing.content = content;
    existing.version += 1;
    existing.modifiedTime = new Date(this.#now()).toISOString();
    if (truncate) throw new TypeError('the connection dropped mid-upload');
    return json(project(existing, parsed), 200, { ETag: etagOf(existing) });
  }

  #takeFailure(): QueuedFailure | undefined {
    const next = this.#failures[0];
    if (next === undefined) return undefined;
    const remaining = (next.times ?? 1) - 1;
    if (remaining <= 0) this.#failures.shift();
    else this.#failures[0] = { ...next, times: remaining };
    return next;
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Only the fields the request asked for.
 *
 * The point of the whole exercise: a `peek()` that forgot `fields=` would get `content` here, and
 * the test that asserts a probe downloads nothing would pass anyway.
 */
function project(file: MockDriveFile, parsed: URL): Record<string, unknown> {
  const raw = parsed.searchParams.get('fields');
  const wanted =
    raw === null
      ? null
      : new Set(
          raw
            .replace(/^files\(|\)$/gu, '')
            .split(',')
            .map((field) => field.trim()),
        );
  const full: Record<string, unknown> = {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    parents: file.parents,
    appProperties: file.appProperties,
    modifiedTime: file.modifiedTime,
    version: String(file.version),
    md5Checksum: checksum(file.content),
    webViewLink: `https://drive.google.com/file/d/${file.id}/view`,
    size: String(file.content.length),
  };
  if (wanted === null) return full;
  return Object.fromEntries(Object.entries(full).filter(([key]) => wanted.has(key)));
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function etagOf(file: MockDriveFile): string {
  return `"${String(file.version)}"`;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** FNV-1a, hex. A content-dependent checksum, which is the only property anything relies on. */
function checksum(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function unescapeQuery(value: string): string {
  return value.replace(/\\(.)/gu, '$1');
}

/**
 * Split a `multipart/related` body back into its metadata and its bytes.
 *
 * Byte-wise rather than by decoding the body as text: the media part is arbitrary binary (a
 * thumbnail, in Phase 11), and a mock that round-tripped it through a string would mangle it in
 * exactly the way a bug in the real client would — and hide it.
 */
async function splitMultipart(
  headers: Headers,
  body: BodyInit | null | undefined,
): Promise<{ metadata: string; media: Uint8Array }> {
  const boundary = /boundary=([^;]+)/u.exec(headers.get('Content-Type') ?? '')?.[1];
  if (boundary === undefined) throw new Error('multipart body with no boundary');
  const bytes = new Uint8Array(await new Blob([body as BlobPart]).arrayBuffer());

  const delimiter = new TextEncoder().encode(`\r\n--${boundary}`);
  const first = indexOfBytes(bytes, delimiter, 0);
  const second = indexOfBytes(bytes, delimiter, first + 1);
  if (first < 0 || second < 0) throw new Error('malformed multipart body');

  const decoder = new TextDecoder();
  const metaStart = bodyStart(bytes, 0);
  const mediaStart = bodyStart(bytes, first + delimiter.length);
  return {
    metadata: decoder.decode(bytes.subarray(metaStart, first)),
    media: bytes.slice(mediaStart, second),
  };
}

/** The offset just past the blank line that ends a part's headers. */
function bodyStart(bytes: Uint8Array, from: number): number {
  const blank = new TextEncoder().encode('\r\n\r\n');
  const at = indexOfBytes(bytes, blank, from);
  return at < 0 ? from : at + blank.length;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let at = Math.max(0, from); at <= haystack.length - needle.length; at++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[at + offset] !== needle[offset]) continue outer;
    }
    return at;
  }
  return -1;
}
