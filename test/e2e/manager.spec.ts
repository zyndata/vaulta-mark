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
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

import { expectNoA11yViolations } from './a11y.js';
import { extensionArgs } from './harness.js';

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
/**
 * Drag `source` onto the top or bottom edge of `target` — a drop *between* rows rather than into one.
 *
 * The offset is deliberately 15% and 85% rather than 1px from each edge: `reorderZone` reads the
 * top and bottom quarters, and a test aimed at the extreme pixel would pass against an
 * implementation whose bands were one pixel deep.
 */
async function dragBeside(
  page: Page,
  source: Locator,
  target: Locator,
  edge: 'top' | 'bottom',
): Promise<void> {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (from === null || to === null) throw new Error('drag needs two visible elements');
  const y = to.y + to.height * (edge === 'top' ? 0.15 : 0.85);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, y, { steps: 12 });
  await page.mouse.move(to.x + to.width / 2, y);
  await page.mouse.up();
}

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


test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-manager-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // See lock.spec.ts: the default headless build does not run extensions at all.
    channel: 'chromium',
    headless: true,
    args: extensionArgs(DIST),
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

  // Import & export replaces the layout with a fifth: three file controls and a progress bar, which
  // is where a label attached to the wrong thing hides.
  await page.getByRole('button', { name: 'Import & export' }).click();
  await expect(page.getByRole('button', { name: 'Back to bookmarks' })).toBeVisible();
  await expectNoA11yViolations(page, 'the import and export screen');
  await page.getByRole('button', { name: 'Back to bookmarks' }).click();
  await expect(row(page, 'Lattice reduction')).toBeVisible();

  await page.close();
});

/**
 * `manager.html#settings` — the popup's "All settings in the manager" button.
 *
 * The popup's own settings screen keeps auto-lock and hands the other seven sections over, so this
 * hash is the whole of that handover: it has to land on the settings screen rather than the list, and
 * it has to be *spent*. The manager's screens are not addressable — Back changes the screen without
 * touching the URL — so a hash left in the address bar would describe a screen the user has left, and
 * would put it back on reload.
 */
test('#settings opens the manager on its settings screen and then spends the hash', async () => {
  const page = await openPage('manager.html#settings');
  await expect(page.getByRole('button', { name: 'Back to bookmarks' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');

  // And the list underneath finished loading regardless: settings replaces the layout rather than
  // standing in for it, so Back has somewhere to go.
  await page.getByRole('button', { name: 'Back to bookmarks' }).click();
  await expect(row(page, 'Lattice reduction')).toBeVisible();

  // A reload with the hash gone is the plain manager, which is the point of spending it.
  await page.reload();
  await expect(row(page, 'Lattice reduction')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to bookmarks' })).toHaveCount(0);
  await page.close();
});

/**
 * The incognito prompt is its own document at its own address, and the one page here that a user
 * reaches while something is *wrong* — which is exactly when a missing label costs most.
 */
test('the incognito prompt has no critical or serious accessibility violations', async () => {
  const page = await openPage('manager.html#incognito=nothing-in-particular');
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  await expectNoA11yViolations(page, 'the guided incognito prompt');

  // Step 1 opens the page it names. An `<a href="chrome://…">` would be refused, which is why this
  // is a button — and why the assertion is that a real tab appears at that address.
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open that page' }).click();
  const settings = await opened;
  expect(settings.url()).toBe(`chrome://extensions/?id=${extensionId}`);
  await settings.close();
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
 * Which is every build made from a fresh clone: `VM_OAUTH_CLIENT_ID` is a release secret, so
 * `manifest.oauth2` is absent and Drive cannot be offered. The property under test is that the
 * screen *says so* rather than showing a button that fails obscurely — and that reaching that
 * conclusion costs no network request, which is the INV-4 half a mocked `fetch` cannot prove.
 *
 * **Skipped when the build under test does have a client id.** That state exists on exactly one kind
 * of machine — a maintainer's, with an `.env.local` — and it did not exist at all until the build
 * started reading that file, which is why this test only started failing there. Asserting the
 * unconfigured screen against a configured build would be asserting the wrong thing about a correct
 * package, and weakening the assertion to accept either would leave the case untested everywhere. CI
 * has no `.env.local`, so this still runs on every push, which is where it matters.
 */
test('says plainly that Drive is unavailable in a build with no OAuth client, without asking anyone', async () => {
  const page = await openPage('manager.html');
  const configured = await page.evaluate(() => 'oauth2' in chrome.runtime.getManifest());
  test.skip(configured, 'this build has VM_OAUTH_CLIENT_ID set; there is no "unavailable" to show');
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

  // ...and that it says what to do about it with the two values that have to be carried to the
  // Google Cloud console, which are properties of this running build rather than of the docs.
  await expect(sync).toContainText('https://www.googleapis.com/auth/drive.file');
  const id = await page.evaluate(() => chrome.runtime.id);
  expect(id).toMatch(/^[a-p]{32}$/);
  await expect(sync.locator('code', { hasText: id })).toHaveCount(1);

  // INV-3 on screen: the console is named, never linked. A link here would need an entry in
  // build/url-allowlist.json, and this asserts nobody added one for a convenience.
  await expect(sync.locator('a')).toHaveCount(0);

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

/**
 * Reordering (Phase 12), by drag and by keyboard.
 *
 * The order the vault has always maintained — a fractional index per item, since Phase 3 — became
 * visible in this phase as the `manual` sort key. Nothing here is testable under any other order:
 * the list re-sorts itself on the next reload and a drop between two rows would be a gesture with
 * no effect, which is exactly why those views withdraw the gesture rather than making it a no-op.
 */
test('reorders bookmarks by dragging between rows, and by the keyboard', async () => {
  const page = await openPage('manager.html');

  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Ordering');
  await page.getByRole('button', { name: 'Create folder' }).click();
  const folder = page.getByRole('treeitem', { name: /Ordering/ });
  await expect(folder).toBeVisible();

  // `vault()` is the context-menu path and always adds at the top level, so the three are dragged
  // into the folder one at a time — which also seeds a known order, since each drop appends.
  for (const title of ['Alpha', 'Bravo', 'Charlie']) {
    await vault(page, `https://order-e2e.invalid/${title.toLowerCase()}`, title);
    await page.reload();
    await dragOnto(page, row(page, title), folder);
    await expect(row(page, title)).toHaveCount(0);
  }
  await folder.click();

  // "My own order" is the whole precondition. Under any other key this test is meaningless.
  await page.getByLabel('Sort by').selectOption('manual');
  await expect(row(page, 'Alpha')).toBeVisible();
  /*
   * Polled, not read once. Every move here is a round trip to the worker followed by a reload, so a
   * bare read races the repaint — and the first version of this test did, passing the drag and
   * then reading the previous order back.
   */
  const expectOrder = async (...titles: string[]): Promise<void> => {
    await expect
      .poll(async () => await page.locator('.vm-row .vm-row-title').allInnerTexts())
      .toEqual(titles);
  };
  await expectOrder('Alpha', 'Bravo', 'Charlie');

  // Drag the last one above the first: the drop lands on Alpha's top edge, so the anchor is
  // "nothing" and the model is asked to put it first.
  await dragBeside(page, row(page, 'Charlie'), row(page, 'Alpha'), 'top');
  await expect(page.getByText('Moved.')).toBeVisible();
  await expectOrder('Charlie', 'Alpha', 'Bravo');

  // And back down, onto the bottom edge of the last row.
  await dragBeside(page, row(page, 'Charlie'), row(page, 'Bravo'), 'bottom');
  await expectOrder('Alpha', 'Bravo', 'Charlie');

  /*
   * The keyboard equivalent, which PLAN §9 asks for by name. Alt+Up / Alt+Down move the *items*
   * where the unmodified keys move the cursor, and the selection has to survive the reload the
   * move causes — otherwise a second press does nothing, which is the difference between a
   * shortcut and a trick. So this presses twice.
   */
  await row(page, 'Alpha').click();
  await page.keyboard.press('Alt+ArrowDown');
  await expectOrder('Bravo', 'Alpha', 'Charlie');
  await page.keyboard.press('Alt+ArrowDown');
  await expectOrder('Bravo', 'Charlie', 'Alpha');
  await page.keyboard.press('Alt+ArrowUp');
  await expectOrder('Bravo', 'Alpha', 'Charlie');

  // At the end of the list it stops rather than wrapping; a wrap would be a two-key trip from one
  // end of five thousand rows to the other, by accident.
  await row(page, 'Bravo').click();
  await page.keyboard.press('Alt+ArrowUp');
  await expectOrder('Bravo', 'Alpha', 'Charlie');

  // Under a derived order the same keystroke says why it did nothing, rather than doing nothing.
  await page.getByLabel('Sort by').selectOption('title');
  await row(page, 'Alpha').click();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.getByText('Reordering works in')).toBeVisible();
  await expectOrder('Alpha', 'Bravo', 'Charlie');

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
  await page.getByRole('button', { name: /tag scoped/ }).click();
  await page.getByLabel('New name').fill('   ');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  // Still open, and saying why — it used to swallow the submit and look broken.
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('cannot be empty');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: /Show bookmarks tagged scoped/ })).toBeVisible();

  await page.close();
});

/**
 * The pencil beside a tag now opens a panel with two answers in it, and this is the second one.
 *
 * A tag is not an object in the vault — it exists exactly as long as something is tagged with it —
 * so "delete the tag" is a bulk untag, and the thing worth asserting is that it deletes no bookmark.
 */
test('the tag panel can take a tag off everything without deleting a bookmark', async () => {
  const page = await openPage('manager.html');
  await vault(page, 'https://tag-e2e.invalid/one', 'Tagged one');
  await vault(page, 'https://tag-e2e.invalid/two', 'Tagged two');
  await page.reload();

  await row(page, 'Tagged one').click();
  await row(page, 'Tagged two').click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: 'Tag…' }).click();
  await page.getByLabel('Add these tags').fill('doomed');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('button', { name: /Show bookmarks tagged doomed/ })).toBeVisible();

  await page.getByRole('button', { name: /tag doomed/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete the tag' }).click();
  // A second, separate press: the panel closes and the confirmation names how much it touches.
  await expect(page.getByRole('dialog')).toContainText('2 bookmarks');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete the tag' }).click();

  await expect(page.getByRole('button', { name: /Show bookmarks tagged doomed/ })).toHaveCount(0);
  await expect(row(page, 'Tagged one')).toBeVisible();
  await expect(row(page, 'Tagged two')).toBeVisible();
  await page.close();
});

/**
 * The same pencil, on a folder in the tree.
 *
 * Renaming a folder used to mean finding it as a *row in the list* first, which is a trip that only
 * makes sense to whoever built it. Delete hands to the question that was always asked about a
 * folder's contents, so that path is covered by the keyboard-Delete test below and only the door is
 * asserted here.
 */
test('the pencil beside a folder renames it from the tree', async () => {
  const page = await openPage('manager.html');
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Misnamed');
  await page.getByRole('button', { name: 'Create folder' }).click();

  const folder = page.locator('.vm-tree-item:has(> .vm-tree-row > .vm-tree-title:text-is("Misnamed"))');
  await expect(folder).toBeVisible();
  await folder.locator('.vm-tree-edit').click();
  await page.getByLabel('Folder name').fill('Renamed from the tree');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();

  const renamed = page.locator(
    '.vm-tree-item:has(> .vm-tree-row > .vm-tree-title:text-is("Renamed from the tree"))',
  );
  await expect(renamed).toBeVisible();
  await expect(folder).toHaveCount(0);

  /*
   * The keyboard's way to the same panel.
   *
   * The pencil is deliberately not a tab stop — the tree is one stop, not one per folder — so F2 on
   * the focused folder is what stands in for it. Tabbing off a folder therefore leaves the tree
   * outright; with the button's default tabindex it would stop at that folder's own pencil, and
   * crossing a vault of thirty folders would take thirty presses. (Where it lands next is the tag
   * list, which is a plain list of buttons and is a stop per tag by design.)
   */
  await renamed.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.vm-tree :focus')).toHaveCount(0);

  await renamed.focus();
  await page.keyboard.press('F2');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Folder name')).toHaveValue('Renamed from the tree');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.close();
});

/**
 * Escape leaves a full-window screen, the way its Back button does.
 *
 * Also asserts the case that decides the implementation: with a modal open, Escape belongs to the
 * modal and must not close the screen behind it as well.
 */
test('Escape leaves settings and import & export, but not from under a dialog', async () => {
  const page = await openPage('manager.html');
  await expect(row(page, 'Lattice reduction')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('button', { name: 'Back to bookmarks' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row(page, 'Lattice reduction')).toBeVisible();

  await page.getByRole('button', { name: 'Import & export' }).click();
  await expect(page.getByRole('button', { name: 'Back to bookmarks' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row(page, 'Lattice reduction')).toBeVisible();

  // One keystroke, one answer: the dialog closes and the list stays where it was.
  await page.getByRole('button', { name: 'New folder' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row(page, 'Lattice reduction')).toBeVisible();
  await page.close();
});

/**
 * The keyboard-shortcut section: what the keys are bound to *now*, and the button that changes them.
 *
 * The bindings are Chrome's — an extension can suggest one and read back what was granted, and
 * cannot set one. **`chrome.tabs.create` can open `chrome://extensions/shortcuts`**, which this
 * asserts against the real browser: an `<a href>` to a `chrome://` address is refused and
 * `window.open` is dropped in silence, so the tabs API being allowed is the whole reason this is a
 * button and not an address to copy. If a future Chrome closes that door, this test is where it
 * shows up rather than in a bug report about a dead button.
 */
test('settings lists the keyboard commands and opens Chrome’s page for rebinding them', async () => {
  const page = await openPage('manager.html');
  await page.getByRole('button', { name: 'Settings' }).click();

  const shortcuts = page
    .locator('.vm-settings-section')
    .filter({ has: page.getByRole('heading', { name: 'Keyboard shortcuts' }) });
  await expect(shortcuts).toContainText('Add the current tab to the vault');
  // Never an <a href>: that one really is refused, and a dead link is worse than no link.
  await expect(shortcuts.locator('a')).toHaveCount(0);

  const opened = context.waitForEvent('page');
  await shortcuts.getByRole('button', { name: /shortcuts page/ }).click();
  const tab = await opened;
  expect(tab.url()).toBe('chrome://extensions/shortcuts');
  await tab.close();
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

test('drags a folder onto another folder in the sidebar, and deletes one with the keyboard', async () => {
  // The sidebar used to be a drop *target* only: a bookmark could be dragged into a folder, but a
  // folder could not be dragged anywhere, and the tree's keyboard did five arrow keys and nothing
  // else. Both are asserted here, because both are what "the same as the middle panel" means.
  const page = await openPage('manager.html');

  for (const name of ['Outer nest', 'Inner nest', 'Doomed folder']) {
    await page.getByRole('button', { name: 'New folder' }).click();
    await page.getByLabel('Folder name').fill(name);
    await page.getByRole('button', { name: 'Create folder' }).click();
    await expect(page.getByRole('treeitem', { name: new RegExp(name) })).toBeVisible();
    // Creating a folder puts the scope inside nothing, but the next one is created in the current
    // scope — so back to the top level, or these would nest themselves.
    await page.getByRole('button', { name: 'All bookmarks' }).click();
  }

  // A treeitem's accessible name is all of its descendant text, so once one folder is inside
  // another `getByRole('treeitem', { name: /Inner/ })` matches the ancestor too. This picks the
  // folder whose *own* row carries the title.
  const treeItem = (title: string): Locator =>
    page.locator(`.vm-tree-item:has(> .vm-tree-row > .vm-tree-title:text-is("${title}"))`);

  const outer = treeItem('Outer nest');
  const inner = treeItem('Inner nest');

  // The row is the draggable element, not the `li`: an expanded folder's `li` contains its
  // children's rows, so the handle has to be the row or a grab on a child would drag the parent.
  await dragOnto(page, inner.locator('.vm-tree-row'), outer.locator('.vm-tree-row'));
  await expect(page.getByText('Moved 1 item.')).toBeVisible();

  // Inside now, which means out of sight until its new parent is opened — a collapsed subtree is
  // not in the DOM at all, which is exactly what makes the tree's arrow keys work.
  await expect(inner).toHaveCount(0);
  await expect(outer).toHaveAttribute('aria-expanded', 'false');
  await outer.locator('> .vm-tree-row > .vm-twisty').click();
  await expect(inner).toHaveAttribute('aria-level', '2');

  // ---------------------------------------------------------------- Delete, from the tree
  const doomed = treeItem('Doomed folder');
  await doomed.click();
  await doomed.focus();
  await page.keyboard.press('Delete');

  // The same question the detail pane asks, because it is the same code path: a folder deleted with
  // a confirmation in one pane and without one in the other would be two products.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Delete “Doomed folder”?');
  await dialog.getByRole('button', { name: 'Keep them, one level up' }).click();

  await expect(doomed).toHaveCount(0);
  await expect(page.locator('#vm-status .vm-notice--danger')).toHaveCount(0);
  await page.close();
});


/**
 * Toolbar appearance (§16): the picture and the tooltip on the toolbar button.
 *
 * `chrome.action` has getters for a badge and none for an icon, so the assertion is on the call
 * itself, recorded inside the service worker the way `thumbs.spec.ts` records injections. That is
 * also the right thing to assert: the property is that **every declared size** is handed over, and a
 * screenshot of a toolbar button would not distinguish "all four" from "the 16 and a guess".
 *
 * The other half of the test is the sentence under the controls. It says what does *not* change —
 * the name, the address, the Store listing — and it is load-bearing rather than decorative: someone
 * who reads this section as a way to hide the extension and acts on that belief is worse off than
 * someone who never found it. So a build that drops it fails here.
 */
test('choosing a toolbar icon reaches chrome.action, at every size the manifest declares', async () => {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(() => {
    const target = globalThis as unknown as { __vmIcons?: unknown[]; chrome: typeof chrome };
    target.__vmIcons = [];
    const real = target.chrome.action.setIcon.bind(target.chrome.action);
    target.chrome.action.setIcon = (details: chrome.action.TabIconDetails) => {
      target.__vmIcons?.push(details.path);
      return real(details);
    };
  });

  const page = await openPage('manager.html');
  await page.getByRole('button', { name: 'Settings' }).click();

  const section = page
    .locator('.vm-settings-section')
    .filter({ has: page.getByRole('heading', { name: 'Toolbar appearance' }) });
  await expect(section).toContainText('still called VaultaMark');
  await expect(section).toContainText('fixed when the extension is built');

  await section.getByRole('radio', { name: 'Folder' }).check();

  await expect
    .poll(async () =>
      worker.evaluate(() => (globalThis as unknown as { __vmIcons?: unknown[] }).__vmIcons ?? []),
    )
    .toContainEqual({
      16: 'icons/folder16.png',
      32: 'icons/folder32.png',
      48: 'icons/folder48.png',
      128: 'icons/folder128.png',
    });

  // The tooltip is the other half, and the empty field is a value: it means "keep the shipped one".
  await section.getByLabel('Tooltip').fill('Reading list');
  await section.getByLabel('Tooltip').blur();
  await expect
    .poll(async () => page.evaluate(async () => (await chrome.storage.local.get('vm.settings'))['vm.settings']))
    .toMatchObject({ toolbarIcon: 'folder', toolbarTitle: 'Reading list' });

  // And it survives the trip back — a reload rebuilds this screen from `vm.settings`, which is the
  // same read the worker does after a restart.
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(section.getByRole('radio', { name: 'Folder' })).toBeChecked();
  await expect(section.getByLabel('Tooltip')).toHaveValue('Reading list');

  // Put it back, so the specs after this one meet the extension they expect.
  await section.getByRole('radio', { name: 'VaultaMark' }).check();
  await section.getByLabel('Tooltip').fill('');
  await section.getByLabel('Tooltip').blur();
  await page.close();
});

/**
 * "Show QR code" (§17), against the real canvas and the real vendored encoder.
 *
 * The size is asserted rather than the existence of a canvas, because every number in it is a
 * decision: 29 modules is version 3, which is what a 37-byte address at level L comes to; the eight
 * extra are the quiet zone, four a side, and a symbol without one is the commonest reason a phone
 * sees nothing; and seven is `floor(264 / 37)`, the whole-pixel module size. A regression in any of
 * the three still draws something that looks like a QR code.
 *
 * What no test here can do is scan it. `test/unit/ui/qr.test.ts` reads the symbol back with an
 * independent decoder, and a real phone is the maintainer's pass (DEVELOPMENT §5.6).
 */
test('draws one bookmark’s address as a QR code, and only when asked', async () => {
  const page = await openPage('manager.html');
  await row(page, 'Lattice reduction').click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

  // Nothing is drawn until the button is pressed: a QR sitting in the pane is a plaintext address
  // on screen for anyone who glances at the monitor, which is the case the product exists for.
  await expect(page.locator('canvas')).toHaveCount(0);

  await page.getByRole('button', { name: 'Show QR code' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const canvas = dialog.getByRole('img', { name: "QR code of this bookmark's address" });
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('width', String((29 + 8) * 7));
  await expect(canvas).toHaveAttribute('height', String((29 + 8) * 7));

  // The symbol is drawn, not merely sized: a canvas nothing painted reads back as transparent
  // black, and its top-left corner is inside the quiet zone, which must be white.
  const corner = await canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    return [...(context?.getImageData(2, 2, 1, 1).data ?? [])];
  });
  expect(corner).toEqual([255, 255, 255, 255]);

  // And the sentence that stops anyone reading this as private on the receiving device.
  await expect(dialog).toContainText('ordinary tab');

  await expectNoA11yViolations(page, 'the QR code dialog');
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await page.close();
});

/**
 * A locked vault offers no QR code, because it offers no detail pane at all.
 *
 * Worth asserting rather than reasoning about: the button reads `item.url`, which is vault content,
 * and "the pane it lives on is not built" is a property of `manager.ts`'s router that a later
 * refactor could quietly lose. The vault is put back on the way out, since every test in this file
 * shares one.
 */
test('offers no QR code while the vault is locked', async () => {
  const page = await openPage('manager.html');
  await expect(row(page, 'Lattice reduction')).toBeVisible();

  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'LOCK' }));
  await page.reload();
  await expect(page.locator('.vm-placeholder')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show QR code' })).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(0);

  await page.evaluate(
    (password) => chrome.runtime.sendMessage({ type: 'UNLOCK', password }),
    PASSWORD,
  );
  await page.reload();
  await expect(row(page, 'Lattice reduction')).toBeVisible();
  await page.close();
});

/**
 * The Phase-16 cleanup, end to end.
 *
 * Two copies of one address have to exist before the screen has anything to say, and the add path
 * refuses to make them — which is the point of the feature. So they arrive the way a real vault's
 * duplicates arrive: the tracking strip switched off, the same page saved from two mailings, and
 * the campaign parameter still in each address. The setting goes back on afterwards, because
 * turning it on is exactly what does *not* clean up what is already saved.
 *
 * Cleans up after itself. The tests in this file share one vault, and leaving two bookmarks named
 * after this one in it would be a row count somebody else's assertion has to know about.
 */
test('finds an address saved twice, removes a copy, and undoes it', async () => {
  const page = await openPage('manager.html');

  const ids = await page.evaluate(async () => {
    const add = async (url: string, title: string): Promise<string> => {
      const response: { item: { id: string } } = await chrome.runtime.sendMessage({
        type: 'ADD_URL',
        url,
        title,
      });
      return response.item.id;
    };
    await chrome.runtime.sendMessage({
      type: 'SET_SETTINGS',
      settings: { stripTrackingParams: false },
    });
    const first = await add(
      'https://dupes-e2e.invalid/report?utm_source=newsletter',
      'Quarterly report',
    );
    // Far enough apart to be a different millisecond. Copies come back oldest first and tie-break
    // on a random uuid, so two adds inside one tick would put the rows in an order that changes
    // between runs — and "the oldest is the one left alone" is exactly what this test is checking.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await add('https://dupes-e2e.invalid/report?utm_source=twitter', 'The report');
    await chrome.runtime.sendMessage({
      type: 'SET_SETTINGS',
      settings: { stripTrackingParams: true },
    });
    return [first, second];
  });
  await page.reload();

  // ---------------------------------------------------------------- the sidebar says so
  // One address, not two copies — which is the number of decisions there are to make.
  const entry = page.getByRole('button', { name: 'Duplicates' });
  await expect(entry).toContainText('1');
  await entry.click();

  // ---------------------------------------------------------------- the copies, side by side
  await expect(page.getByRole('heading', { name: 'Duplicate addresses' })).toBeVisible();
  await expect(page.locator('.vm-dupes-group')).toHaveCount(1);
  await expect(page.locator('.vm-dupes-copy')).toHaveCount(2);
  // Oldest first, and each copy's real address is shown where it differs from the heading's.
  await expect(page.locator('.vm-dupes-title')).toHaveText(['Quarterly report', 'The report']);
  await expect(page.locator('.vm-dupes-url')).toContainText('utm_source=twitter');

  await expectNoA11yViolations(page, 'the duplicates screen');

  // ---------------------------------------------------------------- nothing is ticked for you
  const remove = page.getByRole('button', { name: /^Remove \d+ ticked$/ });
  await expect(remove).toBeDisabled();
  await expect(remove).toContainText('0');

  await page.getByRole('button', { name: 'Tick all but the oldest' }).click();
  await expect(remove).toContainText('1');
  await expect(remove).toBeEnabled();
  // The oldest is the one left alone.
  await expect(page.getByRole('checkbox', { name: 'Remove Quarterly report' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Remove The report' })).toBeChecked();

  // ---------------------------------------------------------------- asked, then done, then undoable
  await remove.click();
  await expect(page.getByRole('dialog')).toContainText('Remove 1 bookmark?');
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();

  await expect(page.getByText('Deleted 1 bookmark.')).toBeVisible();
  // The screen re-read itself: one copy left is not a duplicate.
  await expect(page.getByText('No address is saved twice.')).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  // And the screen re-read itself again, because the vault under it changed back.
  await expect(page.locator('.vm-dupes-copy')).toHaveCount(2);

  // ---------------------------------------------------------------- back, and tidy up
  await page.getByRole('button', { name: 'Back to bookmarks' }).click();
  await expect(page.locator('.vm-row').first()).toBeVisible();

  await page.evaluate(
    (doomed) => chrome.runtime.sendMessage({ type: 'DELETE_ITEMS', ids: doomed }),
    ids,
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Duplicates' })).toContainText('0');

  await expect(page.locator('#vm-status .vm-notice--danger')).toHaveCount(0);
  expect(requests).toEqual([]);

  await page.close();
});
