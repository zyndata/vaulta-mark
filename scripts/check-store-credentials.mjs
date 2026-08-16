#!/usr/bin/env node
/**
 * Ask the Chrome Web Store who we are, without changing anything.
 *
 * The four `CWS_*` secrets are only ever exercised by a publish, so the first real test of them
 * would otherwise be the first upload — the moment you least want to discover that a refresh token
 * was minted while the consent screen was still in Testing, or that the Store API was never enabled
 * on the Cloud project. This performs the same two-step authentication a publish does and then
 * makes a **read**: `GET items/{id}`, which returns the item's upload state and nothing else.
 *
 * It cannot publish, cannot upload, and cannot modify the listing. That is the point — it is safe
 * to run at any time, including while a review is pending.
 *
 * Failures name the specific cause rather than the HTTP status. `invalid_grant` and
 * `invalid_client` send you to opposite halves of RELEASE §6, and a bare 400 sends you to neither.
 *
 * Nothing here prints a secret, and there is a test that says so — GitHub masks secrets in logs,
 * but a script that relies on the log renderer to keep a credential out of the transcript is one
 * refactor away from not doing that.
 *
 * Usage:  node scripts/check-store-credentials.mjs
 */

import { pathToFileURL } from 'node:url';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ITEM_URL = 'https://www.googleapis.com/chromewebstore/v1.1/items';

export const REQUIRED = [
  'CWS_EXTENSION_ID',
  'CWS_CLIENT_ID',
  'CWS_CLIENT_SECRET',
  'CWS_REFRESH_TOKEN',
];

/**
 * A refusal with the diagnosis already written.
 *
 * Thrown rather than exiting where it happens: calling `process.exit()` while `fetch` still holds a
 * socket trips a libuv assertion on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`) and the
 * process dies with **127** instead of the 1 it meant. Measured on the `invalid_grant` path before
 * this was written this way — a CI step would still have failed, but on a code that means
 * "command not found".
 */
export class StoreCredentialsError extends Error {
  /** @param {string[]} lines */
  constructor(lines) {
    super(lines[0]);
    this.name = 'StoreCredentialsError';
    this.lines = lines;
  }
}

/** @param {string[]} lines */
function refuse(lines) {
  throw new StoreCredentialsError(lines);
}

/**
 * Exchange the refresh token for an access token.
 *
 * @param {Record<string, string | undefined>} env
 * @param {typeof globalThis.fetch} fetchImpl
 * @returns {Promise<string>}
 */
async function accessToken(env, fetchImpl) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: String(env['CWS_CLIENT_ID']),
      client_secret: String(env['CWS_CLIENT_SECRET']),
      refresh_token: String(env['CWS_REFRESH_TOKEN']),
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));

  if (res.ok && body.access_token) return body.access_token;

  const hint =
    body.error === 'invalid_grant'
      ? [
          'CWS_REFRESH_TOKEN was refused. The usual causes, in order of likelihood:',
          '  - it was minted while the OAuth consent screen was still in Testing, in which case',
          '    Google expires it after 7 days whatever the screen says now;',
          '  - the Google account revoked it, or its password changed;',
          '  - it belongs to a different client than CWS_CLIENT_ID.',
          'Regenerate it per RELEASE section 6.4, after confirming the consent screen is published.',
        ]
      : body.error === 'invalid_client'
        ? ['CWS_CLIENT_ID or CWS_CLIENT_SECRET is wrong, or the two are from different clients.']
        : ['Unexpected failure at the token endpoint.'];

  refuse([`Token exchange failed: HTTP ${res.status} ${body.error ?? ''}`.trim(), ...hint]);
  throw new Error('unreachable');
}

/**
 * Authenticate, then read the item. Returns what the Store said about it.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ fetch?: typeof globalThis.fetch }} [deps]
 * @returns {Promise<{ id: string, uploadState: string, crxVersion: string | null }>}
 */
export async function checkStoreCredentials(env, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    refuse([
      `Missing: ${missing.join(', ')}.`,
      'These are environment secrets on the chrome-web-store environment (RELEASE section 6.5).',
      'A job that does not declare that environment cannot see them, which reads identically to',
      'a secret that was never set.',
    ]);
  }

  const token = await accessToken(env, fetchImpl);

  const id = String(env['CWS_EXTENSION_ID']);
  const res = await fetchImpl(`${ITEM_URL}/${encodeURIComponent(id)}?projection=DRAFT`, {
    headers: { authorization: `Bearer ${token}`, 'x-goog-api-version': '2' },
  });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const reason = body.error?.message ?? JSON.stringify(body);
    const hint =
      res.status === 404
        ? [
            `No item ${id} is visible to this account.`,
            'Either CWS_EXTENSION_ID is wrong, or the Google account behind CWS_REFRESH_TOKEN does',
            'not own the Store item. Those are two different accounts more often than you would',
            'expect, because the publisher client is authorised interactively, by hand.',
          ]
        : res.status === 403
          ? [
              'Forbidden. Most often the Chrome Web Store API is not enabled on the Cloud project',
              '(RELEASE section 6.2) — enabling it is a separate step from creating the client.',
            ]
          : ['Unexpected failure reading the item.'];
    refuse([`Item read failed: HTTP ${res.status} — ${reason}`, ...hint]);
  }

  return {
    id: body.id ?? id,
    uploadState: body.uploadState ?? '(none)',
    crxVersion: body.crxVersion ?? null,
  };
}

async function main() {
  try {
    const item = await checkStoreCredentials(process.env);
    console.log('Authenticated. The refresh token is live and the client accepted it.');
    console.log(`Item ${item.id} is readable.`);
    console.log(`  uploadState: ${item.uploadState}`);
    console.log(`  crxVersion:  ${item.crxVersion ?? '(nothing uploaded yet)'}`);
    console.log('');
    console.log('All four secrets work together. Nothing was uploaded or changed.');
  } catch (error) {
    const lines =
      error instanceof StoreCredentialsError
        ? error.lines
        : [error instanceof Error ? error.message : String(error)];
    for (const line of lines) console.error(line);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
