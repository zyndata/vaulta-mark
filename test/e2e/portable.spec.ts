/**
 * Import and export in a real Chromium, against the real built extension.
 *
 * The journey this covers is the one nothing else can: a file actually leaving the browser and
 * coming back. Everything up to `FILE` is asserted in the unit suites; what needs a browser is the
 * object-URL download, the file input, the typed gate in front of the plaintext export, and the fact
 * that the whole of it works with **no `downloads` permission** in the manifest.
 *
 * Two harness limits shape it, both familiar from the other specs:
 *
 * - Playwright cannot grant `activeTab`, so bookmarks are vaulted through `ADD_URL`.
 * - A download triggered by a synthetic `<a download>` click inside an extension page is awkward to
 *   intercept, so the file's *contents* are captured by stubbing `URL.createObjectURL` — which is
 *   also the one line of the delivery path worth pinning, since it is what the `downloads`
 *   permission would otherwise have been needed for.
 *
 * The native-bookmark half is deliberately not driven here: `chrome.permissions.request` needs a
 * real user gesture on a browser-level prompt that Playwright cannot answer. It is covered against
 * a mocked `chrome.bookmarks` in `test/unit/import/native-bookmarks.test.ts`, and PLAN §9 asks for
 * the real-profile check to be done by hand and written up in the commit.
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

const PASSWORD = 'correct horse battery staple';
const CONFIRM_PHRASE = 'I understand';
const EXPORT_PHRASE = 'EXPORT UNENCRYPTED';
const REPLACE_PHRASE = 'REPLACE MY VAULT';

const PAGES: readonly (readonly [string, string])[] = [
  ['https://vaultamark-io.invalid/risotto', 'Mushroom risotto, properly'],
  ['https://vaultamark-io.invalid/bread', 'Overnight bread'],
];

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;
let scratch: string;

async function openPage(path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  return page;
}

async function vault(page: Page, url: string, title: string): Promise<void> {
  await page.evaluate(
    ([u, t]) => chrome.runtime.sendMessage({ type: 'ADD_URL', url: u, title: t }),
    [url, title],
  );
}

/**
 * Capture what the page hands to `URL.createObjectURL`, instead of downloading it.
 *
 * This is the delivery path itself (`manager/io.ts`): a Blob, an object URL, a synthetic click, and
 * a revoke in the same turn. Stubbing the first step reads the bytes and proves the last one — the
 * page never reaches for `chrome.downloads`, which it does not have.
 */
async function captureDownload(page: Page): Promise<void> {
  await page.evaluate(() => {
    const captured: { text: string; revoked: boolean } = { text: '', revoked: false };
    (window as unknown as { __captured: typeof captured }).__captured = captured;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob): string => {
      void blob.text().then((text) => (captured.text = text));
      return create(blob);
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string): void => {
      captured.revoked = true;
      revoke(url);
    };
  });
}

async function capturedFile(page: Page): Promise<{ text: string; revoked: boolean }> {
  await expect
    .poll(async () =>
      page.evaluate(() => (window as unknown as { __captured: { text: string } }).__captured.text.length),
    )
    .toBeGreaterThan(0);
  return await page.evaluate(
    () => (window as unknown as { __captured: { text: string; revoked: boolean } }).__captured,
  );
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-io-'));
  scratch = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-files-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // The default headless build does not run extensions at all — see lock.spec.ts.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });

  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;

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
  await rm(scratch, { recursive: true, force: true });
});

test('backs the vault up and restores it from the file', async () => {
  const page = await openPage('manager.html');
  await expect(page.locator('.vm-row').filter({ hasText: 'Mushroom risotto' })).toBeVisible();

  // ---------------------------------------------------------------- export
  await captureDownload(page);
  await page.getByRole('button', { name: 'Import & export' }).click();
  await page.getByRole('button', { name: 'Save a backup…' }).click();

  // Scoped to the dialog throughout: the section behind it carries the same heading and the same
  // button label, which is right for a reader and ambiguous for a locator.
  const backup = page.getByRole('dialog');
  await expect(backup.getByRole('heading', { name: 'Back up the vault' })).toBeVisible();
  await backup.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await backup.getByRole('button', { name: 'Save a backup…' }).click();

  const saved = await capturedFile(page);
  expect(saved.revoked).toBe(true);
  const parsed = JSON.parse(saved.text) as { magic: string; payload: string };
  expect(parsed.magic).toBe('VAULTAMARK-EXPORT');
  // The whole point: nothing legible in the file.
  expect(saved.text).not.toContain('risotto');
  expect(saved.text).not.toContain('vaultamark-io.invalid');

  // ---------------------------------------------------------------- delete a bookmark
  await page.getByRole('button', { name: 'Back to bookmarks' }).click();
  const doomed = page.locator('.vm-row').filter({ hasText: 'Overnight bread' });
  await doomed.click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(doomed).toHaveCount(0);

  // ---------------------------------------------------------------- import it back
  const file = join(scratch, 'backup.vmv');
  await writeFile(file, saved.text, 'utf8');

  await page.getByRole('button', { name: 'Import & export' }).click();
  await page.getByLabel('Backup file').setInputFiles(file);

  const open = page.getByRole('dialog');
  await expect(open.getByRole('heading', { name: 'Open the backup' })).toBeVisible();
  await open.getByLabel('Backup password').fill(PASSWORD);
  await open.getByRole('button', { name: 'Open', exact: true }).click();

  const preview = page.getByRole('dialog');
  await expect(preview.getByRole('heading', { name: 'What is in this backup' })).toBeVisible();
  await expect(preview.getByText('2 bookmarks in 0 folders.')).toBeVisible();

  // **Replace**, not merge, because this is a restore.
  //
  // Merging the backup back in would not bring the deleted bookmark back and should not: the file
  // says it is alive, this vault says it was deleted, and the merge engine calls that a conflict for
  // the user to settle rather than silently undoing a deletion (§6.4). Replace is the mode that
  // means "this file is the vault now" — and it is the one behind the two gates.
  await preview.getByLabel('Replace this vault entirely').check();
  await preview.getByRole('button', { name: 'Continue' }).click();

  const first = page.getByRole('dialog');
  await expect(first.getByRole('heading', { name: 'Replace the whole vault?' })).toBeVisible();
  await first.getByLabel('Type the phrase to continue').fill(REPLACE_PHRASE);
  await first.getByRole('button', { name: 'Continue' }).click();

  const second = page.getByRole('dialog');
  await expect(second.getByRole('heading', { name: 'Last chance' })).toBeVisible();
  await second.getByRole('button', { name: 'Replace the vault' }).click();

  // The 24-hour undo is offered as soon as the replace lands.
  await expect(page.getByRole('button', { name: 'Undo the import' })).toBeVisible();

  await page.getByRole('button', { name: 'Back to bookmarks' }).click();
  // The backup is the vault again — including the bookmark deleted after it was taken.
  await expect(page.locator('.vm-row').filter({ hasText: 'Overnight bread' })).toBeVisible();
  await expect(page.locator('.vm-row').filter({ hasText: 'Mushroom risotto' })).toBeVisible();
});

test('will not produce the plaintext file without the typed phrase', async () => {
  const page = await openPage('manager.html');
  await captureDownload(page);
  await page.getByRole('button', { name: 'Import & export' }).click();
  await page.getByRole('button', { name: 'Export unencrypted…' }).click();

  const gate = page.getByRole('dialog');
  await expect(gate.getByRole('heading', { name: 'This file will not be encrypted' })).toBeVisible();

  // Pressing the button with the box empty does nothing but complain.
  await gate.getByRole('button', { name: 'Save the unencrypted file' }).click();
  await expect(gate.getByRole('alert')).toBeVisible();
  await expect(gate.getByRole('heading', { name: 'This file will not be encrypted' })).toBeVisible();

  // A near miss does not open it either.
  await gate.getByLabel('Type the phrase to continue').fill('export');
  await gate.getByRole('button', { name: 'Save the unencrypted file' }).click();
  await expect(gate.getByRole('heading', { name: 'This file will not be encrypted' })).toBeVisible();

  // Nothing has been produced up to this point.
  expect(await page.evaluate(() => (window as unknown as { __captured: { text: string } }).__captured.text)).toBe('');

  // And with the phrase, it is.
  await gate.getByLabel('Type the phrase to continue').fill(EXPORT_PHRASE);
  await gate.getByRole('button', { name: 'Save the unencrypted file' }).click();

  const saved = await capturedFile(page);
  expect(saved.text).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
  expect(saved.text).toContain('WARNING');
  // It is the plaintext file it warned about — the URLs really are in there.
  expect(saved.text).toContain('vaultamark-io.invalid');
});
