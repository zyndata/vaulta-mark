/**
 * INV-10 (Phase 12): **no user-facing string outside `_locales/en/messages.json`.**
 *
 * English is the only locale 1.0 ships, so nothing here is visibly broken today — which is exactly
 * why it needs a machine to check it. A sentence typed straight into `h('p', null, 'Vault locked')`
 * looks identical to a translated one in the running extension and stays invisible until somebody
 * opens a translation PR and finds a third of the product missing from the file they were handed.
 *
 * Four checks:
 *
 *   1. **Missing keys.** Every `msg('someKey')` names a key that exists. A key that does not is not
 *      an error at runtime: `chrome.i18n.getMessage` answers with the empty string, so the label
 *      simply disappears and the button beside it still works.
 *   2. **Dead keys.** Every key in the file is named somewhere under `src/`. Dead strings are the
 *      cost a translator pays for our tidying-up, in a file where they cannot tell.
 *   3. **Untranslated literals.** No prose reaches the document without going through `msg`. This is
 *      an AST walk rather than a grep, because the interesting positions are structural — a child of
 *      `h()`, the right-hand side of `textContent =`, the value of a `title`/`placeholder`/
 *      `aria-label` attribute — and a regex over a codebase full of CSS class names and selectors
 *      would either miss all of it or drown the run in false positives.
 *   4. **Key parity across locales** (Phase 18). Every locale under `public/_locales/` holds exactly
 *      the keys `en` does — and, for a plural family, exactly the forms *that* language has, which
 *      `Intl.PluralRules` is asked rather than told. This is the check the first three exist to
 *      prescribe: while `en` was the only locale, a missing key could only come from a typo; with a
 *      second one it comes from a translation that stopped halfway, and the symptom is the same
 *      blank label with nobody left who can see it, because whoever reads that locale is not the
 *      person who wrote the code.
 *
 * Run by `npm run verify:invariants`, and against `src/` rather than `dist/` — unlike the other two
 * scanners, what is being checked is authorship, and the bundler has thrown that seam away by then.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Attribute and property names whose value a person reads.
 *
 * `alt` and `aria-label` are here for the same reason as `textContent`: they are the entire text
 * some people get, so an untranslated one is worse than an untranslated caption, not better.
 */
const TEXT_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'placeholder',
  'title',
]);

const TEXT_PROPERTIES = new Set([
  'ariaLabel',
  'ariaValueText',
  'innerText',
  'placeholder',
  'textContent',
  'title',
]);

/**
 * Literals that are prose to a regular expression and not to a reader.
 *
 * Kept short on purpose. Every entry is a thing that reads the same in every language, and the day
 * this list starts collecting sentences it has become the bug it was written to prevent.
 */
export const NOT_PROSE = new Set([
  'VaultaMark', // the product name. STORE_LISTING §1 says it is not translated.
]);

/** Does this literal look like something a person reads, rather than a class name or a token? */
export function looksLikeProse(text) {
  const trimmed = text.trim();
  if (trimmed.length < 3 || NOT_PROSE.has(trimmed)) return false;
  // Two words of letters with whitespace between them. Single tokens — `vm-row`, `polite`,
  // `button`, an item id — are attributes and selectors, and are what makes a looser rule unusable.
  return /[A-Za-z]{2,}\s+[A-Za-z]{2,}/u.test(trimmed);
}

/**
 * Every CLDR plural category there is.
 *
 * The set a *language* uses is a subset, and is asked of `Intl.PluralRules` rather than listed
 * anywhere — English has two, Polish four, Arabic six, and hard-coding any of those numbers is how
 * the next locale arrives broken. This wider set exists only to recognise a key as a family member
 * when reading `messages.json`: `historyCleared_many` is one, `syncMismatchAdoptLosesNone` is not.
 */
const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** The functions that take a family base rather than a key. See `src/ui/plural.ts`. */
const PLURAL_CALLS = new Set(['plural', 'dialogPlural']);

/**
 * The locales this build ships, from the one list the running code also reads.
 *
 * Parsed out of `src/ui/plural.ts` rather than taken from the directory listing, so the two cannot
 * drift: a `_locales/de/` nobody added to `SHIPPED_LOCALES` is a translation `plural()` will never
 * pick categories for, and a tag in the list with no directory is a locale Chrome silently falls
 * back out of. Both are reported below, which is the whole point of reading them from two places.
 */
export function shippedLocales(root = repoRoot) {
  const source = readFileSync(join(root, 'src', 'ui', 'plural.ts'), 'utf8');
  const list = /export const SHIPPED_LOCALES = \[([^\]]*)\]/u.exec(source);
  if (list === null) throw new Error('SHIPPED_LOCALES is not where scripts/verify-strings.mjs looks for it.');
  return [...list[1].matchAll(/'([a-z-]+)'/gu)].map((match) => match[1]);
}

/** The categories a language actually has, in a stable order. */
export function categoriesOf(locale) {
  const used = new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
  return PLURAL_CATEGORIES.filter((category) => used.has(category));
}

/** The string a node contributes, if it contributes a fixed one. */
function literalOf(node) {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function nameOf(node) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null;
}

/**
 * Everything one TypeScript source says about `_locales`.
 *
 * Returns the keys it names and the untranslated prose it contains. `defined` is passed in so a
 * `msg('typo')` is reported here, beside its line number, rather than as a bare key name later.
 */
export function scanSource(file, text, defined = new Set()) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const keys = new Set();
  const families = new Set();
  const problems = [];

  const report = (node, message) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    problems.push(`${file}:${line + 1}  ${message}`);
  };

  const flag = (node, value, what) => {
    if (value !== null && looksLikeProse(value))
      report(node, `untranslated ${what}: ${JSON.stringify(value)}`);
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : null;

      // (1) `msg(key)` is the only door into `_locales` from TypeScript.
      if (callee === 'msg') {
        const argument = node.arguments[0];
        const key = literalOf(argument);
        if (key !== null) {
          keys.add(key);
          if (defined.size > 0 && !defined.has(key))
            report(node, `msg('${key}') has no entry in _locales`);
        } else if (argument !== undefined && ts.isTemplateExpression(argument)) {
          /*
           * A key computed from a value: `msg(\`strength${score}\`)` picks one of five. The family
           * is claimed by its prefix rather than resolved, because resolving it means evaluating
           * the expression — and the five `strength*` entries are as alive as any other, while a
           * sweep that could not see this would report every one of them as dead and invite the
           * deletion of a working feature's words.
           */
          const prefix = argument.head.text;
          if (prefix.length > 0)
            for (const candidate of defined)
              if (candidate.startsWith(prefix)) keys.add(candidate);
        }
      }

      /*
       * (1, again) `plural(base, n)` and `dialogPlural(base, n)` name a *family*, not a key.
       *
       * The members are `base_one`, `base_few`, … and which of them exist is the locale's business,
       * so the check here is only that the family is inhabited at all — a `plural('typo')` names
       * nothing and would render as an empty string in every language at once. Parity between the
       * locales is checked separately, against `Intl.PluralRules`, in `scanRepository`.
       */
      if (callee !== null && PLURAL_CALLS.has(callee)) {
        const base = literalOf(node.arguments[0]);
        if (base !== null) {
          families.add(base);
          let inhabited = false;
          for (const category of PLURAL_CATEGORIES) {
            const member = `${base}_${category}`;
            if (defined.has(member)) {
              keys.add(member);
              inhabited = true;
            }
          }
          if (defined.size > 0 && !inhabited)
            report(node, `${callee}('${base}') has no plural family in _locales`);
        }
      }

      // (3) `h(tag, attrs, ...children)`: the children, and the attributes a person reads.
      if (callee === 'h') {
        for (const child of node.arguments.slice(2)) flag(child, literalOf(child), 'text in h()');
        const attrs = node.arguments[1];
        if (attrs !== undefined && ts.isObjectLiteralExpression(attrs))
          for (const property of attrs.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const name = nameOf(property.name);
            if (name !== null && TEXT_ATTRIBUTES.has(name))
              flag(property, literalOf(property.initializer), `${name} attribute`);
          }
      }

      // (3) `element.setAttribute('aria-label', 'literal')`.
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'setAttribute'
      ) {
        const name = literalOf(node.arguments[0]);
        if (name !== null && TEXT_ATTRIBUTES.has(name))
          flag(node, literalOf(node.arguments[1]), `${name} attribute`);
      }
    }

    // (3) `element.textContent = 'literal'`.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      TEXT_PROPERTIES.has(node.left.name.text)
    )
      flag(node, literalOf(node.right), node.left.name.text);

    ts.forEachChild(node, visit);
  };

  visit(source);

  /*
   * Dead-key detection reads every identifier-shaped literal in the file, not only `msg()`
   * arguments. The error and sync tables in `src/ui/strings.ts` hold key names as record *values*
   * and hand them to `msg` a call away, and a key reached that way is referenced just as surely —
   * a stricter sweep would report all seventeen `ErrorCode` strings as dead.
   */
  for (const match of text.matchAll(/['"]([A-Za-z][A-Za-z0-9_]*)['"]/gu)) keys.add(match[1]);

  return { keys, families, problems };
}

function walkFiles(dir, extension) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walkFiles(full, extension));
    else if (entry.endsWith(extension)) found.push(full);
  }
  return found;
}

/** The whole check, over the real tree. Returns every problem found, in reporting order. */
export function scanRepository(root = repoRoot) {
  const src = join(root, 'src');
  const messages = JSON.parse(
    readFileSync(join(root, 'public', '_locales', 'en', 'messages.json'), 'utf8'),
  );
  const defined = new Set(Object.keys(messages));
  const referenced = new Set();
  const families = new Set();
  const problems = [];
  const shortName = (file) => relative(root, file).split(sep).join('/');

  for (const file of walkFiles(src, '.ts')) {
    const result = scanSource(shortName(file), readFileSync(file, 'utf8'), defined);
    for (const key of result.keys) referenced.add(key);
    for (const base of result.families) families.add(base);
    problems.push(...result.problems);
  }

  /* `data-i18n` is the other door: the static documents localize themselves through `ui/dom.ts`. */
  for (const file of walkFiles(src, '.html')) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/data-i18n="([^"]+)"/gu)) {
      referenced.add(match[1]);
      if (!defined.has(match[1]))
        problems.push(`${shortName(file)}  data-i18n="${match[1]}" has no entry`);
    }
  }

  /* `__MSG_appName__` and friends: the manifest's own strings resolve through `_locales` too. */
  const manifestSource = readFileSync(join(root, 'build', 'manifest.ts'), 'utf8');
  for (const match of manifestSource.matchAll(/__MSG_([A-Za-z0-9_]+)__/gu)) referenced.add(match[1]);

  for (const key of defined)
    if (!referenced.has(key)) problems.push(`_locales/en/messages.json  "${key}" is never used`);

  problems.push(...checkLocaleParity(root, messages, families));

  return { problems, defined };
}

/**
 * Check 4: every locale holds exactly the keys `en` does, in exactly the forms its language has.
 *
 * Three kinds of finding, and the first is the one this was written for:
 *
 * - **Missing.** A key `en` has and this locale does not. Renders blank, and blank is invisible to
 *   everyone who does not read that language — which is everyone who could fix it.
 * - **Extra.** A key this locale has and `en` does not. Almost always a rename that went one way:
 *   harmless to render, and a lie to the next translator, who will spend their evening on it.
 * - **Wrong forms.** A family missing `_few` in Polish, or carrying a `_two` in English. Asked of
 *   `Intl.PluralRules`, so adding a language adds no rule here and forgetting one is not possible.
 *
 * The `en` file is the reference for the *set* of keys, not for the forms: `listCountBookmarks` has
 * two members in English and four in Polish, and neither file is wrong about the other.
 */
export function checkLocaleParity(root, englishMessages, families) {
  const problems = [];
  const locales = shippedLocales(root);
  const localesDir = join(root, 'public', '_locales');
  const onDisk = readdirSync(localesDir).filter((entry) =>
    statSync(join(localesDir, entry)).isDirectory(),
  );

  for (const tag of onDisk)
    if (!locales.includes(tag))
      problems.push(`_locales/${tag}  is not in SHIPPED_LOCALES (src/ui/plural.ts)`);

  /*
   * `en` split into the plain keys and the family bases it defines. A key is a family member only
   * if the code actually calls `plural()` on its base — `syncMismatchAdoptLosesNone` ends in a word
   * that is not a category, but nothing stops a future key from ending in `_one` by accident.
   */
  const plain = new Set();
  const inhabited = new Set();
  for (const key of Object.keys(englishMessages)) {
    const cut = key.lastIndexOf('_');
    const base = cut === -1 ? null : key.slice(0, cut);
    const category = cut === -1 ? null : key.slice(cut + 1);
    if (base !== null && families.has(base) && PLURAL_CATEGORIES.includes(category)) {
      inhabited.add(base);
    } else {
      plain.add(key);
    }
  }

  for (const base of families)
    if (!inhabited.has(base))
      problems.push(`_locales/en/messages.json  plural family "${base}" has no members`);

  for (const tag of locales) {
    const file = join(localesDir, tag, 'messages.json');
    let translated;
    try {
      translated = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      problems.push(`_locales/${tag}/messages.json  is missing or is not valid JSON`);
      continue;
    }
    const have = new Set(Object.keys(translated));
    // English is the reference for which families exist; the *language* decides the forms, so a
    // family is expected here in full even where `en` itself carries only two of Polish's four.
    const want = new Set(plain);
    for (const base of inhabited)
      for (const category of categoriesOf(tag)) want.add(`${base}_${category}`);

    for (const key of want)
      if (!have.has(key)) problems.push(`_locales/${tag}/messages.json  "${key}" is missing`);
    for (const key of have)
      if (!want.has(key))
        problems.push(`_locales/${tag}/messages.json  "${key}" is not a key en defines`);
  }

  return problems;
}

function main() {
  const { problems, defined } = scanRepository();

  if (problems.length > 0) {
    console.error('✗ user-facing strings (INV-10)\n');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      `\n${problems.length} problem(s). Every sentence a person reads belongs in ` +
        `public/_locales/en/messages.json, reached through msg() or data-i18n.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`✓ ${defined.size} message keys, all used, and no user-facing string outside _locales`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
