/**
 * The windowed list fills the space it is given — including the space it is given *back*.
 *
 * Reported after an import: thirty-one bookmarks, three rows on screen, and a scrollbar that plainly
 * knew there were more. Scrolling a single pixel made the rest appear.
 *
 * The mechanism is a measurement taken at the wrong moment. `VirtualList` renders "what fits, plus a
 * little", and what fits is `clientHeight` — which is **0** while the three-column layout is
 * `hidden`, because the manager's screens are mutually exclusive and import/export replaces the
 * layout rather than covering it. An import repaints the list from behind that screen, so the window
 * is computed against a floor of one row; *Back to bookmarks* changes no scroll position and fires no
 * event, so nothing ever recomputed it. The same shape hides in resizing the window: more room, no
 * scroll, no new rows.
 *
 * A `ResizeObserver` on the scroll container answers both, and neither can be seen without a real
 * browser: jsdom lays nothing out, reports every `clientHeight` as 0, and has no `ResizeObserver` at
 * all. Its own profile, because it needs a vault of a few dozen bookmarks and a spec that shares a
 * fixture with that in it is a spec that breaks its neighbours (see `large-vault.spec.ts`).
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

import { extensionArgs } from './harness.js';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

const PASSWORD = 'correct horse battery staple';
const CONFIRM_PHRASE = 'I understand';

/** Enough that a one-row window is unmistakable, few enough to seed in a second. */
const BOOKMARKS = 30;

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

async function openPage(path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  return page;
}

/**
 * How many rows the list has actually built, and how many it says it has.
 *
 * The window is a rendering detail and the size is not: every row carries `aria-setsize`, which is
 * the vault's answer, while the number of `.vm-row` elements is the window's. The bug is exactly the
 * gap between the two.
 */
async function rowCounts(page: Page): Promise<{ rendered: number; total: number }> {
  return await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('.vm-row')];
    return {
      rendered: rows.length,
      total: Number(rows[0]?.getAttribute('aria-setsize') ?? '0'),
    };
  });
}

/** How many rows fit in the list's own box, which is what the window should be covering. */
async function rowsThatFit(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('.vm-vlist');
    const row = document.querySelector<HTMLElement>('.vm-row');
    if (list === null || row === null) return 0;
    return Math.floor(list.clientHeight / row.getBoundingClientRect().height);
  });
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-window-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // The default headless build does not run extensions at all — see lock.spec.ts.
    channel: 'chromium',
    headless: true,
    args: extensionArgs(DIST),
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;

  const popup = await openPage('popup.html');
  await expect(popup.getByLabel('Master password')).toBeVisible();
  await popup.getByLabel('Master password').fill(PASSWORD);
  await popup.getByLabel('Repeat the password').fill(PASSWORD);
  await popup.getByLabel('Type the phrase to confirm').fill(CONFIRM_PHRASE);
  await popup.getByRole('button', { name: 'Create vault' }).click();
  await expect(popup.getByRole('button', { name: 'Add this page' })).toBeVisible();

  for (let index = 0; index < BOOKMARKS; index++) {
    await popup.evaluate(
      (n) =>
        chrome.runtime.sendMessage({
          type: 'ADD_URL',
          url: `https://window-e2e.invalid/p${String(n)}`,
          title: `Bookmark number ${String(n)}`,
        }),
      index,
    );
  }
  await popup.close();
});

test.afterAll(async () => {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
});

test('a list repainted while it was off screen fills up when it comes back', async () => {
  const page = await openPage('manager.html');
  await expect(page.locator('.vm-row').first()).toBeVisible();
  expect((await rowCounts(page)).total).toBe(BOOKMARKS);

  // Import & export takes the layout off the page. Nothing is imported here — what matters is that
  // the list is repainted while it has no box, which is what an import's `VAULT_CHANGED` does.
  await page.getByRole('button', { name: 'Import & export' }).click();
  await expect(page.getByRole('heading', { name: 'Import & export' })).toBeVisible();
  await page.evaluate(
    () =>
      chrome.runtime.sendMessage({
        type: 'ADD_URL',
        url: 'https://window-e2e.invalid/added-while-away',
        title: 'Added while the list was hidden',
      }),
  );

  await page.getByRole('button', { name: 'Back to bookmarks' }).click();
  await expect(page.locator('.vm-row').first()).toBeVisible();

  // The window covers the viewport, and the list knows how long it really is. Before the fix this
  // was seven rendered rows of thirty-one, and no scroll to wake it up.
  await expect
    .poll(async () => (await rowCounts(page)).rendered)
    .toBeGreaterThanOrEqual(await rowsThatFit(page));
  expect((await rowCounts(page)).total).toBe(BOOKMARKS + 1);

  await page.close();
});

test('a list given more room fills it without being scrolled', async () => {
  const page = await openPage('manager.html');
  await page.setViewportSize({ width: 1200, height: 400 });
  await expect(page.locator('.vm-row').first()).toBeVisible();
  const short = (await rowCounts(page)).rendered;

  await page.setViewportSize({ width: 1200, height: 1000 });
  await expect.poll(async () => (await rowCounts(page)).rendered).toBeGreaterThan(short);
  await expect
    .poll(async () => (await rowCounts(page)).rendered)
    .toBeGreaterThanOrEqual(await rowsThatFit(page));

  await page.close();
});
