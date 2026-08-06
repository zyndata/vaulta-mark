/**
 * The Drive v3 client: what it sends, and what it does when Drive says no (§13.4, §13.6).
 *
 * `sleep` is injected and records rather than waits — a backoff test that actually waited would
 * spend a minute proving that it waits a minute, and the number it would be proving is the one this
 * asserts directly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { utf8, utf8Decode, type Bytes } from '../../../../src/crypto/codec.js';
import {
  BACKOFF_CAP_MS,
  DriveApi,
  MAX_ATTEMPTS,
  NotFound,
  STAMP_FIELDS,
} from '../../../../src/sync/drive/api.js';
import { DriveAuth } from '../../../../src/sync/drive/auth.js';
import {
  AuthRequired,
  Offline,
  PreconditionFailed,
  QuotaExceeded,
  RateLimited,
} from '../../../../src/sync/provider.js';
import { DriveMock } from '../../../mocks/drive.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../../mocks/chrome.js';

let chromeMock: ChromeMock;
let drive: DriveMock;
let waits: number[];

function api(options: { random?: () => number } = {}): DriveApi {
  return new DriveApi({
    auth: new DriveAuth({ clientId: 'test-client', fetch: drive.fetch }),
    fetch: drive.fetch,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    random: options.random ?? (() => 0.5),
  });
}

beforeEach(() => {
  drive = new DriveMock();
  waits = [];
  chromeMock = installChromeMock({ grantedPermissions: ['identity'] });
});

afterEach(() => {
  uninstallChromeMock();
});

describe('requests', () => {
  it('carries a bearer token on every call', async () => {
    await api().account();
    expect(drive.requests[0]?.authorization).toBe('Bearer chrome-identity-token');
  });

  it('reads the account from about.get, which drive.file is enough for', async () => {
    expect(await api().account()).toBe('someone@example.com');
    expect(drive.requests[0]?.url).toContain('fields=user(emailAddress)');
  });

  it('reads Drive’s own storage numbers', async () => {
    expect(await api().storage()).toEqual({ usedBytes: 4_000_000, quotaBytes: 15_000_000_000 });
  });

  it('creates a file with its metadata and its bytes in one request', async () => {
    const file = await api().upload(null, {
      name: 'vaultamark-vault.vmv',
      appProperties: { vmRev: '7' },
      media: utf8('hello'),
    });
    expect(file.appProperties?.['vmRev']).toBe('7');
    expect(utf8Decode(drive.files.get(file.id)?.content as Bytes)).toBe('hello');
    // One request, not two: §13.5 requires the revision and the bytes to land together, or a crash
    // between them leaves a file whose declared revision lies about its contents.
    expect(drive.requests.filter((request) => request.method !== 'GET')).toHaveLength(1);
  });

  it('round-trips binary media without mangling it', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 13, 10, 45, 45]);
    const file = await api().upload(null, { name: 't_x.vmt', media: bytes });
    expect([...(drive.files.get(file.id)?.content ?? [])]).toEqual([...bytes]);
  });

  it('names the fields it wants, so a metadata read stays a metadata read', async () => {
    const created = await api().upload(null, { name: 'x', media: utf8('body') });
    drive.requests.length = 0;
    const meta = await api().metadata(created.id);
    expect(drive.requests[0]?.url).toContain(encodeURIComponent(STAMP_FIELDS));
    expect(meta?.md5Checksum).toBeDefined();
    expect((meta as unknown as { size?: string }).size).toBeUndefined();
  });

  it('answers null for a file that is not there', async () => {
    expect(await api().metadata('missing')).toBeNull();
    expect(await api().download('missing')).toBeNull();
  });

  it('swallows a delete of something already gone', async () => {
    await expect(api().remove('missing')).resolves.toBeUndefined();
  });

  it('escapes nothing it does not have to, and finds by name', async () => {
    const created = await api().upload(null, { name: 'vaultamark-vault.vmv', media: utf8('x') });
    const found = await api().list("name = 'vaultamark-vault.vmv' and trashed = false");
    expect(found.map((file) => file.id)).toEqual([created.id]);
  });
});

describe('failures', () => {
  it('refreshes once on a 401 and retries, rather than failing', async () => {
    drive.fail({ status: 401 });
    expect(await api().account()).toBe('someone@example.com');
    expect(chromeMock.identity.removedTokens).toEqual(['chrome-identity-token']);
  });

  it('gives up on a second 401 rather than looping', async () => {
    drive.fail({ status: 401, times: 2 });
    await expect(api().account()).rejects.toBeInstanceOf(AuthRequired);
  });

  it('backs off on a rate limit and succeeds on the retry', async () => {
    drive.fail({ status: 403, reason: 'userRateLimitExceeded' });
    expect(await api().account()).toBe('someone@example.com');
    expect(waits).toHaveLength(1);
  });

  it('honours Retry-After over its own schedule', async () => {
    drive.fail({ status: 503, retryAfter: '17' });
    await api().account();
    expect(waits).toEqual([17_000]);
  });

  it('grows the wait exponentially, with full jitter', async () => {
    drive.fail({ status: 500, times: 3 });
    await api({ random: () => 1 }).account();
    expect(waits).toEqual([1_000, 2_000, 4_000]);
  });

  it('caps the wait at a minute', async () => {
    drive.fail({ status: 500, retryAfter: '9999' });
    await api().account();
    expect(waits).toEqual([BACKOFF_CAP_MS]);
  });

  it('stops after six attempts', async () => {
    drive.fail({ status: 500, times: MAX_ATTEMPTS });
    await expect(api().account()).rejects.toBeInstanceOf(RateLimited);
    expect(waits).toHaveLength(MAX_ATTEMPTS - 1);
  });

  it('does not retry a 403 that is a refusal rather than congestion', async () => {
    drive.fail({ status: 403, reason: 'insufficientFilePermissions' });
    await expect(api().account()).rejects.toBeInstanceOf(AuthRequired);
    expect(waits).toEqual([]);
  });

  it('reports a full Drive as a quota failure', async () => {
    drive.fail({ status: 403, reason: 'storageQuotaExceeded' });
    await expect(api().account()).rejects.toBeInstanceOf(QuotaExceeded);
  });

  it('reports a 412 as a precondition failure, which is what re-enters the merge', async () => {
    const created = await api().upload(null, { name: 'x', media: utf8('one') });
    await expect(
      api().upload(created.id, { media: utf8('two'), etag: '"not-the-current-one"' }),
    ).rejects.toBeInstanceOf(PreconditionFailed);
  });

  it('accepts an If-Match that still matches', async () => {
    const created = await api().upload(null, { name: 'x', media: utf8('one') });
    const meta = await api().metadata(created.id);
    await api().upload(created.id, {
      media: utf8('two'),
      ...(meta?.etag === undefined ? {} : { etag: meta.etag }),
    });
    expect(utf8Decode(drive.files.get(created.id)?.content as Bytes)).toBe('two');
  });

  it('reports a dead network as Offline', async () => {
    const offline = new DriveApi({
      auth: new DriveAuth({ clientId: 'test-client', fetch: drive.fetch }),
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(offline.account()).rejects.toBeInstanceOf(Offline);
  });

  it('reports a 404 as its own thing, so callers can treat it as "not yet"', async () => {
    await expect(api().upload('missing', { media: utf8('x') })).rejects.toBeInstanceOf(NotFound);
  });
});
