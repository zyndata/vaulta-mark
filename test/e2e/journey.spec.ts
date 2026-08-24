/**
 * The whole arc, in one profile, in order (PLAN §9 Phase 12).
 *
 * The other seven specs each prove one area in depth and each starts from a vault someone else's
 * `beforeAll` created. This one starts from an empty Chrome profile and does not reset: first run,
 * setup, a vault, bookmarks, organising them, opening one, locking, unlocking, a backup, a restore,
 * and the vault arriving in the sync area as ciphertext — each step standing on the state the last
 * one left. **That composition is the thing it adds.** Every individual link is proven elsewhere;
 * what nothing else asserts is that they chain, in a profile that has only ever done this once.
 *
 * INV-4 is asserted over the whole of it: every http(s) request the context makes is recorded and
 * aborted, and the count at the end must be zero. Not one favicon, not one font, not one beacon,
 * across a complete session with a Drive-less vault.
 *
 * ## What is out of reach here, and where it is covered instead
 *
 * PLAN's journey list names four things this harness cannot drive, all for reasons the other specs
 * document at length. They are named here rather than quietly skipped:
 *
 * - **Two of the four add entry points.** The toolbar button and the keyboard command are browser
 *   chrome, and Playwright drives pages. So `activeTab` is never granted, and "Add this page" is
 *   exercised for its *failure* — which must be an explanation, not silence. The succeeding path is
 *   `test/integration/add-and-open.test.ts`; the command dispatch is `test/unit/background/
 *   commands.test.ts`.
 * - **A real incognito window.** A persistent context has no incognito profile, so opening is
 *   asserted through a recorder installed over `chrome.windows.create` in the service worker,
 *   exactly as PLAN Phase 5 prescribes.
 * - **Connecting Drive.** It needs `chrome.identity` to answer and `chrome.permissions.request` to
 *   be accepted at a browser-level prompt; neither is reachable. The provider is proven against a
 *   mocked Drive in `test/integration/two-device-drive.test.ts` and `provider-migration.test.ts`,
 *   over the same `SyncProvider` interface the real one implements, and the last mile is the
 *   maintainer's manual pass (DEVELOPMENT §5.4). What *is* asserted here is the sync tier that
 *   needs no account: the vault reaching `chrome.storage.sync` as ciphertext.
 * - **Conflict resolution and thumbnails** have specs of their own (`portable.spec.ts`,
 *   `thumbs.spec.ts`) that build the divergence and the image they need. Reproducing either here
 *   would be a slower copy of a better test.
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

import { extensionArgs } from './harness.js';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

const PASSWORD = 'correct horse battery staple';
const CONFIRM_PHRASE = 'I understand';

/** `.invalid` is reserved and unresolvable, so a request for one could only ever be ours. */
const PAGES: readonly (readonly [string, string])[] = [
  ['https://journey-e2e.invalid/risotto', 'Mushroom risotto, properly'],
  ['https://journey-e2e.invalid/bread', 'Overnight bread'],
  ['https://elsewhere-e2e.invalid/lattice', 'Lattice reduction in practice'],
];

let context: BrowserContext;
let userDataDir: string;
let scratch: string;
let extensionId: string;
/** Every http(s) request anything in this context tried to make. Must stay empty (INV-4). */
const requests: string[] = [];

async function worker(): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

async function openPage(path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  return page;
}

/** Vault a URL through the context-menu entry point — the one an extension page can drive. */
async function vault(page: Page, url: string, title: string): Promise<void> {
  await page.evaluate(
    ([u, t]) => chrome.runtime.sendMessage({ type: 'ADD_URL', url: u, title: t }),
    [url, title],
  );
}

function row(page: Page, title: string) {
  return page.locator('.vm-row').filter({ hasText: title });
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-journey-'));
  scratch = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-journey-files-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // See lock.spec.ts: the default headless build does not run extensions at all.
    channel: 'chromium',
    headless: true,
    args: extensionArgs(DIST),
  });

  // INV-4, enforced rather than observed: anything reaching for the network is recorded and
  // aborted, so a regression fails an assertion instead of quietly succeeding over the wire.
  for (const pattern of ['http://**', 'https://**']) {
    await context.route(pattern, (route) => {
      requests.push(route.request().url());
      return route.abort();
    });
  }

  extensionId = new URL((await worker()).url()).host;
});

test.afterAll(async () => {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

test('a fresh profile, from first run to a restored backup, without touching the network', async () => {
  test.setTimeout(180_000);

  /* ---------------------------------------------------------- 1. first run and setup */

  // The install tab cannot be observed — `onInstalled` fires before Playwright has a listener
  // attached — so the flow is driven at the URL that tab opens, which is the part that matters.
  const setup = await openPage('manager.html?onboarding=1');
  await expect(setup.getByText('Step 1 of 5')).toBeVisible();
  await setup.getByRole('button', { name: 'Next' }).click();

  await setup.getByLabel('Master password').fill(PASSWORD);
  await setup.getByLabel('Repeat the password').fill(PASSWORD);
  await setup.getByLabel('Type the phrase to confirm').fill(CONFIRM_PHRASE);
  await setup.getByRole('button', { name: 'Create vault' }).click();

  // Creating the vault carries the flow forward on its own: the thing the user came for happened.
  await expect(setup.getByText('Step 3 of 5')).toBeVisible();
  await setup.getByRole('button', { name: 'Next' }).click();
  await setup.getByRole('button', { name: 'Next' }).click();
  // Incognito is the last screen — ticking its checkbox reloads the extension and closes this tab,
  // so nothing may follow it. Skipping from there finishes setup rather than advancing.
  await expect(setup.getByText('Step 5 of 5')).toBeVisible();
  await setup.getByRole('button', { name: 'Skip for now' }).click();

  // Finishing lands on the manager, with a vault that really exists.
  await expect(setup.getByRole('button', { name: 'New folder' })).toBeVisible();
  await setup.close();

  // And it never comes back: this is the whole of "once, on install".
  const again = await openPage('manager.html?onboarding=1');
  await expect(again.getByText('Step 1 of 5')).toHaveCount(0);
  await expect(again.getByRole('button', { name: 'New folder' })).toBeVisible();
  await again.close();

  /* ---------------------------------------------------------- 2. adding */

  const popup = await openPage('popup.html');
  await expect(popup.getByText(/Nothing in the vault yet/)).toBeVisible();

  // No toolbar click means no `activeTab` grant, so the worker cannot read a tab — and a dead
  // button is how someone concludes the extension is broken. It has to say so.
  await popup.getByRole('button', { name: 'Add this page' }).click();
  await expect(popup.getByText('There is no page to add here.')).toBeVisible();

  for (const [url, title] of PAGES) await vault(popup, url, title);
  await popup.close();

  /* ---------------------------------------------------------- 3. organising */

  const page = await openPage('manager.html');
  await expect(row(page, 'Mushroom risotto')).toBeVisible();

  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Cooking');
  await page.getByRole('button', { name: 'Create folder' }).click();
  const cooking = page.getByRole('treeitem', { name: /Cooking/ });
  await expect(cooking).toBeVisible();

  // Tag one, from the detail pane it landed in.
  await row(page, 'Mushroom risotto').click();
  await page.getByRole('textbox', { name: 'Tags' }).fill('recipes');
  await page.getByRole('textbox', { name: 'Tags' }).press('Enter');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: /Show bookmarks tagged recipes/ })).toBeVisible();

  // Search narrows the list, and says why each result is one.
  await page.getByLabel('Search your vault').fill('risotto');
  await expect(row(page, 'Overnight bread')).toHaveCount(0);
  await expect(page.locator('.vm-row mark')).toHaveText('risotto');

  // The tag in the sidebar is the same question by another route.
  await page.getByLabel('Search your vault').fill('');
  await page.getByRole('button', { name: /Show bookmarks tagged recipes/ }).click();
  await expect(row(page, 'Mushroom risotto')).toBeVisible();
  await expect(row(page, 'Overnight bread')).toHaveCount(0);

  // Move both recipes into the folder in one batch, then read them back inside it.
  await page.getByRole('button', { name: 'All bookmarks' }).click();
  await expect(row(page, 'Overnight bread')).toBeVisible();
  await row(page, 'Mushroom risotto').click();
  await row(page, 'Overnight bread').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByText('2 selected')).toBeVisible();

  await page.getByRole('button', { name: 'Move to…' }).click();
  await page.getByLabel('Move to a folder').selectOption({ label: 'Cooking' });
  await page.getByRole('button', { name: 'Move here' }).click();

  await cooking.click();
  await expect(row(page, 'Mushroom risotto')).toBeVisible();
  await expect(row(page, 'Overnight bread')).toBeVisible();

  /* ---------------------------------------------------------- 4. opening one */

  const sw = await worker();
  await sw.evaluate(() => {
    const target = globalThis as unknown as { __vmWindows?: unknown[]; chrome: typeof chrome };
    target.__vmWindows = [];
    target.chrome.windows.create = (options?: unknown) => {
      target.__vmWindows?.push(options);
      return Promise.resolve({ id: 99, incognito: true } as chrome.windows.Window);
    };
  });

  /*
   * "Allow in Incognito" was skipped during setup, so this profile is in the state the whole
   * product is built around: opening sends the user to the guided prompt and opens nothing.
   *
   * The manager reaches that prompt by navigating **this** tab (`location.hash` plus a reload —
   * the router runs at the top of `manager.ts`), where the popup opens it in a new one. Two
   * surfaces, one screen; waiting for a new page here would wait forever.
   */
  await row(page, 'Mushroom risotto').dblclick();
  await expect(page.getByRole('button', { name: 'Open that page' })).toBeVisible();
  expect(
    await sw.evaluate(() => (globalThis as unknown as { __vmWindows?: unknown[] }).__vmWindows ?? []),
  ).toEqual([]);

  // The labelled fallback is the only thing that opens a normal window, and only when pressed.
  await page.getByRole('button', { name: 'Open in a normal window' }).click();
  await expect
    .poll(async () =>
      sw.evaluate(() => (globalThis as unknown as { __vmWindows?: unknown[] }).__vmWindows ?? []),
    )
    .toEqual([{ url: PAGES[0]![0], focused: true }]);

  // Back to the manager: the prompt replaced the page, so the hash has to go with it.
  await page.goto(`chrome-extension://${extensionId}/manager.html`);
  await expect(page.getByRole('button', { name: 'New folder' })).toBeVisible();

  /* ---------------------------------------------------------- 5. locking and unlocking */

  await page.getByRole('button', { name: 'Lock' }).click();
  // The manager has nothing to show a shut vault, and deliberately does not offer to unlock it.
  await expect(page.getByText(/locked/i)).toBeVisible();
  await expect(page.locator('.vm-row')).toHaveCount(0);

  const unlock = await openPage('popup.html');
  await unlock.getByLabel('Master password').fill('not the password');
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await expect(unlock.getByText(/password/i).first()).toBeVisible();

  await unlock.getByLabel('Master password').fill(PASSWORD);
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await expect(unlock.getByRole('button', { name: 'Add this page' })).toBeVisible();
  await unlock.close();

  // Everything survived the round trip, including the folder the bookmarks were moved into.
  await page.reload();
  await page.getByRole('treeitem', { name: /Cooking/ }).click();
  await expect(page.locator('.vm-row')).toHaveCount(2);

  /* ---------------------------------------------------------- 6. a backup, and a restore */

  await page.evaluate(() => {
    const captured = { text: '' };
    (window as unknown as { __captured: typeof captured }).__captured = captured;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob): string => {
      void blob.text().then((text) => (captured.text = text));
      return create(blob);
    };
  });

  await page.getByRole('button', { name: 'Import & export' }).click();
  await page.getByRole('button', { name: 'Save a backup…' }).click();
  const backup = page.getByRole('dialog');
  await backup.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await backup.getByRole('button', { name: 'Save a backup…' }).click();

  await expect
    .poll(async () =>
      page.evaluate(
        () => (window as unknown as { __captured: { text: string } }).__captured.text.length,
      ),
    )
    .toBeGreaterThan(0);
  const saved = await page.evaluate(
    () => (window as unknown as { __captured: { text: string } }).__captured.text,
  );

  // The file is the vault and reveals nothing about it.
  expect(saved).not.toContain('risotto');
  expect(saved).not.toContain('journey-e2e.invalid');
  expect(saved).not.toContain('Cooking');

  // Delete one, then bring the whole vault back from the file.
  await page.getByRole('button', { name: 'Back to bookmarks' }).click();
  await page.getByRole('button', { name: 'All bookmarks' }).click();
  await row(page, 'Lattice reduction').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(row(page, 'Lattice reduction')).toHaveCount(0);

  const file = join(scratch, 'journey.vmv');
  await writeFile(file, saved, 'utf8');

  await page.getByRole('button', { name: 'Import & export' }).click();
  await page.getByLabel('Backup file').setInputFiles(file);
  const open = page.getByRole('dialog');
  await open.getByLabel('Backup password').fill(PASSWORD);
  await open.getByRole('button', { name: 'Open', exact: true }).click();

  const preview = page.getByRole('dialog');
  await expect(preview.getByRole('heading', { name: 'What is in this backup' })).toBeVisible();
  await preview.getByLabel('Replace this vault entirely').check();
  await preview.getByRole('button', { name: 'Continue' }).click();

  const first = page.getByRole('dialog');
  await first.getByLabel('Type the phrase to continue').fill('REPLACE MY VAULT');
  await first.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Replace the vault' }).click();
  await expect(page.getByRole('button', { name: 'Undo the import' })).toBeVisible();

  await page.getByRole('button', { name: 'Back to bookmarks' }).click();
  await expect(row(page, 'Lattice reduction')).toBeVisible();

  /* ---------------------------------------------------------- 7. it reached the sync area */

  // The tier that needs no account. What matters is that the vault is *there* and is unreadable:
  // Chrome replicates the area, and the point of this tier is that the extension never speaks to
  // the network to make that happen.
  // Pressed rather than waited for: `scheduleSync` debounces three seconds and the import that
  // just landed restarted that clock, so a bare read here races it. The toolbar's status *is* the
  // sync-now button — the same one a user presses when they want to be sure.
  const control = page.locator('.vm-sync');
  await control.click();
  await expect(control).toContainText(/last synced/iu);

  const synced = await page.evaluate(async () => await chrome.storage.sync.get(null));
  const blob = JSON.stringify(synced);
  const keys = Object.keys(synced);
  expect(keys).toContain('vm.s.meta');
  expect(keys.some((key) => key.startsWith('vm.s.b'))).toBe(true);
  expect(blob).not.toContain('risotto');
  expect(blob).not.toContain('journey-e2e.invalid');
  expect(blob).not.toContain('Cooking');

  /* ---------------------------------------------------------- and not one request */

  expect(requests).toEqual([]);
  await page.close();
});
