/**
 * Plural agreement, which `chrome.i18n` does not have.
 *
 * `chrome.i18n.getMessage` substitutes and nothing else — no ICU MessageFormat, no `plural`
 * argument, no select. Through Phase 17 that was survivable because English has two forms and a
 * pair of whole sentences (`movedOne` / `movedCount`) expresses both. Polish has three that matter
 * to us — 1 zakładka, 2 zakładki, 5 zakładek, with 22 taking the second and 12 the third — so a
 * pair cannot be written correctly no matter what a translator puts in it. The pair is not a
 * translation problem; it is a shape the file has to stop having.
 *
 * `Intl.PluralRules` is the fix, and it costs nothing: it is in the browser (Chrome 63, well under
 * the floor of 116), so D4 — zero runtime dependencies — is untouched. It answers with a CLDR
 * category, and the category is a key suffix:
 *
 *     plural('listCountBookmarks', 5)  →  msg('listCountBookmarks_many')   // in pl
 *                                      →  msg('listCountBookmarks_other')  // in en
 *
 * **Which locale the rules are asked about is not `getUILanguage()`.** It is the locale whose
 * `messages.json` Chrome is actually rendering, which is the UI language *resolved against what we
 * ship*. Get that wrong and a Russian-language browser — for which Chrome renders our English,
 * there being no `ru` — asks `Intl.PluralRules('ru')` about 21, is told `one`, and reads the
 * English "1 bookmark" over a list of twenty-one. So the resolution below mirrors Chrome's own:
 * exact tag, then the base tag, then `default_locale`.
 *
 * A category whose key is absent falls back to `_other` rather than rendering empty. That is not
 * theoretical tidiness: it is what keeps a half-finished outside translation — the most common
 * contribution an extension gets — showing English words instead of blank labels.
 */

import { msg } from './dom.js';

/**
 * The locales with a `public/_locales/<tag>/messages.json`.
 *
 * `en` first and last: it is `default_locale`, so it is both the head of the list and where
 * {@link messageLocale} lands when nothing else matches. Adding a translation means adding it here
 * — `scripts/verify-strings.mjs` reads this list to decide which files it checks for parity, so a
 * locale directory that nobody added here is a directory nothing verifies.
 */
export const SHIPPED_LOCALES = ['en', 'pl'] as const;

export type ShippedLocale = (typeof SHIPPED_LOCALES)[number];

/** `default_locale` in the manifest. The one every fallback ends at. */
export const DEFAULT_LOCALE: ShippedLocale = 'en';

/**
 * Which `messages.json` Chrome will render for a browser UI language, out of the ones we ship.
 *
 * Chrome tries the full tag, then the language subtag, then `default_locale`. `pl-PL` and `pl_PL`
 * both arrive in practice — `getUILanguage()` returns the hyphenated form, the directory names use
 * neither — so both separators are accepted and the comparison is lowercased.
 */
export function messageLocale(
  uiLanguage: string,
  shipped: readonly string[] = SHIPPED_LOCALES,
): string {
  const tag = uiLanguage.trim().toLowerCase().replace(/_/gu, '-');
  if (shipped.includes(tag)) return tag;
  const base = tag.split('-')[0];
  if (base !== undefined && shipped.includes(base)) return base;
  return DEFAULT_LOCALE;
}

/*
 * One `Intl.PluralRules` per locale, kept.
 *
 * Constructing one loads a rule set, and `plural()` is called once per row of a five-thousand-row
 * list — `listCountBookmarks` in the manager's header is recomputed on every `VAULT_CHANGED`. The
 * map holds at most as many entries as there are locales in a session, which is one.
 */
const rules = new Map<string, Intl.PluralRules>();

function rulesFor(locale: string): Intl.PluralRules {
  const existing = rules.get(locale);
  if (existing !== undefined) return existing;
  const created = new Intl.PluralRules(locale);
  rules.set(locale, created);
  return created;
}

/*
 * The resolved locale, computed once.
 *
 * `chrome.i18n.getUILanguage()` cannot change while a page is open — Chrome restarts to change it —
 * so asking it more than once per document buys nothing. `null` until first use rather than
 * module-load, because module scope in the popup runs before the extension APIs are worth calling
 * and because a test wants to change the answer between cases (see {@link resetPluralLocale}).
 */
let resolved: string | null = null;

/** The locale plural categories are chosen in: the UI language, resolved against what we ship. */
export function pluralLocale(): string {
  resolved ??= messageLocale(chrome.i18n.getUILanguage());
  return resolved;
}

/** Forget the cached locale. For tests, which change the UI language between cases. */
export function resetPluralLocale(): void {
  resolved = null;
  rules.clear();
}

/**
 * The CLDR category for a count, in the locale the messages are being read in.
 *
 * `select`, not `selectRange`, and the count is always an integer here: every caller is counting
 * bookmarks, folders, entries or minutes.
 */
export function pluralCategory(count: number, locale: string = pluralLocale()): Intl.LDMLPluralRule {
  return rulesFor(locale).select(count);
}

/**
 * A counted sentence, in the form the locale needs.
 *
 * `base` names a *family* — `base_one`, `base_few`, `base_many`, `base_other` — not a key. Which
 * members exist is the locale's business and is checked per locale by `verify-strings.mjs`; nothing
 * here assumes a particular set.
 *
 * The substitutions are the caller's, unchanged, so a family member that mentions the number and
 * one that does not can live side by side. English's `reorderMoved_one` is "Moved." and its
 * `_other` is "Moved $COUNT$ items." — both are handed the same array, and the one with no
 * placeholder simply ignores it.
 */
export function plural(
  base: string,
  count: number,
  substitutions?: readonly string[],
): string {
  const category = pluralCategory(count);
  const text = msg(`${base}_${category}`, substitutions);
  if (text !== '' || category === 'other') return text;
  return msg(`${base}_other`, substitutions);
}
