/**
 * A second Chrome profile joining a vault that is already in sync — in two real browsers.
 *
 * Two independent persistent contexts, two `userDataDir`s, the same unpacked build. Playwright
 * cannot sign either of them into a Google account, so the one thing that is simulated is Chrome's
 * own replication: the contents of `chrome.storage.sync` are read out of the first profile and
 * written into the second, which is precisely what Chrome does between two profiles on one account
 * and nothing more. Everything on either side of that — the peek, the pull, the KDF, the unwrap,
 * the decrypt, the screens — is the real thing.
 *
 * Both contexts load the same `dist` directory, so Chrome derives the same extension id for both,
 * which is what makes their sync areas the same area in the first place.
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

import { extensionArgs } from './harness.js';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'not the password at all';
const CONFIRM_PHRASE = 'I understand';

const PAGES: readonly (readonly [string, string])[] = [
  ['https://adopt-e2e.invalid/risotto', 'Mushroom risotto, properly'],
  ['https://adopt-e2e.invalid/bread', 'Overnight bread'],
];

interface Profile {
  readonly context: BrowserContext;
  readonly dir: string;
  readonly extensionId: string;
}

const profiles: Profile[] = [];

async function launch(label: string): Promise<Profile> {
  const dir = await mkdtemp(join(tmpdir(), `vaultamark-e2e-${label}-`));
  const context = await chromium.launchPersistentContext(dir, {
    // See lock.spec.ts: the default headless build does not run extensions at all.
    channel: 'chromium',
    headless: true,
    args: extensionArgs(DIST),
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const profile = { context, dir, extensionId: new URL(worker.url()).host };
  profiles.push(profile);
  return profile;
}

async function popup(profile: Profile): Promise<Page> {
  const page = await profile.context.newPage();
  await page.goto(`chrome-extension://${profile.extensionId}/popup.html`);
  return page;
}

test.afterAll(async () => {
  for (const profile of profiles) {
    await profile.context.close();
    await rm(profile.dir, { recursive: true, force: true });
  }
});

test('a second profile joins the synced vault with the master password alone', async () => {
  test.setTimeout(120_000);

  /* --- profile one: a vault, some bookmarks, pushed to sync ---------------- */

  const one = await launch('profile-one');
  const first = await popup(one);
  await first.getByLabel('Master password').fill(PASSWORD);
  await first.getByLabel('Repeat the password').fill(PASSWORD);
  await first.getByLabel('Type the phrase to confirm').fill(CONFIRM_PHRASE);
  await first.getByRole('button', { name: 'Create vault' }).click();
  await expect(first.getByRole('button', { name: 'Add this page' })).toBeVisible();

  for (const [url, title] of PAGES) {
    await first.evaluate(
      ([u, t]) => chrome.runtime.sendMessage({ type: 'ADD_URL', url: u, title: t }),
      [url, title],
    );
  }
  await first.evaluate(() => chrome.runtime.sendMessage({ type: 'SYNC_NOW' }));

  const replicated = await first.evaluate(() => chrome.storage.sync.get(null));
  expect(Object.keys(replicated)).toContain('vm.s.meta');

  /* --- what Chrome would do between two signed-in profiles ----------------- */

  const two = await launch('profile-two');
  // The same extension id on both, which is what makes this one sync area rather than two.
  expect(two.extensionId).toBe(one.extensionId);

  const second = await popup(two);
  await second.evaluate((data) => chrome.storage.sync.set(data), replicated);

  /* --- profile two: offered the password, not the create form -------------- */

  await second.reload();
  await expect(second.getByText('There is already a synced vault')).toBeVisible();
  const join = second.getByRole('button', { name: 'Use this vault here' });
  await expect(join).toBeVisible();

  // A wrong password is refused and leaves the screen where it was — no half-joined vault.
  await second.getByLabel('Master password').fill(WRONG_PASSWORD);
  await join.click();
  await expect(second.getByRole('alert')).toBeVisible();
  await expect(join).toBeVisible();

  await second.getByLabel('Master password').fill(PASSWORD);
  await join.click();

  /* --- and it is the same vault -------------------------------------------- */

  await expect(second.getByRole('button', { name: 'Add this page' })).toBeVisible();
  for (const [, title] of PAGES) {
    await expect(second.locator('.vm-row-open').filter({ hasText: title })).toBeVisible();
  }

  /* --- joining pushed nothing back ----------------------------------------- */

  const afterJoin = await second.evaluate(() => chrome.storage.sync.get(null));
  expect(afterJoin['vm.s.meta']).toEqual(replicated['vm.s.meta']);

  await first.close();
  await second.close();
});
