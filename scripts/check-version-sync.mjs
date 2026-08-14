#!/usr/bin/env node
/**
 * Three things claim to say what version this is, and a release is only coherent when they agree
 * (PLAN §9 Phase 13, RELEASE §7).
 *
 *   1. the **git tag** being released              `v1.2.3`
 *   2. **`package.json`**, which every script reads  `1.2.3`
 *   3. **`dist/manifest.json`**, which is what Chrome and the Store actually see  `1.2.3`
 *
 * They drift for dull reasons — a tag pushed before the version bump was committed, a bump
 * committed after `dist/` was built — and each way of drifting is silent. The one that hurts most
 * is (3): the Store rejects an upload whose manifest version is not higher than the published one,
 * and it rejects it *after* the release exists on GitHub, so the tag has to be deleted and redone.
 *
 * Leg 3 is checked through `build/version.ts` rather than by string equality, because the manifest
 * version is a **mapping**, not a copy: Chrome takes 1–4 integers and nothing else, so `1.2.0-rc.1`
 * legitimately becomes `1.2.0.1` (ARCHITECTURE §2). Comparing the strings directly would report
 * every pre-release as broken.
 *
 * `dist/` is not built yet when this runs early in the workflow, which is deliberate — failing on
 * a mistyped tag should cost thirty seconds, not the full test suite. So the manifest leg is
 * skipped, out loud, when there is nothing to read; `--built` turns that skip into a failure and is
 * what the post-build invocation passes.
 *
 * Usage: node scripts/check-version-sync.mjs v1.2.3 [--built]
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { toChromeVersion } from '../build/version.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @typedef {object} Sources
 * @property {string} tag              the git ref name, with or without its `v`
 * @property {string} packageVersion   `package.json` → `version`
 * @property {string | null} manifestVersion  `dist/manifest.json` → `version`, or null if unbuilt
 * @property {boolean} [requireManifest]
 */

/**
 * Pure, so the tests can drive every disagreement without a filesystem.
 *
 * @param {Sources} sources
 * @returns {string[]} one line per problem; empty means they agree
 */
export function checkVersions({ tag, packageVersion, manifestVersion, requireManifest = false }) {
  /** @type {string[]} */
  const problems = [];

  const tagged = tag.trim().startsWith('v') ? tag.trim().slice(1) : tag.trim();
  if (tagged === '') {
    return ['No tag given. Usage: check-version-sync.mjs v1.2.3'];
  }
  if (!SEMVER.test(tagged)) {
    problems.push(`The tag "${tag}" is not a SemVer version — releases are tagged \`v1.2.3\`.`);
  }
  if (!SEMVER.test(packageVersion)) {
    problems.push(`package.json version "${packageVersion}" is not a SemVer version.`);
  }
  if (problems.length > 0) return problems;

  if (tagged !== packageVersion) {
    problems.push(
      `The tag says ${tagged} and package.json says ${packageVersion}. Bump the version on \`dev\` `
        + 'and commit it before tagging (RELEASE §4 step 2).',
    );
  }

  if (manifestVersion === null) {
    if (requireManifest) {
      problems.push('dist/manifest.json is missing — run `npm run build` before checking it.');
    }
    return problems;
  }

  let expected;
  try {
    expected = toChromeVersion(packageVersion);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return problems;
  }

  if (manifestVersion !== expected) {
    problems.push(
      `dist/manifest.json says ${manifestVersion}, but ${packageVersion} maps to ${expected}. `
        + 'The manifest version is derived at build time and is never edited by hand — this means '
        + '`dist/` is stale, so rebuild it.',
    );
  }
  return problems;
}

/** @returns {Promise<string | null>} */
async function readManifestVersion() {
  try {
    /** @type {{ version?: unknown }} */
    const manifest = JSON.parse(await readFile(resolve(repoRoot, 'dist/manifest.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const requireManifest = args.includes('--built');
  const tag = args.find((arg) => !arg.startsWith('--')) ?? '';

  /** @type {{ version: string }} */
  const pkg = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'));
  const manifestVersion = await readManifestVersion();

  const problems = checkVersions({
    tag,
    packageVersion: pkg.version,
    manifestVersion,
    requireManifest,
  });

  if (problems.length > 0) {
    console.error('✗ the tag, package.json and the built manifest do not agree\n');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }

  const manifest =
    manifestVersion === null ? 'dist/ not built yet, manifest not checked' : `manifest ${manifestVersion}`;
  console.log(`✓ ${tag} = package.json ${pkg.version} (${manifest})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
