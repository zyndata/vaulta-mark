/**
 * Five thousand bookmarks, in a profile of its own (PLAN §9 Phase 6's budget, moved here in
 * Phase 12).
 *
 * **The load-bearing assertion is the row count**, not the clock: a list that renders every item
 * passes a timing check on a fast machine and falls over on a slow one, so what is checked is that
 * the DOM holds a window rather than a vault.
 *
 * It lived in `manager.spec.ts` until Phase 12 and moved out because of how it failed there. That
 * file shares one vault across a dozen tests, several of which have already pushed to
 * `chrome.storage.sync` — so by the time this ran, the sync engine was live, and bulk-adding five
 * times the Chrome-sync capacity into a 100 KB area made it grind: seeding took twice as long and
 * the manager afterwards sat on "Opening the vault…" past the default five-second expectation. It
 * passed on its own and failed in sequence, which is the signature of a shared fixture rather than
 * a product fault. A private profile is both the fix and the honest arrangement: nothing else here
 * wants a vault with five thousand things in it.
 *
 * Seeding is most of the runtime and none of what is measured. There is still no bulk-add on the
 * wire — the two import paths need a permission or a sealed file, neither of which this harness can
 * produce — so five thousand bookmarks are five thousand round trips, sent in **concurrent
 * batches**. That is safe because `VaultRepository.apply` serialises (Phase 12); before it did,
 * twenty concurrent adds committed at *two* revisions instead of twenty-one.
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

const PASSWORD = 'correct horse battery staple';
const CONFIRM_PHRASE = 'I understand';
const COUNT = 5_000;

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;
/** Every http(s) request anything in this context tried to make. Must stay empty (INV-4). */
const requests: string[] = [];

async function openPage(path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  return page;
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-large-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // See lock.spec.ts: the default headless build does not run extensions at all.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });

  for (const pattern of ['http://**', 'https://**']) {
    await context.route(pattern, (route) => {
      requests.push(route.request().url());
      return route.abort();
    });
  }

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;

  const popup = await openPage('popup.html');
  await popup.getByLabel('Master password').fill(PASSWORD);
  await popup.getByLabel('Repeat the password').fill(PASSWORD);
  await popup.getByLabel('Type the phrase to confirm').fill(CONFIRM_PHRASE);
  await popup.getByRole('button', { name: 'Create vault' }).click();
  await expect(popup.getByRole('button', { name: 'Add this page' })).toBeVisible();
  await popup.close();
});

test.afterAll(async () => {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
});

test('renders five thousand bookmarks without putting five thousand rows in the page', async () => {
  test.setTimeout(600_000);

  const seeder = await openPage('manager.html');
  const seedMs = await seeder.evaluate(async (total) => {
    const started = Date.now();
    const BATCH = 100;
    for (let from = 0; from < total; from += BATCH) {
      await Promise.all(
        Array.from({ length: BATCH }, async (_unused, offset) => {
          const index = from + offset;
          await chrome.runtime.sendMessage({
            type: 'ADD_URL',
            url: `https://bulk-e2e.invalid/page-${String(index)}`,
            title: `Bulk bookmark ${String(index)}`,
          });
        }),
      );
    }
    return Date.now() - started;
  }, COUNT);
  // Reported because it is most of this test's runtime and none of what it measures — a reader
  // watching CI should be able to tell seeding from rendering.
  console.log(`seeded ${String(COUNT)} bookmarks in ${String(Math.round(seedMs / 1000))} s`);
  await seeder.close();

  const page = await context.newPage();
  const started = Date.now();
  await page.goto(`chrome-extension://${extensionId}/manager.html`);
  await expect(page.locator('.vm-row').first()).toBeVisible();
  const elapsed = Date.now() - started;

  await expect(page.getByRole('button', { name: 'All bookmarks' })).toContainText(String(COUNT));
  // What fits, plus the overscan — not five thousand.
  expect(await page.locator('.vm-row').count()).toBeLessThan(60);
  // The canvas still claims the full height, so the scrollbar tells the truth.
  const canvasHeight = await page.locator('.vm-vlist-canvas').evaluate((el) => el.clientHeight);
  expect(canvasHeight).toBeGreaterThan(COUNT * 40);

  // Generous, because it includes launching a tab and a cold service-worker start; the ceiling
  // exists to catch an accidentally unwindowed list, which misses it by an order of magnitude.
  expect(elapsed, `first paint took ${String(elapsed)} ms`).toBeLessThan(4_000);

  // Scrolling to the end moves the window rather than growing it.
  await page.locator('.vm-vlist').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator('.vm-row').first()).toBeVisible();
  expect(await page.locator('.vm-row').count()).toBeLessThan(60);

  // Five thousand favicons, and not one request: `_favicon/` is served by the browser from the
  // extension's own origin, which is the entire reason a third-party favicon service was refused.
  expect(requests).toEqual([]);
  await page.close();
});
