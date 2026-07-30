/**
 * The Phase-6 journey in a real Chromium, against the real built extension:
 * create a folder → add an item → tag it → search finds it → bulk-move → undo restores.
 *
 * Plus the accessibility pass. `@axe-core/playwright` runs against the manager with a vault open, a
 * selection made and a dialog up, because those are three different documents as far as assistive
 * technology is concerned and only the first of them is what an empty page would test.
 *
 * The same two harness limits as `popup.spec.ts` apply: Playwright cannot grant `activeTab` (that
 * needs a click on browser chrome) and a persistent context has no incognito profile. So bookmarks
 * are vaulted through `ADD_URL` and opening is not exercised here — `test/unit/background/` covers
 * both against the tab and window APIs.
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

const PASSWORD = 'correct horse battery staple';
const CONFIRM_PHRASE = 'I understand';

/** `.invalid` is reserved and unresolvable, so a request for one could only ever be ours. */
const PAGES: readonly (readonly [string, string])[] = [
  ['https://vaultamark-e2e.invalid/risotto', 'Mushroom risotto, properly'],
  ['https://vaultamark-e2e.invalid/bread', 'Overnight bread'],
  ['https://elsewhere-e2e.invalid/lattice', 'Lattice reduction in practice'],
];

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

/** A row in the main list. Rows are options in a listbox — see `manager/list.ts`. */
function row(page: Page, title: string) {
  return page.locator('.vm-row').filter({ hasText: title });
}

async function rowTitles(page: Page): Promise<string[]> {
  return await page.locator('.vm-row .vm-row-title').allInnerTexts();
}

/** Vault a URL. Sent from a page: a worker's own `sendMessage` is not delivered to its listeners. */
async function vault(page: Page, url: string, title: string): Promise<void> {
  await page.evaluate(
    ([u, t]) => chrome.runtime.sendMessage({ type: 'ADD_URL', url: u, title: t }),
    [url, title],
  );
}

/**
 * Zero critical or serious violations, and the whole list printed when there are any.
 *
 * Scoped to the extension page itself. `color-contrast` is included deliberately: PLAN §9 asks for
 * 4.5:1 and it is the rule most easily lost to a later restyle.
 */
async function expectNoA11yViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  );
  expect(
    serious.map((violation) => `${violation.id}: ${violation.help} (${String(violation.nodes.length)})`),
    label,
  ).toEqual([]);
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-manager-'));
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

  // The manager reads and writes an unlocked vault; creating it is the popup's job.
  const popup = await openPage('popup.html');
  await popup.getByLabel('Master password').fill(PASSWORD);
  await popup.getByLabel('Repeat the password').fill(PASSWORD);
  await popup.getByLabel('Type the phrase to confirm').fill(CONFIRM_PHRASE);
  await popup.getByRole('button', { name: 'Create vault' }).click();
  await expect(popup.getByRole('button', { name: 'Add this page' })).toBeVisible();

  for (const [url, title] of PAGES) await vault(popup, url, title);
  await popup.close();
});

test.afterAll(async () => {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
});

test('creates a folder, tags an item, finds it, bulk-moves it, and undoes a delete', async () => {
  const page = await openPage('manager.html');

  // ---------------------------------------------------------------- the vault is there
  await expect(row(page, 'Mushroom risotto')).toBeVisible();
  await expect(page.getByRole('button', { name: 'All bookmarks' })).toContainText('3');

  // ---------------------------------------------------------------- create a folder
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Kitchen');
  await page.getByRole('button', { name: 'Create folder' }).click();
  await expect(page.getByRole('treeitem', { name: /Kitchen/ })).toBeVisible();
  // A folder sorts above bookmarks whatever the order says — it is a place, not an entry.
  expect((await rowTitles(page))[0]).toBe('Kitchen');

  // ---------------------------------------------------------------- tag a bookmark
  await row(page, 'Mushroom risotto').click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(
    'Mushroom risotto, properly',
  );
  await page.getByRole('textbox', { name: 'Tags' }).fill('dinner');
  await page.getByRole('textbox', { name: 'Tags' }).press('Enter');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: /Show bookmarks tagged dinner/ })).toBeVisible();

  // ---------------------------------------------------------------- search finds it
  await page.getByLabel('Search your vault').fill('risotto');
  await expect(row(page, 'Overnight bread')).toHaveCount(0);
  await expect(row(page, 'Mushroom risotto')).toBeVisible();
  // The matched text is marked, so the reason a result is a result is visible.
  await expect(page.locator('.vm-row mark')).toHaveText('risotto');

  // …including through the tag filter in the sidebar, which is the same query by another route.
  await page.getByLabel('Search your vault').fill('');
  await page.getByRole('button', { name: /Show bookmarks tagged dinner/ }).click();
  await expect(row(page, 'Overnight bread')).toHaveCount(0);
  await expect(row(page, 'Mushroom risotto')).toBeVisible();

  // ---------------------------------------------------------------- bulk move
  await page.getByRole('button', { name: 'All bookmarks' }).click();
  await expect(row(page, 'Overnight bread')).toBeVisible();
  await row(page, 'Mushroom risotto').click();
  await row(page, 'Overnight bread').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByText('2 selected')).toBeVisible();

  await page.getByRole('button', { name: 'Move to…' }).click();
  await page.getByLabel('Move to a folder').selectOption({ label: 'Kitchen' });
  await page.getByRole('button', { name: 'Move here' }).click();

  await expect(row(page, 'Mushroom risotto')).toHaveCount(0);
  await page.getByRole('treeitem', { name: /Kitchen/ }).click();
  await expect(row(page, 'Mushroom risotto')).toBeVisible();
  await expect(row(page, 'Overnight bread')).toBeVisible();
  // The breadcrumb says where we are, and gets us back.
  await expect(page.locator('.vm-crumb')).toHaveText('Kitchen');

  // ---------------------------------------------------------------- bulk delete, one undo
  await page.getByRole('button', { name: 'Select all' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Deleted 2 bookmarks.')).toBeVisible();
  await expect(page.locator('.vm-row')).toHaveCount(0);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, 'Mushroom risotto')).toBeVisible();
  await expect(row(page, 'Overnight bread')).toBeVisible();

  // ---------------------------------------------------------------- nothing failed quietly
  // The status area is where a failed operation lands, and it persists. Asserting it is empty is
  // what turns "the move silently did nothing" into a failure that names itself — which is how the
  // debounce bug that dropped the selection out from under a bulk move was found.
  await expect(page.locator('#vm-status')).toBeEmpty();

  // ---------------------------------------------------------------- INV-4
  // Three bookmarks, a folder tree, favicons and a search, and not one request.
  expect(requests).toEqual([]);

  await page.close();
});

test('is keyboard-operable end to end', async () => {
  // Deliberately independent of what the journey test left behind — it moves bookmarks into a
  // folder — so this reads the root listing rather than assuming which titles are in it.
  const page = await openPage('manager.html');
  await expect(row(page, 'Lattice reduction')).toBeVisible();
  const atRoot = await page.locator('.vm-row').count();
  expect(atRoot).toBeGreaterThan(1);

  // `/` focuses search from anywhere on the page.
  await page.locator('body').press('/');
  await expect(page.getByLabel('Search your vault')).toBeFocused();
  await page.keyboard.type('lattice');
  await expect(page.locator('.vm-row')).toHaveCount(1);
  await expect(row(page, 'Lattice reduction')).toBeVisible();

  // Escape in the search box clears it rather than leaving a filter nobody can see the cause of.
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Search your vault')).toHaveValue('');
  await expect(page.locator('.vm-row')).toHaveCount(atRoot);

  // j/k move a cursor through the list, and the listbox says which option it is on.
  await page.locator('.vm-vlist').focus();
  await page.keyboard.press('j');
  const first = await page.locator('.vm-vlist').getAttribute('aria-activedescendant');
  expect(first).not.toBeNull();
  await page.keyboard.press('j');
  expect(await page.locator('.vm-vlist').getAttribute('aria-activedescendant')).not.toBe(first);
  await page.keyboard.press('k');
  expect(await page.locator('.vm-vlist').getAttribute('aria-activedescendant')).toBe(first);

  await expect(page.getByText('1 selected')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('1 selected')).toHaveCount(0);

  await page.close();
});

test('has no critical or serious accessibility violations', async () => {
  const page = await openPage('manager.html');
  await expect(row(page, 'Lattice reduction')).toBeVisible();
  await expectNoA11yViolations(page, 'the manager, at rest');

  // A selection turns the detail pane into a form and enables the toolbar — a different document.
  await row(page, 'Lattice reduction').click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();
  await expectNoA11yViolations(page, 'the manager, with a bookmark selected');

  // A modal is the third document, and the one where focus management goes wrong.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoA11yViolations(page, 'the settings dialog');
  await page.getByRole('button', { name: 'Close' }).click();

  await page.close();
});

test('renders five thousand bookmarks without putting five thousand rows in the page', async () => {
  // PLAN §9 Phase 6's budget. The load-bearing assertion is the row count: a list that renders
  // every item passes a timing check on a fast machine and falls over on a slow one.
  //
  // Seeding dominates the runtime and is not what is being measured. There is no bulk-add on the
  // wire — import arrives in Phase 8 — so five thousand bookmarks are five thousand round trips,
  // each of which re-seals and rewrites the bucket its item landed in.
  test.setTimeout(600_000);

  const seeder = await openPage('manager.html');
  const seedMs = await seeder.evaluate(async () => {
    const started = Date.now();
    for (let i = 0; i < 5_000; i++) {
      await chrome.runtime.sendMessage({
        type: 'ADD_URL',
        url: `https://bulk-e2e.invalid/page-${String(i)}`,
        title: `Bulk bookmark ${String(i)}`,
      });
    }
    return Date.now() - started;
  });
  // Reported because it is most of this test's runtime and none of what it measures — a reader
  // watching CI should be able to tell seeding from rendering.
  console.log(`seeded 5,000 bookmarks in ${String(Math.round(seedMs / 1000))} s`);
  await seeder.close();

  const page = await context.newPage();
  const started = Date.now();
  await page.goto(`chrome-extension://${extensionId}/manager.html`);
  await expect(page.locator('.vm-row').first()).toBeVisible();
  const elapsed = Date.now() - started;

  await expect(page.getByRole('button', { name: 'All bookmarks' })).toContainText('5003');
  // What fits, plus the overscan — not five thousand.
  expect(await page.locator('.vm-row').count()).toBeLessThan(60);
  // The canvas still claims the full height, so the scrollbar tells the truth.
  const canvasHeight = await page.locator('.vm-vlist-canvas').evaluate((el) => el.clientHeight);
  expect(canvasHeight).toBeGreaterThan(5_000 * 40);

  // Generous, because it includes launching a tab and a cold service-worker start; the ceiling
  // exists to catch an accidentally unwindowed list, which misses it by an order of magnitude.
  expect(elapsed, `first paint took ${String(elapsed)} ms`).toBeLessThan(4_000);

  // Scrolling to the end moves the window rather than growing it.
  await page.locator('.vm-vlist').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator('.vm-row').first()).toBeVisible();
  expect(await page.locator('.vm-row').count()).toBeLessThan(60);

  expect(requests).toEqual([]);
  await page.close();
});
