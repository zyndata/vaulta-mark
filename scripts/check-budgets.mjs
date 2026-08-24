#!/usr/bin/env node
/**
 * The shipped-size budgets, and the bundle report (PLAN §9 Phase 12).
 *
 * Two of the five budgets that phase names are properties of the *package*: the zip must stay under
 * 400 KB and no single JS file may exceed 150 KB. They are checked here, on every `npm run verify`,
 * because a bundle grows one import at a time and nobody notices the day it crosses a line.
 *
 * The other three are wall-clock and are measured where a clock can be trusted, which is not here:
 *
 *   | budget                            | enforced in |
 *   | --------------------------------- | ----------- |
 *   | service-worker cold start < 50 ms | `test/unit/background/message-router.test.ts` |
 *   | unlock (KDF excluded) < 200 ms    | `test/integration/vault-lifecycle.test.ts` |
 *   | popup first paint < 100 ms        | `test/e2e/budgets.spec.ts` — needs a real renderer |
 *
 * **The zip is built, not estimated.** `makeZip` from `scripts/zip.mjs` is the same function that
 * produces the artifact the Store receives, so the number here is the number that ships — headers,
 * central directory and all. An estimate that summed deflated payloads would drift from the real
 * file by a few hundred bytes per entry and would be wrong in the reassuring direction.
 *
 * Nothing is written unless `--report <path>` is given. CI passes it and uploads the result, which
 * is PLAN's "bundle analysis committed as a report artifact": a size-ordered table of what is in
 * the package, so a jump between two builds can be attributed rather than guessed at.
 *
 * Usage: node scripts/check-budgets.mjs [--report release/bundle-report.md]
 */

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { extname, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeZip } from './zip.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const distDir = resolve(repoRoot, 'dist');

/**
 * PLAN §9 Phase 12. Ratchet down, never up: raising one to make a build pass is how a budget stops
 * being one, which is why the failure message says so and why the change below went through PLAN.
 *
 * **The single-chunk budget is two numbers, not one, and that is a Phase-12 amendment.** As
 * planned it was "largest single JS chunk < 150 KB", written before the code it would measure
 * existed. Applied to `background.js` it fails at 307 KB — and the measurement says why: 147 KB of
 * that is one string literal (the bundled public-suffix list) and 6 KB is another (the common-
 * password list), leaving 161 KB of actual code for the entire feature set in one deliberately
 * un-split file. The worker may not code-split (ARCHITECTURE §2: a service worker that does will
 * eventually `import()` a chunk after being torn down), so there is no arrangement of the same code
 * that passes.
 *
 * The property the budget was a proxy for is parse-and-evaluate time at cold start, and that is
 * measured directly and separately at 50 ms — with the PSL's own module-eval cost measured at
 * 0.06 ms, because it is three newline-joined strings that become sets lazily. The download cost is
 * the zip budget, and the package is 156 KB of its 400 KB.
 *
 * So the 150 KB number is kept, unchanged, for the thing it was about — a *document's* JavaScript,
 * parsed before that document paints — and the worker gets a ceiling of its own.
 *
 * **The PSL was moved out on 2026-08-24, and the worker ceiling came down with it.** This comment
 * named the list as the obvious 147 KB to reclaim and said "not done here"; 1.2.0 shipped at
 * 327.7 KB against 340 KB, which is 12 KB of headroom against a release that had just cost 16 KB,
 * so it was done. The list is a package asset read with `fetch(chrome.runtime.getURL(…))` at first
 * use — an extension-origin read, not network traffic (`src/history/public-suffix.ts`). The worker
 * measured 178.8 KB afterwards, and the ceiling is now 220 KB: the same ~40 KB of room the 340 KB
 * number was drawn to leave, rather than a ceiling that has stopped being able to fail.
 */
export const BUDGETS = {
  /** The whole package, zipped, as the Chrome Web Store receives it. */
  zipBytes: 400 * 1024,
  /** Any one JavaScript file a *document* loads — what the browser parses before the page paints. */
  chunkBytes: 150 * 1024,
  /** The service worker, which is one un-split file carrying the feature set. */
  workerBytes: 220 * 1024,
};

/** The service worker's filename, fixed by `build/mv3-plugin.ts` and by the manifest. */
const WORKER = 'background.js';

/** Source maps are a CI debugging artifact and are excluded from the package (`zip.mjs`). */
const PACKAGED = (name) => extname(name) !== '.map';

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else found.push(full);
  }
  return found;
}

/** Everything in `dist/` that ships, with its own size and its size inside the zip. */
export async function measure(dir = distDir) {
  const paths = (await walk(dir)).sort();
  const entries = [];
  for (const path of paths) {
    const name = relative(dir, path).split(/[\\/]/).join('/');
    if (!PACKAGED(name)) continue;
    entries.push({ name, data: await readFile(path) });
  }

  const zip = makeZip(entries);
  const files = entries.map((entry) => ({
    name: entry.name,
    bytes: entry.data.length,
    /*
     * The entry's own compressed size, read back out of the archive rather than recomputed: it is
     * what this file actually costs in the artifact, and recompressing it separately would use a
     * different window and give a different answer.
     */
    zipped: zippedSizeOf(zip, entry.name),
  }));

  // `entries` carries the bytes as well as the names, which is what `checkCodeSplitting` reads.
  return { zipBytes: zip.length, files, entries };
}

/**
 * A string the vendored QR encoder throws, and nothing else in the package contains.
 *
 * A marker rather than a filename: the chunk's name is hashed, and asserting that some
 * `assets/qrcode-*.js` exists would pass against a build that emitted that chunk *and* inlined the
 * encoder into the manager as well.
 */
const ENCODER_MARKER = 'code length overflow';

/**
 * The JavaScript a document parses before it paints, plus the service worker.
 *
 * Read out of the built HTML and the built manifest rather than listed here, because that is the
 * question being asked -- what does the browser load eagerly? -- and a hand-written list would
 * answer a different one the day an entry is renamed.
 */
export function entryScripts(entries) {
  const names = new Set();

  for (const entry of entries) {
    if (!entry.name.endsWith('.html')) continue;
    const html = entry.data.toString('utf8');
    for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
      names.add(match[1].replace(/^\.?\//, ''));
    }
  }

  const manifest = entries.find((entry) => entry.name === 'manifest.json');
  const worker = manifest && JSON.parse(manifest.data.toString('utf8')).background?.service_worker;
  if (typeof worker === 'string') names.add(worker);

  return names;
}

/**
 * PLAN §9 Phase 15: the QR encoder is in a chunk of its own, and in none of the eager ones.
 *
 * It is 20 KB of Galois-field arithmetic and error-correction block tables that most sessions never
 * open a dialog to reach, so `src/ui/qr.ts` loads it with `import('../vendor/…/qrcode.js')`.
 * Nothing about that shape is guaranteed: a static import added by mistake, a bundler setting or an
 * inlining threshold would fold it back into the manager's first paint and nothing would look
 * wrong. So it is measured against the real `dist/`, beside the sizes, rather than assumed.
 */
export function checkCodeSplitting(entries) {
  const problems = [];
  const eager = entryScripts(entries);
  const carrying = entries
    .filter((entry) => entry.name.endsWith('.js') && entry.data.includes(ENCODER_MARKER))
    .map((entry) => entry.name);

  if (carrying.length === 0) {
    return [
      'no chunk carries the QR encoder -- either it stopped being bundled, or the marker '
        + `${JSON.stringify(ENCODER_MARKER)} is no longer in it`,
    ];
  }

  for (const name of carrying) {
    if (eager.has(name)) {
      problems.push(`${name} is loaded eagerly and carries the QR encoder (PLAN §9 Phase 15)`);
    }
  }
  if (carrying.length > 1) {
    problems.push(`the QR encoder is in ${String(carrying.length)} chunks: ${carrying.join(', ')}`);
  }

  return problems;
}

/**
 * The compressed size of one entry, from the archive's own local headers.
 *
 * A small zip parser rather than a second `deflateRawSync` call, for the reason above. Local file
 * headers are `PK\x03\x04`, and the field layout is fixed — this reads the two lengths it needs and
 * skips the rest.
 */
function zippedSizeOf(zip, name) {
  const target = Buffer.from(name, 'utf8');
  let at = 0;
  while (at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50) {
    const compressed = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const extraLength = zip.readUInt16LE(at + 28);
    const start = at + 30;
    if (zip.subarray(start, start + nameLength).equals(target)) return compressed;
    at = start + nameLength + extraLength + compressed;
  }
  return 0;
}

export function checkBudgets(measurement) {
  const problems = [];

  if (measurement.zipBytes > BUDGETS.zipBytes) {
    problems.push(
      `the package is ${kb(measurement.zipBytes)} zipped, over the ${kb(BUDGETS.zipBytes)} budget`,
    );
  }

  for (const file of measurement.files) {
    if (extname(file.name) !== '.js') continue;
    const limit = file.name === WORKER ? BUDGETS.workerBytes : BUDGETS.chunkBytes;
    const which = file.name === WORKER ? 'service-worker' : 'single-chunk';
    if (file.bytes > limit) {
      problems.push(`${file.name} is ${kb(file.bytes)}, over the ${kb(limit)} ${which} budget`);
    }
  }

  return problems;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** A size-ordered table of the package, for the artifact CI keeps. */
export function report(measurement, version) {
  const rows = [...measurement.files].sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((sum, file) => sum + file.bytes, 0);

  const lines = [
    `# Bundle report — ${version}`,
    '',
    `**Packaged:** ${kb(measurement.zipBytes)} zipped (budget ${kb(BUDGETS.zipBytes)}) · `
      + `${kb(total)} unpacked · ${String(rows.length)} files`,
    '',
    '| File | Size | In the zip |',
    '| --- | ---: | ---: |',
    ...rows.map((file) => `| \`${file.name}\` | ${kb(file.bytes)} | ${kb(file.zipped)} |`),
    '',
    '## Budgets',
    '',
    '| Budget | Limit | This build |',
    '| --- | ---: | ---: |',
    `| Total zip | ${kb(BUDGETS.zipBytes)} | ${kb(measurement.zipBytes)} |`,
    `| Largest document chunk | ${kb(BUDGETS.chunkBytes)} | ${kb(largestJs(rows, false))} |`,
    `| Service worker | ${kb(BUDGETS.workerBytes)} | ${kb(largestJs(rows, true))} |`,
    '',
    'The three wall-clock budgets are enforced in the test suite, not here — see the header of',
    '`scripts/check-budgets.mjs` for which test owns which.',
    '',
    '## Runtime dependencies',
    '',
    'None, and that is checked rather than asserted: `package.json` has no `dependencies` field,',
    '`scripts/verify-no-remote-code.mjs` refuses any remote import in `dist/`, and everything above',
    'is code from `src/` plus two bundled data sets (the public-suffix and common-password lists)',
    'and one vendored third-party source file, the QR encoder in `src/vendor/` (ARCHITECTURE §15).',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/** The biggest `.js`, counting only the worker or only the documents' chunks. */
function largestJs(rows, worker) {
  return rows
    .filter((file) => extname(file.name) === '.js' && (file.name === WORKER) === worker)
    .reduce((max, file) => Math.max(max, file.bytes), 0);
}

async function main() {
  const reportAt = process.argv.indexOf('--report');
  /** @type {{ version: string }} */
  const pkg = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'));

  let measurement;
  try {
    measurement = await measure();
  } catch {
    console.error('✗ dist/ not found — run `npm run build` first.');
    process.exitCode = 1;
    return;
  }

  if (reportAt !== -1) {
    const target = resolve(repoRoot, process.argv[reportAt + 1] ?? 'release/bundle-report.md');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, report(measurement, pkg.version));
    console.log(`  wrote ${relative(repoRoot, target)}`);
  }

  const problems = [...checkBudgets(measurement), ...checkCodeSplitting(measurement.entries)];
  if (problems.length > 0) {
    console.error('✗ performance budgets (PLAN §9 Phase 12)\n');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('\nRatchet down, never up. Raising a budget to make a build pass needs a PLAN change.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `✓ ${kb(measurement.zipBytes)} zipped / ${kb(BUDGETS.zipBytes)}, `
      + `worker ${kb(largestJs(measurement.files, true))} / ${kb(BUDGETS.workerBytes)}, `
      + `largest page chunk ${kb(largestJs(measurement.files, false))} / ${kb(BUDGETS.chunkBytes)}, `
      + 'QR encoder out of every eager chunk',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
