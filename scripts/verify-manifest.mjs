#!/usr/bin/env node
/**
 * INV-2, INV-9 — the manifest scanner.
 *
 * Checks the *built* `dist/manifest.json` (not the TypeScript source that produced it) against
 * the frozen permission set in `build/permissions.lock.json` and the exact CSP string. The CSP
 * literal below is deliberately duplicated from `build/manifest.ts`: an assertion that imports
 * the value it is asserting proves nothing.
 *
 * Usage: node scripts/verify-manifest.mjs [dist-dir]
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** INV-2. Exact string, no more and no less. */
export const EXPECTED_CSP = "script-src 'self'; object-src 'self'; frame-ancestors 'none'";

const FORBIDDEN_CSP_TOKENS = [
  'unsafe-eval',
  'unsafe-inline',
  'wasm-unsafe-eval',
  'http://',
  'https://',
];

const PERMISSION_KEYS = /** @type {const} */ ([
  'permissions',
  'optional_permissions',
  'host_permissions',
  'optional_host_permissions',
]);

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function asStringArray(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * Chrome Web Store field limits. Both are *rejections* at upload time, not truncation: the 1.0.0
 * upload was refused for a 133-character description, and the error arrives in the browser after
 * the zip has been transferred. Measured here so it arrives in `npm run verify` instead.
 */
const FIELD_LIMITS = /** @type {const} */ ({ name: 45, description: 132 });

/**
 * Resolve a `__MSG_key__` placeholder against the built `_locales/en/messages.json`. A literal is
 * returned unchanged. `undefined` means the placeholder names a key the locale does not have.
 *
 * @param {unknown} value
 * @param {Record<string, unknown>} messages
 * @returns {string | undefined}
 */
function resolveMessage(value, messages) {
  if (typeof value !== 'string') return undefined;
  const placeholder = /^__MSG_(\w+)__$/.exec(value);
  if (!placeholder) return value;
  const entry = /** @type {Record<string, unknown> | undefined} */ (messages[placeholder[1]]);
  const message = entry?.['message'];
  return typeof message === 'string' ? message : undefined;
}

/**
 * Pure check — this is what the unit tests drive.
 *
 * @param {Record<string, unknown>} manifest  the parsed manifest.json
 * @param {Record<string, unknown>} lock      the parsed permissions.lock.json
 * @param {Record<string, unknown> | Record<string, Record<string, unknown>>} [messages]
 *   the parsed `_locales/<tag>/messages.json` for one locale, or a `{ tag: messages }` map of every
 *   locale the build ships. One locale is the old shape and still works.
 * @returns {string[]} human-readable problems; empty means the manifest is clean
 */
export function checkManifest(manifest, lock, messages) {
  /** @type {string[]} */
  const problems = [];

  if (manifest['manifest_version'] !== 3) {
    problems.push(
      `manifest_version must be 3, found ${JSON.stringify(manifest['manifest_version'])}`,
    );
  }

  const csp = /** @type {Record<string, unknown> | undefined} */ (
    manifest['content_security_policy']
  );
  const extensionPages = csp?.['extension_pages'];
  if (extensionPages !== EXPECTED_CSP) {
    problems.push(
      `content_security_policy.extension_pages must be exactly ${JSON.stringify(EXPECTED_CSP)}, ` +
        `found ${JSON.stringify(extensionPages)}`,
    );
  }
  if (typeof extensionPages === 'string') {
    for (const token of FORBIDDEN_CSP_TOKENS) {
      if (extensionPages.includes(token)) {
        problems.push(`content_security_policy.extension_pages contains "${token}"`);
      }
    }
  }
  for (const [key, value] of Object.entries(csp ?? {})) {
    if (key !== 'extension_pages') {
      problems.push(`unexpected content_security_policy key "${key}": ${JSON.stringify(value)}`);
    }
  }

  for (const key of PERMISSION_KEYS) {
    const actual = asStringArray(manifest[key]);
    const expected = asStringArray(lock[key]);
    const added = actual.filter((entry) => !expected.includes(entry));
    const removed = expected.filter((entry) => !actual.includes(entry));
    if (added.length > 0) {
      problems.push(
        `${key} grew: ${JSON.stringify(added)} is not in build/permissions.lock.json ` +
          '(INV-9 — update the lock file in the same commit, with a CHANGELOG entry)',
      );
    }
    if (removed.length > 0) {
      problems.push(
        `${key} shrank: ${JSON.stringify(removed)} is in build/permissions.lock.json but not in ` +
          'the manifest (INV-9 — dropping a permission is good news, but the lock file has to say so)',
      );
    }
  }

  if (manifest['content_scripts'] !== undefined) {
    problems.push(
      'content_scripts is declared — VaultaMark injects on demand under activeTab, which is why ' +
        'it needs no host permissions at install time',
    );
  }

  const war = manifest['web_accessible_resources'];
  if (war !== undefined && (!Array.isArray(war) || war.length > 0)) {
    problems.push(
      `web_accessible_resources must be empty, found ${JSON.stringify(war)} — nothing we ship ` +
        'should be reachable from a web page',
    );
  }

  if (manifest['incognito'] !== 'spanning') {
    problems.push(
      `incognito must be "spanning" (D29), found ${JSON.stringify(manifest['incognito'])}`,
    );
  }

  const background = /** @type {Record<string, unknown> | undefined} */ (manifest['background']);
  if (background?.['type'] !== 'module' || typeof background['service_worker'] !== 'string') {
    problems.push('background must be { service_worker: "<file>", type: "module" }');
  }

  /*
   * Only when the locale is available: the manifest itself carries placeholders, and a length
   * measured on "__MSG_extDescription__" would be measuring nothing.
   *
   * **Every locale, not only `en`** (Phase 18). The Store reads the name and description out of
   * whichever `messages.json` matches the shopper's language, and applies the same limit to each —
   * so a Polish description of 133 characters is the same rejected upload as an English one, and
   * Polish runs longer than English. The line is written to the limit, not translated to it.
   */
  if (messages) {
    for (const [tag, catalogue] of localeCatalogues(messages)) {
      for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
        const raw = manifest[field];
        const text = resolveMessage(raw, catalogue);
        if (text === undefined) {
          problems.push(
            `${field} is ${JSON.stringify(raw)}, which _locales/${tag}/messages.json does not ` +
              'resolve — the Store shows the placeholder verbatim',
          );
          continue;
        }
        if (text.length > limit) {
          problems.push(
            `${field} in ${tag} is ${text.length} characters, over the Chrome Web Store's limit ` +
              `of ${limit} — the upload is rejected, not truncated`,
          );
        }
      }
    }
  }

  return problems;
}

/**
 * `[tag, messages]` pairs, whether the caller passed one catalogue or a map of them.
 *
 * A catalogue's values are `{ message: … }` objects; a map's values are catalogues. Telling them
 * apart on the shape of one value rather than on a flag keeps the old single-locale call working,
 * which is what every unit test in `test/unit/scripts/verify-manifest.test.ts` uses.
 *
 * @param {Record<string, unknown>} messages
 * @returns {Array<[string, Record<string, unknown>]>}
 */
function localeCatalogues(messages) {
  const first = Object.values(messages)[0];
  const isMap =
    first !== null &&
    typeof first === 'object' &&
    !('message' in /** @type {Record<string, unknown>} */ (first));
  return isMap
    ? Object.entries(/** @type {Record<string, Record<string, unknown>>} */ (messages))
    : [['en', messages]];
}

async function main() {
  const dir = resolve(repoRoot, process.argv[2] ?? 'dist');
  const manifestPath = resolve(dir, 'manifest.json');

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const lock = JSON.parse(await readFile(resolve(repoRoot, 'build/permissions.lock.json'), 'utf8'));
  // Every locale in the built package, so a translated description over the limit is caught here
  // rather than by the Store after the zip has been uploaded.
  const localesDir = resolve(dir, '_locales');
  /** @type {Record<string, Record<string, unknown>>} */
  const messages = {};
  for (const tag of (await readdir(localesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)) {
    messages[tag] = JSON.parse(await readFile(resolve(localesDir, tag, 'messages.json'), 'utf8'));
  }

  const problems = checkManifest(manifest, lock, messages);

  if (problems.length > 0) {
    console.error(`✗ manifest check failed: ${problems.length} problem(s) in ${manifestPath}\n`);
    for (const problem of problems) console.error(`  • ${problem}`);
    console.error('\nSee PLAN.md §4 (INV-2, INV-9).');
    process.exitCode = 1;
    return;
  }

  console.log(
    `✓ manifest is MV3, CSP-exact, within the Store's field limits, and matches ` +
      `build/permissions.lock.json`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
