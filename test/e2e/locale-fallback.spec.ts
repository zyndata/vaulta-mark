/**
 * What Chrome does with a key a translation has not got. (PLAN Phase 18, item 4.)
 *
 * `default_locale` is `en`, and the manifest documentation says Chrome "falls back" without saying
 * to what granularity. The difference decides something this repository has to know before it
 * invites an outside translation, which is the most common contribution an extension gets:
 *
 * - **Per message.** A locale that translates 400 of 641 keys renders as a mostly-Polish interface
 *   with English in the gaps. Imperfect, obvious, and reportable by whoever is reading it.
 * - **Per file.** The same locale renders every missing key as the **empty string** — blank labels,
 *   invisible buttons, a warning about irrecoverable passwords that says nothing at all. Not
 *   reportable, because a blank label looks like a label that was never there.
 *
 * The two are a policy apart, not a shade apart: under the first, a partial translation may be
 * merged and finished later; under the second it may never be merged at all, and
 * `scripts/verify-strings.mjs`'s parity check has to be a wall rather than a warning.
 *
 * **So it is measured, not read.** This file installs a deliberately incomplete locale into a
 * throwaway copy of the package, starts Chrome in that language, and asks `chrome.i18n` — which is
 * the only authority on the question. This repository has been wrong before about what a browser
 * does with `chrome://` URLs, in a comment that survived four phases; the difference between then
 * and now is a test.
 *
 * The answer is recorded in `docs/DEVELOPMENT.md` alongside the date it was taken.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext } from '@playwright/test';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

/** Translated in the incomplete locale. Any key with no placeholders would do. */
const TRANSLATED = 'popupLoading';

/** Left out of it. A sentence someone has to be able to read, which is the point of the check. */
const MISSING = 'createNoRecoveryBody';

/** What the incomplete locale says for the one key it does translate. */
const MARKER = 'TRANSLATED-MARKER';

let context: BrowserContext;
let userDataDir: string;
let packageDir: string;
let extensionId: string;

/**
 * A copy of `dist/` carrying a `pl` locale with exactly one key in it.
 *
 * One key rather than none: a `messages.json` Chrome refuses outright would answer every question
 * here with the same empty string as a per-file fallback, and the two would be indistinguishable.
 * The translated key proves the file was read.
 */
async function packageWithPartialLocale(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-fallback-'));
  await cp(DIST, dir, { recursive: true });

  const english = JSON.parse(
    await readFile(join(DIST, '_locales', 'en', 'messages.json'), 'utf8'),
  ) as Record<string, { message: string }>;
  if (english[TRANSLATED] === undefined || english[MISSING] === undefined)
    throw new Error('This measurement names keys that no longer exist in en/messages.json.');

  await mkdir(join(dir, '_locales', 'pl'), { recursive: true });
  await writeFile(
    join(dir, '_locales', 'pl', 'messages.json'),
    JSON.stringify({ [TRANSLATED]: { message: MARKER } }),
    'utf8',
  );
  return dir;
}

test.beforeAll(async () => {
  packageDir = await packageWithPartialLocale();
  userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-fallback-profile-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // See lock.spec.ts: the default headless build does not run extensions at all.
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${packageDir}`,
      `--load-extension=${packageDir}`,
      // `--lang` is what picks the `_locales` directory. It is the browser's *application* locale.
      '--lang=pl',
    ],
    /*
     * …and `locale` is what `chrome.i18n.getUILanguage()` answers with, which is a different thing.
     *
     * Playwright applies a context locale of `en-US` whether or not one is asked for, through
     * `Emulation.setLocaleOverride` on the page. Set only `--lang=pl` and the result is a browser
     * genuinely rendering the Polish `messages.json` while every page in it reports `en-US` — which
     * is not a state a real browser can be in, and which would have made this measurement pass
     * while `plural()` picked English's categories for Polish text. Both, together, always.
     */
    locale: 'pl-PL',
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
  await rm(packageDir, { recursive: true, force: true });
});

test('Chrome falls back to default_locale per message, not per file', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  const answers = await page.evaluate(
    ([translated, missing]) => ({
      uiLanguage: chrome.i18n.getUILanguage(),
      translated: chrome.i18n.getMessage(translated as string),
      missing: chrome.i18n.getMessage(missing as string),
      // A key no locale has. The floor: this is what "nothing found" looks like, and the missing
      // key above must not look like it.
      nonsense: chrome.i18n.getMessage('vmNoSuchKeyAnywhere'),
    }),
    [TRANSLATED, MISSING],
  );

  // The browser really is in Polish and really is reading the partial file — without both, the
  // assertion below would be a statement about English rendering English.
  expect(answers.uiLanguage.startsWith('pl'), JSON.stringify(answers)).toBe(true);
  expect(answers.translated).toBe(MARKER);

  // **The measurement.** The key the Polish file does not have comes back in English, not blank.
  const english = JSON.parse(
    await readFile(join(DIST, '_locales', 'en', 'messages.json'), 'utf8'),
  ) as Record<string, { message: string }>;
  expect(answers.missing).toBe(english[MISSING]?.message);
  expect(answers.nonsense).toBe('');
});

test('an incomplete translation leaves readable English on the screen, not blanks', async () => {
  // The consequence, on a real screen rather than through the API. The create screen carries the
  // no-recovery warning, which is the sentence in this product that must never render as nothing.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  const english = JSON.parse(
    await readFile(join(DIST, '_locales', 'en', 'messages.json'), 'utf8'),
  ) as Record<string, { message: string }>;
  const warning = english[MISSING]?.message ?? '';
  expect(warning.length).toBeGreaterThan(0);

  await expect(page.locator('#vm-root')).toContainText(warning);
  // …and the one key that *was* translated is in Polish, on the same screen's document.
  expect(await page.evaluate((key) => chrome.i18n.getMessage(key), TRANSLATED)).toBe(MARKER);
});
