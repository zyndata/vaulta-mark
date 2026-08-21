/**
 * Does the popup still fit when the words get longer? (PLAN Phase 18, item 2.)
 *
 * Chrome clamps a popup at 800×600 and will not scroll it for you past that, so the popup is one
 * fixed size and the screens inside it live within it. Every screen was laid out against English,
 * and English is the shortest of the languages this could ship in — German runs 30–40 % longer, and
 * the settings screen was designed when it measured 589 px of the 600 available. A translation that
 * overflows it is not a rendering glitch: the version number and the way out of the screen are the
 * things at the bottom, and losing them is losing the way back.
 *
 * **Only a browser can answer this.** The height of a paragraph is a function of the font, the
 * column, the word breaks and the wrap, and no unit test has any of those. So the measurement is
 * taken here, against the real `dist/`, in each locale, from the elements' own boxes.
 *
 * Three locales, and the third is the point:
 *
 * - **`en`** — the baseline the screen was drawn against.
 * - **`pl`** — the translation this phase ships, and the only one whose wording anybody has checked.
 *   It carries the axe pass as well: an accessible name is a translated string like any other, and
 *   an `aria-label` that came back empty is invisible to exactly the people who depend on it.
 * - **synthetic long locales**, built here by stretching every English word and installed into a
 *   throwaway copy of the package as `de`. They stand in for German, which is not shipped and would
 *   not be a fair test if it were: a real translation is only as long as its translator made it,
 *   and what this file wants to know is what happens at a length nobody chose.
 *
 * There are two of those, and the second is not padding. **×1.4 is German's own figure**, and the
 * screen passed it before Phase 18 touched anything — measured, and worth keeping as the case a
 * regression would break first. **×3 is the structural claim**: that the way out of the screen and
 * the version line are at the bottom of the popup because of how the screen is built and not
 * because the words happened to be short enough. That one fails against the pre-Phase-18 screen,
 * which is the only reason to believe either of them.
 *
 * The stretching leaves `$PLACEHOLDER$` tokens alone. Chrome validates `_locales` at load and
 * refuses a message that names a placeholder it was not given — the whole extension fails to start,
 * and it fails as a service worker that never appears rather than as an error anyone can read.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

import { expectNoA11yViolations } from './a11y.js';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

/** Chrome's own ceiling for a popup. Not ours to choose, and not negotiable. */
const POPUP_MAX = { width: 800, height: 600 };

const PASSWORD = 'correct horse battery staple';

interface Harness {
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly userDataDir: string;
  readonly packageDir: string | null;
}

/**
 * A copy of `dist/` with one extra locale in it, whose messages are English at `stretch` times.
 *
 * A copy rather than a write into `dist/`: every other spec loads the same directory, and a locale
 * left behind there would ride into `npm run zip` on the next release.
 */
async function packageWithLongLocale(tag: string, stretch: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-longlocale-'));
  await cp(DIST, dir, { recursive: true });

  const english = JSON.parse(
    await readFile(join(DIST, '_locales', 'en', 'messages.json'), 'utf8'),
  ) as Record<string, { message: string }>;

  const stretched: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(english)) {
    stretched[key] = {
      ...entry,
      // Split on the placeholders, stretch only the halves between them.
      message: entry.message
        .split(/(\$[A-Za-z_]+\$)/gu)
        .map((part, index) =>
          index % 2 === 1
            ? part
            : part.replace(/[A-Za-z]{3,}/gu, (word) =>
                word + 'x'.repeat(Math.round(word.length * (stretch - 1))),
              ),
        )
        .join(''),
    };
  }

  await mkdir(join(dir, '_locales', tag), { recursive: true });
  await writeFile(join(dir, '_locales', tag, 'messages.json'), JSON.stringify(stretched), 'utf8');
  return dir;
}

async function launch(language: string, packageDir: string | null): Promise<Harness> {
  const load = packageDir ?? DIST;
  const userDataDir = await mkdtemp(join(tmpdir(), `vaultamark-e2e-fit-${language}-`));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // See lock.spec.ts: the default headless build does not run extensions at all.
    channel: 'chromium',
    headless: true,
    // `--lang` picks the `_locales` directory: it is the browser's *application* locale.
    args: [`--disable-extensions-except=${load}`, `--load-extension=${load}`, `--lang=${language}`],
    // And `locale` is what a page reports for `chrome.i18n.getUILanguage()`, which `plural()`
    // resolves into the locale it asks `Intl.PluralRules` about. Playwright emulates `en-US` unless
    // told otherwise, so setting only `--lang` gives a browser rendering one language and reporting
    // another — see locale-fallback.spec.ts, which was measured wrong by exactly that.
    locale: language,
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, extensionId: new URL(worker.url()).host, userDataDir, packageDir };
}

async function shutDown(harness: Harness): Promise<void> {
  await harness.context.close();
  await rm(harness.userDataDir, { recursive: true, force: true });
  if (harness.packageDir !== null) await rm(harness.packageDir, { recursive: true, force: true });
}

/**
 * Create the vault and land on the settings screen, in whatever language the browser is in.
 *
 * Every label here is a translated string, so nothing is found by its text: the create form is
 * three inputs in a fixed order and the settings screen is behind the last button in the footer.
 * The typed confirmation phrase is read out of the locale for the same reason — it is a sentence,
 * and in the synthetic locale it is a stretched one.
 */
async function settingsScreen(harness: Harness): Promise<Page> {
  const page = await harness.context.newPage();
  await page.goto(`chrome-extension://${harness.extensionId}/popup.html`);

  const passwords = page.locator('#vm-root input[type="password"]');
  await passwords.first().waitFor();
  await passwords.nth(0).fill(PASSWORD);
  await passwords.nth(1).fill(PASSWORD);
  const phrase = await page.evaluate(() => chrome.i18n.getMessage('createConfirmPhrase'));
  await page.locator('#vm-root input[type="text"]').last().fill(phrase);
  await page.locator('#vm-root form button[type="submit"]').click();

  await page.locator('.vm-footer').waitFor();
  await page.locator('.vm-footer button').last().click();
  await page.locator('.vm-settings-screen').waitFor();
  return page;
}

/** Every measurement this file makes, taken from the live boxes in one pass. */
async function measure(page: Page) {
  return await page.evaluate(() => {
    const root = document.getElementById('vm-root');
    const body = document.body.getBoundingClientRect();
    const screen = document.querySelector('.vm-settings-screen');
    const door = document.querySelector('.vm-settings-more button');
    const version = document.querySelector('.vm-version-line');
    if (root === null || screen === null || door === null || version === null)
      throw new Error('The settings screen is not on the page.');

    const within = (element: Element): boolean => {
      const box = element.getBoundingClientRect();
      const inside = root.getBoundingClientRect();
      return box.top >= inside.top - 1 && box.bottom <= inside.bottom + 1;
    };

    return {
      bodyWidth: body.width,
      bodyHeight: body.height,
      // The popup itself must never be the thing that scrolls: Chrome scrolls it as one document,
      // header and all, and only past 600 px — by which point the screen is already broken.
      rootScrollHeight: root.scrollHeight,
      rootClientHeight: root.clientHeight,
      rootScrollWidth: root.scrollWidth,
      rootClientWidth: root.clientWidth,
      doorVisible: within(door),
      versionVisible: within(version),
      sample: screen.textContent.slice(0, 40),
    };
  });
}

/** The whole assertion, so the three locales cannot drift into checking different things. */
function expectItFits(m: Awaited<ReturnType<typeof measure>>, where: string): void {
  expect(m.bodyHeight, `${where}: the popup is taller than Chrome will show`).toBeLessThanOrEqual(
    POPUP_MAX.height,
  );
  expect(m.bodyWidth, `${where}: the popup is wider than Chrome will show`).toBeLessThanOrEqual(
    POPUP_MAX.width,
  );
  expect(m.rootScrollHeight, `${where}: the popup itself scrolls vertically`).toBeLessThanOrEqual(
    m.rootClientHeight,
  );
  expect(m.rootScrollWidth, `${where}: the popup itself scrolls sideways`).toBeLessThanOrEqual(
    m.rootClientWidth,
  );
  // The two things at the bottom of the screen, and the two that a screen which overflowed would
  // lose first. One of them is the way back to the rest of the settings.
  expect(m.doorVisible, `${where}: the way out of the settings screen is below the fold`).toBe(true);
  expect(m.versionVisible, `${where}: the version line is below the fold`).toBe(true);
}

test.describe('the popup settings screen fits Chrome, in every locale', () => {
  test('in English', async () => {
    const harness = await launch('en-US', null);
    try {
      expectItFits(await measure(await settingsScreen(harness)), 'en');
    } finally {
      await shutDown(harness);
    }
  });

  test('in Polish, which is a real translation and gets the axe pass too', async () => {
    const harness = await launch('pl', null);
    try {
      const page = await settingsScreen(harness);
      const m = await measure(page);
      // The browser is genuinely reading `_locales/pl` — otherwise this measures English twice.
      expect(m.sample).toContain('Ustawienia');
      expectItFits(m, 'pl');

      /*
       * The axe pass, in Polish (PLAN Phase 18: "an `aria-label` is a translated string too").
       *
       * The English passes live in popup.spec.ts and manager.spec.ts and are not repeated here.
       * What is different about a second locale is that every accessible name on the screen is a
       * different string: a label that was translated as an empty string, or a `lang` that says
       * `en` over Polish text, is a defect this run can see and the English one cannot.
       */
      await expectNoA11yViolations(page, 'the popup settings screen, in Polish');
    } finally {
      await shutDown(harness);
    }
  });

  // Nothing in `dist/` is touched: the stretched locale goes into a copy, and the copy is removed
  // whether the assertions pass or not.
  for (const stretch of [1.4, 3]) {
    test(`in a language ${String(Math.round((stretch - 1) * 100))} % longer than English`, async () => {
      const harness = await launch('de', await packageWithLongLocale('de', stretch));
      try {
        const m = await measure(await settingsScreen(harness));
        // Proof the browser is reading the synthetic locale and not falling back to English —
        // without it, a `--lang` Chrome ignored would make this test pass by testing nothing.
        expect(m.sample).toContain('xx');
        expectItFits(m, `the synthetic locale at ×${String(stretch)}`);
      } finally {
        await shutDown(harness);
      }
    });
  }
});
