/**
 * INV-10 (Phase 12): **no user-facing string outside `_locales/en/messages.json`.**
 *
 * English is the only locale 1.0 ships, so nothing here is visibly broken today — which is exactly
 * why it needs a machine to check it. A sentence typed straight into `h('p', null, 'Vault locked')`
 * looks identical to a translated one in the running extension and stays invisible until somebody
 * opens a translation PR and finds a third of the product missing from the file they were handed.
 *
 * Three checks:
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

  return { keys, problems };
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
  const problems = [];
  const shortName = (file) => relative(root, file).split(sep).join('/');

  for (const file of walkFiles(src, '.ts')) {
    const result = scanSource(shortName(file), readFileSync(file, 'utf8'), defined);
    for (const key of result.keys) referenced.add(key);
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

  return { problems, defined };
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
