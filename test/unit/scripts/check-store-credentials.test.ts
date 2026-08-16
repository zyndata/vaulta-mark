/**
 * The Chrome Web Store credentials pre-flight.
 *
 * What is worth testing here is not the happy path — that is three lines — but the *diagnoses*.
 * This script exists because the four `CWS_*` secrets were otherwise first exercised by an upload,
 * and it earns that only if a failure names the thing that is wrong: `invalid_grant` and
 * `invalid_client` send a reader to opposite halves of RELEASE §6, and a bare HTTP status sends
 * them to neither.
 *
 * The one non-obvious case is 404, which is *not* "the item does not exist" — it is also what a
 * correct item id looks like when the refresh token belongs to a different Google account, which
 * is easy to produce because the publisher client is authorised by hand.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  REQUIRED,
  StoreCredentialsError,
  checkStoreCredentials,
} from '../../../scripts/check-store-credentials.mjs';

const ENV = {
  CWS_EXTENSION_ID: 'nfcfgnaefnkpmoiagnamdacpohifncpl',
  CWS_CLIENT_ID: '000-publisher.apps.googleusercontent.com',
  CWS_CLIENT_SECRET: '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inted',
  CWS_REFRESH_TOKEN: '1//0-a-refresh-token-that-must-not-be-printed',
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A fetch that answers the token endpoint first and the item endpoint second. */
function fetchStub(token: Response, item?: Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return Promise.resolve(calls.length === 1 ? token : (item ?? response(200, {})));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const OK_TOKEN = response(200, { access_token: 'ya29.an-access-token' });

async function refusalFrom(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StoreCredentialsError);
    return (error as StoreCredentialsError).lines.join('\n');
  }
  throw new Error('expected a refusal, got none');
}

describe('checkStoreCredentials', () => {
  it('names every missing variable, and asks for none of them', async () => {
    const { fetch, calls } = fetchStub(OK_TOKEN);
    const text = await refusalFrom(checkStoreCredentials({}, { fetch }));

    for (const name of REQUIRED) expect(text).toContain(name);
    // Nothing is asked of Google before the inputs are known to exist: a request built from
    // `undefined` would come back `invalid_client` and send the reader hunting a real credential.
    expect(calls).toHaveLength(0);
  });

  it('names the one missing variable rather than all four', async () => {
    const { fetch } = fetchStub(OK_TOKEN);
    const rest: Partial<typeof ENV> = { ...ENV };
    delete rest.CWS_REFRESH_TOKEN;
    const text = await refusalFrom(checkStoreCredentials(rest, { fetch }));

    expect(text).toContain('Missing: CWS_REFRESH_TOKEN.');
    expect(text).not.toContain('CWS_CLIENT_ID,');
  });

  it('reads the item and reports its state', async () => {
    const { fetch, calls } = fetchStub(
      OK_TOKEN,
      response(200, { id: ENV.CWS_EXTENSION_ID, uploadState: 'SUCCESS', crxVersion: '1.0.0' }),
    );

    await expect(checkStoreCredentials(ENV, { fetch })).resolves.toStrictEqual({
      id: ENV.CWS_EXTENSION_ID,
      uploadState: 'SUCCESS',
      crxVersion: '1.0.0',
    });

    // A refresh-token grant, then a bearer read of that item. The API version header is not
    // optional: without it the Store answers on a different, older contract.
    const grant = calls[0]?.init?.body;
    expect(grant).toBeInstanceOf(URLSearchParams);
    expect((grant as URLSearchParams).toString()).toContain('grant_type=refresh_token');
    expect(calls[1]?.url).toContain(ENV.CWS_EXTENSION_ID);
    expect(calls[1]?.init?.headers).toMatchObject({
      authorization: 'Bearer ya29.an-access-token',
      'x-goog-api-version': '2',
    });
  });

  it('reports a vault that has never been uploaded as such, not as version null', async () => {
    const { fetch } = fetchStub(OK_TOKEN, response(200, { uploadState: 'NOT_FOUND' }));

    await expect(checkStoreCredentials(ENV, { fetch })).resolves.toMatchObject({
      id: ENV.CWS_EXTENSION_ID,
      crxVersion: null,
    });
  });

  it('blames the consent screen first when the refresh token is refused', async () => {
    const { fetch } = fetchStub(response(400, { error: 'invalid_grant' }));
    const text = await refusalFrom(checkStoreCredentials(ENV, { fetch }));

    expect(text).toContain('CWS_REFRESH_TOKEN was refused');
    expect(text).toContain('Testing');
    expect(text).toContain('7 days');
    expect(text).not.toContain('CWS_CLIENT_SECRET is wrong');
  });

  it('blames the client pair, and not the token, on invalid_client', async () => {
    const { fetch } = fetchStub(response(401, { error: 'invalid_client' }));
    const text = await refusalFrom(checkStoreCredentials(ENV, { fetch }));

    expect(text).toContain('CWS_CLIENT_ID or CWS_CLIENT_SECRET is wrong');
    expect(text).not.toContain('Testing');
  });

  it('offers the wrong-account reading of a 404, not only a wrong id', async () => {
    const { fetch } = fetchStub(OK_TOKEN, response(404, { error: { message: 'No item found.' } }));
    const text = await refusalFrom(checkStoreCredentials(ENV, { fetch }));

    expect(text).toContain(ENV.CWS_EXTENSION_ID);
    expect(text).toContain('does');
    expect(text).toContain('not own the Store item');
  });

  it('points a 403 at the API that has to be enabled separately', async () => {
    const { fetch } = fetchStub(OK_TOKEN, response(403, { error: { message: 'Forbidden' } }));
    const text = await refusalFrom(checkStoreCredentials(ENV, { fetch }));

    expect(text).toContain('Chrome Web Store API is not enabled');
    expect(text).toContain('6.2');
  });

  /**
   * The whole point of the script is to be run in a job whose log is public on a public repository.
   * GitHub masks registered secrets, but a script that relies on the log renderer to keep a
   * credential out of the transcript is one refactor away from not doing that.
   */
  it('never puts a secret in a message, on any failure path', async () => {
    const failures = [
      fetchStub(response(400, { error: 'invalid_grant' })),
      fetchStub(response(401, { error: 'invalid_client' })),
      fetchStub(OK_TOKEN, response(404, { error: { message: 'No item found.' } })),
      fetchStub(OK_TOKEN, response(403, { error: { message: 'Forbidden' } })),
      fetchStub(OK_TOKEN, response(500, { error: { message: 'Backend error' } })),
    ];

    for (const { fetch } of failures) {
      const text = await refusalFrom(checkStoreCredentials(ENV, { fetch }));
      expect(text).not.toContain(ENV.CWS_CLIENT_SECRET);
      expect(text).not.toContain(ENV.CWS_REFRESH_TOKEN);
      expect(text).not.toContain('ya29.an-access-token');
    }
  });

  it('does not read the item when the token exchange failed', async () => {
    const { fetch, calls } = fetchStub(response(400, { error: 'invalid_grant' }));
    await refusalFrom(checkStoreCredentials(ENV, { fetch }));

    expect(calls).toHaveLength(1);
  });
});
