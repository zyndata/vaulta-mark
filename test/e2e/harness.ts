/**
 * The Chromium arguments every extension spec launches with.
 *
 * Two of the three are the obvious ones: an MV3 extension needs `--load-extension` against a built
 * `dist/`, and `--disable-extensions-except` so nothing else is in the profile.
 *
 * **The third is `--lang`, and it is here because the suite silently depended on the machine.**
 * `--lang` sets the browser's *application* locale, which is what decides which
 * `_locales/<tag>/messages.json` Chrome renders — and left unset it comes from the operating
 * system. That was invisible while `en` was the only locale in the package: every machine got
 * English because English was all there was. The moment Phase 18 added `_locales/pl`, the whole
 * suite went red on a Polish-language computer and stayed green in CI, which runs on an English
 * one. Every assertion in these specs names an English sentence, so pinning the language is what
 * makes them a test of the product rather than a test of the developer's Windows settings.
 *
 * The other half of the same pin is `locale` in `playwright.config.ts`. They are different
 * switches: `--lang` picks the `messages.json`, and Playwright's `locale` decides what a page gets
 * back from `chrome.i18n.getUILanguage()` — which `src/ui/plural.ts` resolves into the locale it
 * asks `Intl.PluralRules` about. Setting one and not the other produces a browser rendering one
 * language while reporting another, which is not a state a real browser can be in.
 *
 * `locale-fit.spec.ts` and `locale-fallback.spec.ts` are about other languages and pass their own
 * values to both; everything else takes the defaults here.
 */

/** The language every spec but the localisation ones runs in. Matches `use.locale` in the config. */
export const E2E_LANGUAGE = 'en-US';

/** Launch arguments for a persistent context carrying the built extension. */
export function extensionArgs(dist: string, language: string = E2E_LANGUAGE): string[] {
  return [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    `--lang=${language}`,
  ];
}
