#!/usr/bin/env node
/**
 * INV-1, INV-3, INV-8 — the remote-code, absolute-URL and telemetry scanner.
 *
 * Walks every emitted file in `dist/` and fails the build on anything that could load or reach
 * code or servers that are not in the package. This runs against the *real build output*, not
 * against source: the whole point is to catch what a dependency, a plugin or a stray import
 * smuggled into the bundle. See PLAN.md §4 and docs/ARCHITECTURE.md §2.
 *
 * The scan is token-based rather than AST-based. Adding a JS parser would mean either a new
 * dev dependency in the security-critical path or hand-rolling one; on minified single-file
 * output the token scan is what actually catches the patterns below, and a false positive
 * fails closed (a loud build break), which is the safe direction to be wrong in.
 *
 * Usage: node scripts/verify-no-remote-code.mjs [dist-dir]
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extname, join, relative, resolve } from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Binary assets have no code in them, and no useful strings either. */
const SKIPPED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  // Source maps embed the original sources; they are a CI debugging artifact and are excluded
  // from the store zip by scripts/zip.mjs, so scanning them only produces noise.
  '.map',
]);

/**
 * @typedef {{ id: string, description: string, pattern: RegExp }} Rule
 */

/** @type {Rule[]} */
const RULES = [
  {
    id: 'script-src-remote',
    description: '<script> with a non-relative src',
    pattern: /<script\b[^>]*\bsrc\s*=\s*["']?(?!\/|\.\/|\.\.\/|["'])[^"'>\s]+/gi,
  },
  {
    id: 'stylesheet-remote',
    description: '<link rel="stylesheet"> with an absolute href',
    pattern: /<link\b[^>]*\bhref\s*=\s*["']?(?:[a-z][a-z0-9+.-]*:)?\/\/[^"'>\s]+/gi,
  },
  {
    id: 'eval',
    description: 'eval()',
    pattern: /(?<![.\w$])eval\s*\(/g,
  },
  {
    id: 'new-function',
    description: 'new Function() / Function() as a constructor',
    pattern: /(?<![.\w$])(?:new\s+)?Function\s*\(/g,
  },
  {
    id: 'string-timer',
    description: 'setTimeout/setInterval with a string body',
    pattern: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g,
  },
  {
    id: 'dynamic-import',
    description: 'import() with a non-relative or computed specifier',
    pattern: /(?<![.\w$])import\s*\(\s*(?!["'](?:\.\/|\.\.\/|\/))/g,
  },
  {
    id: 'import-scripts',
    description: 'importScripts()',
    pattern: /(?<![.\w$])importScripts\s*\(/g,
  },
  {
    id: 'wasm',
    description: 'WebAssembly (we ship no WASM — it would need wasm-unsafe-eval in the CSP)',
    pattern:
      /\bWebAssembly\s*\.\s*(?:instantiate|instantiateStreaming|compile|compileStreaming)\b/g,
  },
  {
    id: 'send-beacon',
    description: 'navigator.sendBeacon (INV-8: no telemetry, ever)',
    pattern: /\bsendBeacon\s*\(/g,
  },
  {
    id: 'xhr',
    description: 'XMLHttpRequest (fetch only, and only on the Drive path)',
    pattern: /\bXMLHttpRequest\b/g,
  },
  {
    id: 'script-url-scheme',
    description: 'blob: or data: used as a script or worker URL',
    pattern:
      /(?:src\s*=\s*["']?|new\s+Worker\s*\(\s*["'`]|importScripts\s*\(\s*["'`])(?:blob:|data:(?:text|application)\/(?:java|ecma)script)/gi,
  },
];

const ABSOLUTE_URL = /\bhttps?:\/\/[^\s"'`<>()\\]+/gi;

/**
 * @typedef {{ file: string, rule: string, description: string, match: string }} Violation
 */

/**
 * Scan one file's text. Pure — this is what the unit tests drive.
 *
 * @param {string} file  display name, used only in the report
 * @param {string} text  file contents
 * @param {readonly string[]} allowedUrlPrefixes  from build/url-allowlist.json
 * @returns {Violation[]}
 */
export function scanText(file, text, allowedUrlPrefixes) {
  /** @type {Violation[]} */
  const violations = [];

  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      violations.push({
        file,
        rule: rule.id,
        description: rule.description,
        match: excerpt(match[0]),
      });
    }
  }

  for (const match of text.matchAll(ABSOLUTE_URL)) {
    const url = match[0];
    if (allowedUrlPrefixes.some((prefix) => url.startsWith(prefix))) continue;
    violations.push({
      file,
      rule: 'absolute-url',
      description: 'absolute URL that is not in build/url-allowlist.json',
      match: excerpt(url),
    });
  }

  return violations;
}

/** @param {string} value */
function excerpt(value) {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}…` : collapsed;
}

/** @returns {Promise<string[]>} */
export async function loadAllowlist() {
  const raw = await readFile(resolve(repoRoot, 'build/url-allowlist.json'), 'utf8');
  /** @type {{ allowed: string[] }} */
  const parsed = JSON.parse(raw);
  return parsed.allowed;
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

/**
 * @param {string} dir
 * @returns {Promise<Violation[]>}
 */
export async function scanDirectory(dir) {
  const allowed = await loadAllowlist();
  const files = await walk(dir);
  /** @type {Violation[]} */
  const violations = [];

  for (const file of files) {
    if (SKIPPED_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const text = await readFile(file, 'utf8');
    violations.push(...scanText(relative(dir, file).replace(/\\/g, '/'), text, allowed));
  }

  return violations;
}

async function main() {
  const dir = resolve(repoRoot, process.argv[2] ?? 'dist');
  const violations = await scanDirectory(dir);

  if (violations.length > 0) {
    console.error(`✗ remote-code scan failed: ${violations.length} violation(s) in ${dir}\n`);
    for (const violation of violations) {
      console.error(`  ${violation.file}: [${violation.rule}] ${violation.description}`);
      console.error(`      ${violation.match}`);
    }
    console.error('\nSee PLAN.md §4 (INV-1, INV-3, INV-8).');
    process.exitCode = 1;
    return;
  }

  console.log(`✓ no remote code, no non-allowlisted URLs, no telemetry in ${dir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
