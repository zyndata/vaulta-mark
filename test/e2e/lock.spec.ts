/**
 * The Phase-4 definition of done, in a real Chromium with the real built extension: create a vault,
 * unlock it, watch it auto-lock, and panic-lock it.
 *
 * The unit suite covers the same paths against a `chrome.*` mock. This one exists because the parts
 * a mock cannot check are exactly the parts that break in the field: whether MV3 actually registers
 * the listeners, whether `chrome.storage.session` behaves the way ARCHITECTURE §5.5 assumes,
 * whether the CSP lets the popup's module load at all.
 *
 * `test/e2e/popup.spec.ts` (Phase 5) covers adding and opening bookmarks.
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

/** The extension's service worker. Its URL is also the only place the extension id is legible. */
async function serviceWorker(): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  return existing ?? (await context.waitForEvent('serviceworker'));
}

async function openPopup(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // `channel: 'chromium'` on purpose: Playwright's default headless build is
    // `chromium-headless-shell`, which does not run extensions at all — the service worker simply
    // never starts and the failure looks like a timeout rather than a missing feature.
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

test('creates, unlocks, auto-locks and panic-locks a vault', async () => {
  const page = await openPopup();

  // ---------------------------------------------------------------- create
  const create = page.getByRole('button', { name: 'Create vault' });
  await expect(create).toBeDisabled();

  // The no-recovery warning is a typed confirmation, not a checkbox: matching passwords alone
  // must not be enough to create a vault.
  await page.getByLabel('Master password').fill(PASSWORD);
  await page.getByLabel('Repeat the password').fill(PASSWORD);
  await expect(create).toBeDisabled();

  await page.getByLabel('Type the phrase to confirm').fill(CONFIRM_PHRASE);
  await expect(create).toBeEnabled();

  await create.click();
  await expect(page.getByText('Vault unlocked')).toBeVisible();

  // ---------------------------------------------------------------- manual lock
  await page.getByRole('button', { name: 'Lock now' }).click();
  const unlock = page.getByRole('button', { name: 'Unlock' });
  await expect(unlock).toBeVisible();

  await page.getByLabel('Master password').fill('not the password');
  await unlock.click();
  await expect(page.getByText('That password is not right.')).toBeVisible();

  await page.getByLabel('Master password').fill(PASSWORD);
  await unlock.click();
  await expect(page.getByText('Vault unlocked')).toBeVisible();

  // ---------------------------------------------------------------- auto-lock
  // The alarm is a convenience; the authority is the `unlockedUntil` check on every rehydrate
  // (ARCHITECTURE §7.3). Backdating the deadline is how a suspended laptop looks from here, and
  // it does not require waiting out a ten-minute idle window.
  const worker = await serviceWorker();
  await worker.evaluate(async () => {
    const stored = await chrome.storage.session.get('vm.session');
    const record = stored['vm.session'] as { unlockedUntil: number };
    await chrome.storage.session.set({
      'vm.session': { ...record, unlockedUntil: Date.now() - 1 },
    });
  });

  const reopened = await openPopup();
  await expect(reopened.getByRole('button', { name: 'Unlock' })).toBeVisible();
  // Reading the expired session is what locked it, so the key is gone by now.
  expect(await worker.evaluate(() => chrome.storage.session.get(null))).toEqual({});

  // ---------------------------------------------------------------- panic-lock
  await reopened.getByLabel('Master password').fill(PASSWORD);
  await reopened.getByRole('button', { name: 'Unlock' }).click();
  await expect(reopened.getByText('Vault unlocked')).toBeVisible();

  // The shortcut itself is an OS-level keystroke Chrome routes to `commands.onCommand`, which
  // headless Chromium gives no way to send; that dispatch is unit-tested. What is asserted here is
  // the effect. It is sent from the manager page for two reasons: Chrome does not deliver a service
  // worker's own `sendMessage` back to its own listener, and every *popup* closes itself on the
  // panic broadcast — which is the second half of what panic-lock promises, and is asserted below.
  const driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/manager.html`);

  const popupsClosed = Promise.all([page.waitForEvent('close'), reopened.waitForEvent('close')]);
  await driver.evaluate(() => chrome.runtime.sendMessage({ type: 'LOCK', panic: true }));
  await popupsClosed;

  expect(await worker.evaluate(() => chrome.storage.session.get(null))).toEqual({});
  const afterPanic = await openPopup();
  await expect(afterPanic.getByRole('button', { name: 'Unlock' })).toBeVisible();
});
