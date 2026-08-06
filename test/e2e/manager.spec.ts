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
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

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
 * Drag `source` onto `target` with real mouse input.
 *
 * Not `locator.dragTo()`: HTML5 drag-and-drop needs the pointer to *move over* the target while the
 * button is down, and a single jump lands a `drop` on an element that was never told to accept one.
 * The second move at the same coordinates is what makes Chromium emit the last `dragover` before
 * the button comes up.
 */
async function dragOnto(page: Page, source: Locator, target: Locator): Promise<void> {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (from === null || to === null) throw new Error('drag needs two visible elements');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
  await page.mouse.up();
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
  // Confirmed first, undoable after — the same pair the popup offers.
  await expect(page.getByRole('dialog')).toContainText('Delete 2 items?');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Deleted 2 bookmarks.')).toBeVisible();
  await expect(page.locator('.vm-row')).toHaveCount(0);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, 'Mushroom risotto')).toBeVisible();
  await expect(row(page, 'Overnight bread')).toBeVisible();

  // ---------------------------------------------------------------- nothing failed quietly
  // Errors land in the live region and stay there (confirmations clear themselves). Asserting no
  // error is showing is what turns "the move silently did nothing" into a failure that names
  // itself — which is how the debounce bug that dropped the selection out from under a bulk move
  // was found.
  await expect(page.locator('#vm-status .vm-notice--danger')).toHaveCount(0);

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

  // Settings replaces the whole layout, so it is a document of its own — a form of nothing but
  // controls, which is where labelling goes wrong.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Back to bookmarks' })).toBeVisible();
  await expectNoA11yViolations(page, 'the settings screen');
  await page.getByRole('button', { name: 'Back to bookmarks' }).click();
  await expect(row(page, 'Lattice reduction')).toBeVisible();

  // A modal is the fourth document, and the one where focus management goes wrong.
  await page.getByRole('button', { name: 'New folder' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoA11yViolations(page, 'a modal dialog');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.close();
});

/**
 * Sync, in a real browser, against the real `chrome.storage.sync`.
 *
 * The two things worth checking outside a mock: that the vault reaches the sync area **as
 * ciphertext**, and that getting it there involves no network request at all. The second is INV-4 in
 * its sharpest form — Chrome sync is a network feature, and the point of the Chrome tier is that
 * *we* never speak to it. The browser replicates the area; the extension only writes to it.
 */
test('syncs the vault into chrome.storage.sync, as ciphertext and without a request', async () => {
  const page = await openPage('manager.html');
  const before = requests.length;

  const control = page.locator('.vm-sync');
  await expect(control).toBeVisible();
  await control.click();
  await expect(control).toContainText(/last synced/iu);

  const synced = await page.evaluate(() => chrome.storage.sync.get(null));
  const keys = Object.keys(synced);
  expect(keys).toContain('vm.s.meta');
  expect(keys.some((key) => key.startsWith('vm.s.b'))).toBe(true);

  // INV-6: nothing a reader of the synced blob could understand.
  const blob = JSON.stringify(synced);
  expect(blob).not.toContain('Mushroom risotto');
  expect(blob).not.toContain('vaultamark-e2e.invalid');

  expect(requests.slice(before)).toEqual([]);

  await page.close();
});

/**
 * The Drive section of Settings, in a build with no Google project behind it.
 *
 * Which is every build made from this repository as it stands: `VM_OAUTH_CLIENT_ID` is a release
 * secret, so `manifest.oauth2` is absent and Drive cannot be offered. The property under test is
 * that the screen *says so* rather than showing a button that fails obscurely — and that reaching
 * that conclusion costs no network request, which is the INV-4 half a mocked `fetch` cannot prove.
 */
test('says plainly that Drive is unavailable in a build with no OAuth client, without asking anyone', async () => {
  const page = await openPage('manager.html');
  const before = requests.length;

  await page.getByRole('button', { name: 'Settings' }).click();
  // By its heading, not by its text: every section that *mentions* sync would otherwise match, and
  // "Chrome sync has nowhere to keep pictures" in the browsing section is one of them.
  const sync = page
    .locator('.vm-settings-section')
    .filter({ has: page.getByRole('heading', { name: 'Sync', exact: true }) });
  await expect(sync).toContainText('Chrome sync');
  await expect(sync).toContainText('no Google project configured');
  await expect(page.getByRole('button', { name: 'Connect Google Drive' })).toHaveCount(0);

  expect(requests.slice(before)).toEqual([]);
  await page.close();
});

test('drags a bookmark into a folder in the sidebar, and back out to the top level', async () => {
  const page = await openPage('manager.html');
  await vault(page, 'https://drag-e2e.invalid/one', 'Draggable one');
  await page.reload();

  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Dropped in');
  await page.getByRole('button', { name: 'Create folder' }).click();
  const folder = page.getByRole('treeitem', { name: /Dropped in/ });
  await expect(folder).toBeVisible();

  await dragOnto(page, row(page, 'Draggable one'), folder);
  await expect(page.getByText('Moved 1 item.')).toBeVisible();
  // Gone from the top level, and inside the folder it was dropped on.
  await expect(row(page, 'Draggable one')).toHaveCount(0);
  await folder.click();
  await expect(row(page, 'Draggable one')).toBeVisible();

  // The top level is a target too, or a drag would be a one-way trip.
  await dragOnto(page, row(page, 'Draggable one'), page.getByRole('button', { name: 'All bookmarks' }));
  await expect(row(page, 'Draggable one')).toHaveCount(0);
  await page.getByRole('button', { name: 'All bookmarks' }).click();
  await expect(row(page, 'Draggable one')).toBeVisible();

  // A folder row in the list is the same target by the nearer route.
  await dragOnto(page, row(page, 'Draggable one'), row(page, 'Dropped in'));
  await expect(row(page, 'Draggable one')).toHaveCount(0);
  await folder.click();
  await expect(row(page, 'Draggable one')).toBeVisible();

  await expect(page.locator('#vm-status .vm-notice--danger')).toHaveCount(0);
  await page.close();
});

test('clicking a row hands the list the focus, so the arrows and Delete work on it', async () => {
  // The bug this pins: the row's `mousedown` used to `preventDefault()`, which stopped the listbox
  // taking focus — the arrow keys scrolled the list without moving the cursor, and Delete, which is
  // only bound on the listbox, did nothing at all.
  const page = await openPage('manager.html');
  await vault(page, 'https://keys-e2e.invalid/alpha', 'Keyboard alpha');
  await vault(page, 'https://keys-e2e.invalid/beta', 'Keyboard beta');
  await page.reload();

  const listbox = page.locator('.vm-vlist');
  await row(page, 'Keyboard alpha').click();
  await expect(listbox).toBeFocused();

  const onAlpha = await listbox.getAttribute('aria-activedescendant');
  expect(onAlpha).not.toBeNull();
  await page.keyboard.press('ArrowDown');
  expect(await listbox.getAttribute('aria-activedescendant')).not.toBe(onAlpha);
  await page.keyboard.press('ArrowUp');
  expect(await listbox.getAttribute('aria-activedescendant')).toBe(onAlpha);

  await expect(page.getByText('1 selected')).toBeVisible();

  // Delete asks first, and a dismissed question leaves the bookmark alone. This is the whole
  // reason the confirmation exists: the key is one row away from the arrows that got here.
  await page.keyboard.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(row(page, 'Keyboard alpha')).toBeVisible();
  // `<dialog>` gives the focus back to whatever opened it, which is the whole reason the list is
  // still operable by keyboard after a question.
  await expect(listbox).toBeFocused();

  await page.keyboard.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(page, 'Keyboard alpha')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

  await page.close();
});

test('a tag filter and Untagged are alternatives, not layers', async () => {
  // Both used to end up highlighted at once: navigating left the tag query in the search box, and
  // a query outranks the scope, so "Untagged" answered with the tagged bookmarks it was showing.
  const page = await openPage('manager.html');
  await vault(page, 'https://scope-e2e.invalid/tagged', 'Scoped tagged');
  await vault(page, 'https://scope-e2e.invalid/plain', 'Scoped plain');
  await page.reload();

  await row(page, 'Scoped tagged').click();
  await page.getByRole('textbox', { name: 'Tags' }).fill('scoped');
  await page.getByRole('textbox', { name: 'Tags' }).press('Enter');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await page.getByRole('button', { name: /Show bookmarks tagged scoped/ }).click();
  await expect(row(page, 'Scoped tagged')).toBeVisible();
  await expect(row(page, 'Scoped plain')).toHaveCount(0);

  await page.getByRole('button', { name: 'Untagged' }).click();
  await expect(row(page, 'Scoped plain')).toBeVisible();
  await expect(row(page, 'Scoped tagged')).toHaveCount(0);
  // The filter that got us here is gone from the box, and exactly one place is current.
  await expect(page.getByLabel('Search your vault')).toHaveValue('');
  await expect(page.locator('.vm-sidebar .is-current')).toHaveCount(1);

  // ---------------------------------------------------------------- an empty rename is refused
  await page.getByRole('button', { name: 'Rename the tag scoped' }).click();
  await page.getByLabel('New name').fill('   ');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  // Still open, and saying why — it used to swallow the submit and look broken.
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('cannot be empty');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: /Show bookmarks tagged scoped/ })).toBeVisible();

  await page.close();
});

test('the side columns can be dragged wider, and stay that way', async () => {
  const page = await openPage('manager.html');
  await expect(page.locator('.vm-row').first()).toBeVisible();

  const sidebar = page.locator('.vm-sidebar-slot');
  const handle = page.getByRole('separator', { name: 'Resize the sidebar' });
  const before = (await sidebar.boundingBox())?.width ?? 0;
  /** Nothing in the sidebar sticks out of it — a column that scrolls sideways is a bug. */
  const fitsSideways = async (): Promise<boolean> =>
    await sidebar.evaluate((element) => element.scrollWidth <= element.clientWidth);
  expect(await fitsSideways(), 'sidebar at its default width').toBe(true);
  const grip = await handle.boundingBox();
  if (grip === null) throw new Error('no resizer');

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 80, grip.y + grip.height / 2, { steps: 10 });
  await page.mouse.up();

  const dragged = (await sidebar.boundingBox())?.width ?? 0;
  expect(dragged).toBeGreaterThan(before + 60);

  // A splitter that only a mouse can move is one a keyboard user is stuck with.
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  expect((await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(dragged);

  // Both ends of the range: the folder tree and the tag rows fit the column at either extreme.
  await page.keyboard.press('End');
  expect(await fitsSideways(), 'sidebar at its widest').toBe(true);
  await page.keyboard.press('Home');
  expect(await fitsSideways(), 'sidebar at its narrowest').toBe(true);
  await page.keyboard.press('End');

  // Persisted: the write is debounced, so give it its 300 ms before reloading.
  const settled = (await sidebar.boundingBox())?.width ?? 0;
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator('.vm-row').first()).toBeVisible();
  expect(Math.abs(((await sidebar.boundingBox())?.width ?? 0) - settled)).toBeLessThan(2);

  await page.close();
});

test('a double click on a folder row opens it', async () => {
  // The bug this pins: the list listened for `dblclick`, and never received one. Selecting a row
  // calls `VirtualList.refresh()`, which rebuilds every row in the window — so the element the
  // first click landed on was gone before the second arrived, and the browser had no shared target
  // to fire the event at. Double-clicking a folder selected it twice and opened nothing.
  const page = await openPage('manager.html');
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Doubleclick');
  await page.getByRole('button', { name: 'Create folder' }).click();
  await expect(row(page, 'Doubleclick')).toBeVisible();

  await row(page, 'Doubleclick').dblclick();
  await expect(page.locator('.vm-crumb')).toHaveText('Doubleclick');
  await expect(page.getByText('This folder is empty.')).toBeVisible();

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
  // Counted rather than assumed: every test in this file shares one vault, and hard-coding what is
  // in it makes this test fail for whatever the test above it happened to add.
  await expect(seeder.locator('.vm-row').first()).toBeVisible();
  const before = Number(
    await seeder.getByRole('button', { name: 'All bookmarks' }).locator('.vm-count').innerText(),
  );
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

  await expect(page.getByRole('button', { name: 'All bookmarks' })).toContainText(
    String(before + 5_000),
  );
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
