/**
 * INV-4, on the Drive side.
 *
 * The E2E suite asserts the other half — browse the whole vault with Drive off and **zero** network
 * requests are made (`popup.spec.ts`, `manager.spec.ts` route-intercept and assert an empty list).
 * What Playwright cannot do is the half where Drive is *on*: it has no Google account to sign into
 * and no OAuth client to sign in with. So this runs the whole Drive lifecycle against a mocked
 * `fetch` and asserts the property that matters — **every host contacted is one this repository has
 * written down** — against `build/url-allowlist.json` itself rather than against a copy of it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { utf8 } from '../../../../src/crypto/codec.js';
import { VaultRepository } from '../../../../src/storage/repo.js';
import { DriveApi } from '../../../../src/sync/drive/api.js';
import { DriveAuth } from '../../../../src/sync/drive/auth.js';
import { DriveSyncProvider } from '../../../../src/sync/drive/provider.js';
import { DriveMock } from '../../../mocks/drive.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../../mocks/chrome.js';

const ALLOWED: string[] = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../../build/url-allowlist.json', import.meta.url)), 'utf8'),
  ) as { allowed: string[] }
).allowed;

const PASSWORD = 'a reasonably long master password';

let mock: ChromeMock;
let drive: DriveMock;
let repo: VaultRepository;

function provider(): DriveSyncProvider {
  const auth = new DriveAuth({ clientId: 'test-client', fetch: drive.fetch });
  return new DriveSyncProvider({
    auth,
    api: new DriveApi({ auth, fetch: drive.fetch, sleep: () => Promise.resolve() }),
  });
}

beforeEach(async () => {
  mock = installChromeMock({ grantedPermissions: ['identity'] });
  drive = new DriveMock();
  repo = new VaultRepository();
  await repo.create(PASSWORD);
  await repo.apply([
    { kind: 'add', input: { type: 'bookmark', id: 'a', url: 'https://example.com/a', title: 'Alpha' } },
  ]);
  await repo.flush();
}, 30_000);

afterEach(() => {
  uninstallChromeMock();
});

/**
 * Connect, sync, store a thumbnail, read it back, and disconnect.
 *
 * Returns what was actually uploaded, before `deleteRemote` takes the files away — an assertion
 * about the contents of an empty file table would pass without proving anything.
 */
async function fullLifecycle(): Promise<string[]> {
  const subject = provider();
  await subject.auth.token({ interactive: true });
  await subject.init();
  await subject.peek();
  await subject.pushLight(await repo.sealSnapshot(repo.items(), 2), null);
  await subject.pullLight();
  await subject.putThumb('a', utf8('a thumbnail'));
  await subject.getThumb('a');
  await subject.deleteThumb('a');
  await subject.usage();
  const uploaded = [...drive.files.values()].map((file) => new TextDecoder().decode(file.content));
  await subject.deleteRemote();
  await subject.disconnect();
  return uploaded;
}

describe('every host the Drive path touches', () => {
  it('is on the allowlist this repository ships, under Chrome’s own token service', async () => {
    await fullLifecycle();

    expect(drive.hosts().length).toBeGreaterThan(0);
    for (const host of drive.hosts()) {
      expect(ALLOWED.some((prefix) => prefix.startsWith(`https://${host}/`))).toBe(true);
    }
  }, 30_000);

  it('is on the allowlist under the PKCE fallback too, which is the one that adds a host', async () => {
    // A profile not signed into Chrome: this is the only path that reaches the token endpoint, and
    // therefore the only reason `oauth2.googleapis.com` is on the list at all.
    mock.identity.token = null;
    await fullLifecycle();

    expect(drive.hosts()).toContain('oauth2.googleapis.com');
    for (const host of drive.hosts()) {
      expect(ALLOWED.some((prefix) => prefix.startsWith(`https://${host}/`))).toBe(true);
    }
  }, 30_000);

  it('never sends the vault anywhere but Drive, and never without a bearer token', async () => {
    await fullLifecycle();

    for (const request of drive.requests) {
      const host = new URL(request.url).host;
      // The two OAuth endpoints are the exception by definition: one is where a token comes from
      // and the other is where it is handed back.
      if (host !== 'www.googleapis.com') continue;
      expect(request.authorization, request.url).toMatch(/^Bearer /u);
    }
  }, 30_000);

  it('makes no request at all until something asks it to', () => {
    provider();
    expect(drive.requests).toEqual([]);
  });

  it('sends ciphertext, and nothing a bookmark says', async () => {
    const uploaded = await fullLifecycle();
    expect(uploaded.some((body) => body.includes('VAULTAMARK'))).toBe(true);
    for (const body of uploaded) {
      expect(body).not.toContain('example.com');
      expect(body).not.toContain('Alpha');
    }
  }, 30_000);
});
