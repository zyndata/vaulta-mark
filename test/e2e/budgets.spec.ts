/**
 * The one performance budget that needs a real renderer: **popup first paint < 100 ms**
 * (PLAN §9 Phase 12).
 *
 * The other four are measured where they can be: the package sizes in `scripts/check-budgets.mjs`,
 * the service worker's cold start in `test/unit/background/message-router.test.ts`, and the unlock
 * in `test/integration/vault-lifecycle.test.ts`. This one cannot be — "first paint" is a thing a
 * compositor does, and jsdom has no compositor.
 *
 * **What is measured, and what is deliberately not.** The budget is the popup's own work: parsing
 * its JavaScript, asking the worker for state, and painting the screen that answer calls for. It is
 * measured from `responseStart` — the moment the document's bytes begin arriving — rather than from
 * `navigationStart`, because Playwright's `page.goto` includes tab creation and the extension-URL
 * round trip, neither of which happens when Chrome opens a real popup from the toolbar. Measuring
 * from `navigationStart` would report a number two to three times the truth and would mostly track
 * how busy the test machine's tab bar is.
 *
 * **Best of several samples**, like the other wall-clock budgets in this repo. A single sample in a
 * suite that has just built a vault measures the scheduler; the best of five measures the code. The
 * budget is the spec's 100 ms locally and tripled in CI, for the same reason the cold-start one is:
 * a shared runner is roughly three times slower than a developer's machine, and a budget that fails
 * on CI weather is a budget people learn to re-run rather than to read.
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

const PASSWORD = 'correct horse battery staple';
const CONFIRM_PHRASE = 'I understand';

/** PLAN §9 Phase 12. Tripled on CI — see the note at the top of this file. */
const FIRST_PAINT_BUDGET_MS = process.env['CI'] === undefined ? 100 : 300;

const SAMPLES = 5;

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

async function openPopup(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

/**
 * Milliseconds from the document's first byte to the paint that put something on screen.
 *
 * `first-contentful-paint` rather than `first-paint`: the popup's background is painted before its
 * content exists, and a budget satisfied by a blank rectangle is not a budget. Both entries are in
 * the `paint` timeline, so taking the wrong one is a one-word mistake with a very flattering result.
 */
async function firstPaintMs(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    /*
     * Waited for, not read. The paint entry is queued by the compositor and lands a moment after
     * the pixels do, so reading it the instant a locator becomes visible sometimes finds an empty
     * timeline — which is how this test passed alone and failed inside the suite. `buffered: true`
     * delivers an entry that arrived before the observer existed, so the wait is a formality in
     * the common case rather than a second source of timing.
     */
    const paint = await new Promise<PerformanceEntry | null>((resolve) => {
      const existing = performance
        .getEntriesByType('paint')
        .find((entry) => entry.name === 'first-contentful-paint');
      if (existing !== undefined) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(() => {
        resolve(null);
      }, 5_000);
      new PerformanceObserver((list, observer) => {
        const found = list.getEntries().find((entry) => entry.name === 'first-contentful-paint');
        if (found === undefined) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(found);
      }).observe({ type: 'paint', buffered: true });
    });

    const [navigation] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    if (paint === null || navigation === undefined) return Number.NaN;
    return paint.startTime - navigation.responseStart;
  });
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-budgets-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // See lock.spec.ts: the default headless build does not run extensions at all.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
});

test('the popup paints inside its budget, locked and unlocked', async () => {
  // Create a vault and put something in it: an empty popup paints a placeholder, and the screen
  // that has to be fast is the one with a list on it.
  const first = await openPopup();
  await first.getByLabel('Master password').fill(PASSWORD);
  await first.getByLabel('Repeat the password').fill(PASSWORD);
  await first.getByLabel('Type the phrase to confirm').fill(CONFIRM_PHRASE);
  await first.getByRole('button', { name: 'Create vault' }).click();
  await expect(first.getByRole('button', { name: 'Add this page' })).toBeVisible();

  for (let n = 0; n < 20; n++) {
    await first.evaluate(
      (index) =>
        chrome.runtime.sendMessage({
          type: 'ADD_URL',
          url: `https://budget-e2e.invalid/${String(index)}`,
          title: `Bookmark number ${String(index)}`,
        }),
      n,
    );
  }
  await first.close();

  const measure = async (expectVisible: (page: Page) => Promise<void>): Promise<number> => {
    let best = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < SAMPLES; sample++) {
      const page = await openPopup();
      await expectVisible(page);
      const paint = await firstPaintMs(page);
      await page.close();
      if (Number.isFinite(paint)) best = Math.min(best, paint);
    }
    return best;
  };

  const unlocked = await measure(async (page) => {
    await expect(page.getByRole('button', { name: 'Add this page' })).toBeVisible();
  });
  expect(Number.isFinite(unlocked), 'the paint timeline had no first-contentful-paint').toBe(true);
  expect(unlocked, `unlocked popup first paint: ${unlocked.toFixed(1)} ms`).toBeLessThan(
    FIRST_PAINT_BUDGET_MS,
  );

  // Locked is the screen people see most often — every idle timeout ends here — and it is the one
  // that must not wait on anything: the vault is shut, so there is nothing to decrypt and no reason
  // for this to be slower than the unlocked one.
  const locker = await openPopup();
  await locker.getByRole('button', { name: 'Lock' }).click();
  await expect(locker.getByLabel('Master password')).toBeVisible();
  await locker.close();

  const locked = await measure(async (page) => {
    await expect(page.getByLabel('Master password')).toBeVisible();
  });
  expect(locked, `locked popup first paint: ${locked.toFixed(1)} ms`).toBeLessThan(
    FIRST_PAINT_BUDGET_MS,
  );

  console.log(
    `popup first paint — unlocked ${unlocked.toFixed(1)} ms, locked ${locked.toFixed(1)} ms ` +
      `(budget ${String(FIRST_PAINT_BUDGET_MS)} ms, best of ${String(SAMPLES)})`,
  );
});
