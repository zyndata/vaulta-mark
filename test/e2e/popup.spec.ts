/**
 * The Phase-5 definition of done, in a real Chromium with the real built extension: a bookmark in
 * the vault is listed, filtered, opened, deleted and undone from the popup — and **zero** network
 * requests happen while any of it does (INV-4).
 *
 * That last one is why this file exists rather than another unit test. INV-4 is a statement about
 * what the browser does, and no mock can make it: a favicon service, a font, an analytics beacon or
 * a stray `fetch` would pass every unit test in the suite and fail here.
 *
 * Two things this harness cannot do, and how each is covered instead:
 *
 * - **`activeTab` cannot be granted.** It comes from a click on the toolbar button, and Playwright
 *   drives pages, not browser chrome. So "Add this page" is exercised for its *failure* path here —
 *   which must be an explanation, not silence — and the succeeding path is covered end to end in
 *   `test/integration/add-and-open.test.ts` against the tab API.
 * - **There is no incognito profile** in a persistent context. Opening is asserted through a spy on
 *   `chrome.windows.create` installed in the service worker, exactly as PLAN Phase 5 prescribes.
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';

import { expectNoA11yViolations } from './a11y.js';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

const PASSWORD = 'correct horse battery staple';
const CONFIRM_PHRASE = 'I understand';

/** `.invalid` is reserved and unresolvable, so a request for it could only ever be ours. */
const PAGE_URL = 'https://vaultamark-e2e.invalid/an-article';
const PAGE_TITLE = 'An article worth keeping';

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;
/** Every http(s) request anything in this context tried to make. Must stay empty. */
const requests: string[] = [];

async function serviceWorker(): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  return existing ?? (await context.waitForEvent('serviceworker'));
}

async function openPopup(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

/**
 * Replace `chrome.windows.create` in the service worker with a recorder.
 *
 * A persistent context has no incognito profile to open a window into, and asserting on the call is
 * what the plan asks for. The spy also stops a real window from stealing focus mid-run.
 */
async function spyOnWindowCreate(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    const target = globalThis as unknown as { __vmWindows?: unknown[]; chrome: typeof chrome };
    target.__vmWindows = [];
    target.chrome.windows.create = (options?: unknown) => {
      target.__vmWindows?.push(options);
      return Promise.resolve({ id: 99, incognito: true } as chrome.windows.Window);
    };
  });
}

/**
 * The row for a bookmark.
 *
 * By class rather than by role: a row is an open button plus a delete button, and both carry the
 * title in their accessible name — deliberately, so a screen reader hears which one it is about.
 */
function rowFor(page: Page, title: string) {
  return page.locator('.vm-row-open').filter({ hasText: title });
}

async function createdWindows(worker: Worker): Promise<unknown[]> {
  return await worker.evaluate(
    () => (globalThis as unknown as { __vmWindows?: unknown[] }).__vmWindows ?? [],
  );
}

/**
 * Vault a URL through the context-menu entry point.
 *
 * Sent from an extension page rather than from the worker: Chrome does not deliver a service
 * worker's own `sendMessage` back to its own listener.
 */
async function vault(page: Page, url: string, title: string): Promise<unknown> {
  return await page.evaluate(
    ([u, t]) => chrome.runtime.sendMessage({ type: 'ADD_URL', url: u, title: t }),
    [url, title],
  );
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-popup-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // See lock.spec.ts: the default headless build does not run extensions at all.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });

  // INV-4, enforced rather than observed: anything that tries to reach the network is recorded and
  // aborted, so a regression fails an assertion instead of quietly succeeding over the wire.
  for (const pattern of ['http://**', 'https://**']) {
    await context.route(pattern, (route) => {
      requests.push(route.request().url());
      return route.abort();
    });
  }

  const worker = await serviceWorker();
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
});

test('lists, filters, opens, deletes and undoes a bookmark without touching the network', async () => {
  const worker = await serviceWorker();
  await spyOnWindowCreate(worker);

  // ---------------------------------------------------------------- create the vault
  const popup = await openPopup();
  // The create screen is a document that exists exactly once per profile, so the axe pass over it
  // has to happen here or not at all. It is also the one screen a first-time user cannot skip.
  await expectNoA11yViolations(popup, 'the popup, create screen');
  await popup.getByLabel('Master password').fill(PASSWORD);
  await popup.getByLabel('Repeat the password').fill(PASSWORD);
  await popup.getByLabel('Type the phrase to confirm').fill(CONFIRM_PHRASE);
  await popup.getByRole('button', { name: 'Create vault' }).click();

  await expect(popup.getByRole('button', { name: 'Add this page' })).toBeVisible();
  await expect(popup.getByText(/Nothing in the vault yet/)).toBeVisible();

  // ---------------------------------------------------------------- nothing fails silently
  // No toolbar click means no `activeTab` grant, so the worker cannot read a tab — and the popup
  // has to say so. A dead button is how someone concludes the extension is broken.
  await popup.getByRole('button', { name: 'Add this page' }).click();
  await expect(popup.getByText('There is no page to add here.')).toBeVisible();

  // ---------------------------------------------------------------- vault a page
  await vault(popup, PAGE_URL, PAGE_TITLE);
  await vault(popup, 'https://vaultamark-e2e.invalid/recipes', 'Recipes');

  const listed = await openPopup();
  const row = rowFor(listed, PAGE_TITLE);
  await expect(row).toBeVisible();
  await expect(listed.getByText('vaultamark-e2e.invalid').first()).toBeVisible();

  // The filter searches the vault, not only the rows already on screen.
  await listed.getByLabel('Filter your vault').fill('nothing matches this');
  await expect(listed.getByText(/Nothing matches/)).toBeVisible();
  await listed.getByLabel('Filter your vault').fill('article');
  await expect(row).toBeVisible();
  await expect(rowFor(listed, 'Recipes')).toHaveCount(0);
  await listed.getByLabel('Filter your vault').fill('');

  // ---------------------------------------------------------------- opening it
  // "Allow in Incognito" is off in a fresh profile, so the popup sends the user to the guided
  // prompt and opens nothing at all — the behaviour the whole product rests on.
  const guidePromise = context.waitForEvent('page');
  await rowFor(listed, PAGE_TITLE).click();
  const guide = await guidePromise;
  await guide.waitForLoadState();

  await expect(guide.getByText(/needs permission to open incognito windows/)).toBeVisible();
  await expect(guide.getByText(`chrome://extensions/?id=${extensionId}`)).toBeVisible();
  await guide.getByRole('button', { name: 'Re-check' }).click();
  await expect(guide.getByText(/Still off/)).toBeVisible();
  expect(await createdWindows(worker)).toEqual([]);

  // The labelled fallback is the only thing that opens a normal window, and only when pressed.
  await guide.getByRole('button', { name: 'Open in a normal window' }).click();
  await expect.poll(async () => await createdWindows(worker)).toEqual([
    { url: PAGE_URL, focused: true },
  ]);
  await guide.close();

  // ---------------------------------------------------------------- delete, then undo
  const final = await openPopup();
  // The "×" beside a row is a target the pointer finds on its way to the row, so it asks — the
  // same dialog, in the same words, that the manager asks. Dismissing it changes nothing.
  await final.getByRole('button', { name: new RegExp(`Delete .${PAGE_TITLE}`) }).click();
  await final.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(rowFor(final, PAGE_TITLE)).toBeVisible();

  await final.getByRole('button', { name: new RegExp(`Delete .${PAGE_TITLE}`) }).click();
  await final.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(final.getByText(new RegExp(`Deleted .${PAGE_TITLE}`))).toBeVisible();
  await expect(rowFor(final, PAGE_TITLE)).toHaveCount(0);

  // **The offer has to last as long as it says it does.** A delete schedules a sync, the sync
  // settles three seconds later, and the popup used to rebuild its whole shell on the status
  // broadcast — so the undo, and the bar drawing its deadline, vanished at three seconds of eight.
  // Four seconds is past that fuse and still inside the window.
  await final.waitForTimeout(4_000);
  await expect(final.locator('.vm-toast--timed')).toBeVisible();

  await final.getByRole('button', { name: 'Undo' }).click();
  await expect(rowFor(final, PAGE_TITLE)).toBeVisible();

  // ---------------------------------------------------------------- INV-4
  // Browsing the vault rendered two favicons, a guided prompt and three popups. None of it may have
  // produced a single request — not for an icon, not for a font, not for anything.
  expect(requests).toEqual([]);
});

/**
 * The popup's remaining documents (PLAN §9 Phase 12).
 *
 * Four screens live in one 26.4rem × 37.5rem window and the axe run only ever sees one of them at
 * a time: unlocked, settings, and — after the vault is shut — unlock. Run after the journey above,
 * which leaves a vault with something in it, because an empty list is not the document anybody has.
 */
test('every popup screen is free of critical and serious accessibility violations', async () => {
  const popup = await openPopup();
  await expect(popup.getByRole('button', { name: 'Add this page' })).toBeVisible();
  await expectNoA11yViolations(popup, 'the popup, unlocked with bookmarks');

  // Settings is a screen rather than a dialog here (post-phase-7 UI pass), which makes it a
  // document of its own: nothing but controls, which is where labelling goes wrong.
  await popup.getByRole('button', { name: 'Settings' }).click();
  await expect(popup.getByRole('button', { name: 'Back' })).toBeVisible();
  await expectNoA11yViolations(popup, 'the popup, settings screen');
  await popup.getByRole('button', { name: 'Back' }).click();

  await popup.getByRole('button', { name: 'Lock' }).click();
  await expect(popup.getByLabel('Master password')).toBeVisible();
  await expectNoA11yViolations(popup, 'the popup, unlock screen');

  // Still nothing over the wire, from any of it — axe injects its own script by evaluation, and a
  // page that reached for a font or an icon while being audited would be caught here.
  expect(requests).toEqual([]);
  await popup.close();
});
