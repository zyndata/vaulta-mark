/**
 * The Phase-9 first-run flow, in a real Chromium against the real built extension.
 *
 * PLAN §9's Definition of done: "a fresh install walks a user through incognito + no-recovery +
 * sync-tier without them being able to skip the no-recovery acknowledgement", and the test list asks
 * for "fresh profile → onboarding appears → complete it → it never appears again".
 *
 * Two harness facts shape this file:
 *
 * - **The install tab cannot be observed.** `chrome.runtime.onInstalled` fires while the persistent
 *   context is still starting, before Playwright has a page listener attached, and the tab it opens
 *   is gone from `context.pages()` by the time the fixture is ready. What *is* checkable — and is
 *   what actually matters — is that the URL it opens shows the flow, and that the same URL stops
 *   showing it once the flow is finished. Both are asserted below.
 * - **"Allow in Incognito" cannot be turned on.** It is a checkbox on `chrome://extensions` and no
 *   API reaches it, which is the entire reason step 3 exists. So the incognito gate is exercised
 *   through the answer a real user in this situation gives: "skip for now" — and the nudge it leaves
 *   in the manager is asserted afterwards.
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

const PASSWORD = 'correct horse battery staple';
const CONFIRM_PHRASE = 'I understand';

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

async function serviceWorker(): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  return existing ?? (await context.waitForEvent('serviceworker'));
}

async function openOnboarding(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manager.html?onboarding=1`);
  return page;
}

function next(page: Page) {
  return page.getByRole('button', { name: 'Next' });
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // `channel: 'chromium'`: the default headless build does not run extensions at all.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  const worker = await serviceWorker();
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
});

test('walks a fresh profile through setup, and then never appears again', async () => {
  const page = await openOnboarding();

  // ---------------------------------------------------------------- 1. what this is
  await expect(page.getByRole('heading', { name: 'Bookmarks that stay out of your address bar' })).toBeVisible();
  await expect(page.getByText('Step 1 of 5')).toBeVisible();
  await next(page).click();

  // ---------------------------------------------------------------- 2. the password
  await expect(page.getByText('Step 2 of 5')).toBeVisible();
  const create = page.getByRole('button', { name: 'Create vault' });

  // The gate. Matching passwords alone must not be enough — and pressing Next instead of reading
  // must not be a way round it either.
  await page.getByLabel('Master password').fill(PASSWORD);
  await page.getByLabel('Repeat the password').fill(PASSWORD);
  await expect(create).toBeDisabled();

  await next(page).click();
  await expect(page.getByText(/Create your master password first/)).toBeVisible();
  await expect(page.getByText('Step 2 of 5')).toBeVisible();

  // Typed case-insensitively with sloppy whitespace: the gate is "did you read it", not "can you
  // reproduce a string exactly".
  await page.getByLabel('Type the phrase to confirm').fill(`  ${CONFIRM_PHRASE.toLowerCase()} `);
  await expect(create).toBeEnabled();
  await create.click();

  // ---------------------------------------------------------------- 3. incognito
  // Creating the vault carries the flow forward on its own — the thing the user came for happened.
  await expect(page.getByText('Step 3 of 5')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'VaultaMark needs permission to open incognito windows' }),
  ).toBeVisible();

  // The address to paste is text, not a link Chrome would refuse to follow.
  await expect(page.locator('code')).toContainText(`chrome://extensions/?id=${extensionId}`);

  // Nothing can turn the toggle on from here, so Next is refused until the user answers.
  await next(page).click();
  await expect(page.getByText(/Turn on "Allow in Incognito"/)).toBeVisible();
  await expect(page.getByText('Step 3 of 5')).toBeVisible();

  await page.getByRole('button', { name: 'Skip for now' }).click();

  // ---------------------------------------------------------------- 4. the sync tier
  await expect(page.getByText('Step 4 of 5')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Chrome sync/ })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Google Drive/ })).toBeVisible();
  // Drive is present and marked, rather than hidden: nobody should pick Chrome sync believing it is
  // the only option and then find their vault capped at a thousand bookmarks. Since Phase 10 it is a
  // thing you can switch on today, so the badge says "Optional" rather than promising a release.
  await expect(page.getByText('Optional')).toBeVisible();
  await next(page).click();

  // ---------------------------------------------------------------- 5. what Chrome still does
  await expect(page.getByText('Step 5 of 5')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'One thing Chrome still remembers' })).toBeVisible();
  // The "Autocomplete searches and URLs" card was removed (ARCHITECTURE §12.4): it was the one card
  // in the flow with no control on it, and it sent people to a settings page we cannot verify.
  await expect(page.getByText('chrome://settings/?search=autocomplete')).toHaveCount(0);
  // The history tool asks for a permission first and explains why, rather than reaching for it.
  await expect(page.getByRole('button', { name: 'Allow history access' })).toBeVisible();

  await page.getByRole('button', { name: 'Finish setup' }).click();

  // ---------------------------------------------------------------- it is over
  // Finishing lands on the manager, with a vault that really exists.
  await expect(page.getByRole('heading', { name: 'VaultaMark' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();

  // The skipped incognito step left the persistent nudge PLAN §9 asks for.
  await expect(page.getByText(/"Allow in Incognito" is still off/)).toBeVisible();

  // And the flow does not come back — not on a reload, and not at its own URL.
  const again = await openOnboarding();
  await expect(again.getByRole('button', { name: 'Settings' })).toBeVisible();
  await expect(again.getByText('Step 1 of 5')).toHaveCount(0);
  await expect(again.getByRole('button', { name: 'Next' })).toHaveCount(0);

  await again.close();
  await page.close();
});
