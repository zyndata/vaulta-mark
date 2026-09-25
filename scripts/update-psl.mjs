#!/usr/bin/env node
/**
 * Regenerate `public/public-suffix-list.txt` from the Public Suffix List.
 *
 * ARCHITECTURE §12.1 decides *why* this exists: "last two labels" is wrong for `co.uk`, `com.au`,
 * `github.io` and several hundred other suffixes, and being wrong here means either failing to clean
 * a domain the user asked to clean or cleaning a **different site's** history. Both are unacceptable,
 * so the list is bundled.
 *
 * **Both sections, ICANN and PRIVATE.** §12.1 originally said ICANN-only and was amended, because
 * `github.io` — which the phase's own test list names — is a PRIVATE rule, and dropping the section
 * produces exactly the failure the paragraph above forbids: a user who vaults `alice.github.io`
 * would have a cleanup aimed at `github.io`, deleting every GitHub Pages site in their history
 * including strangers'. The same argument covers `*.blogspot.com` and a few thousand others. The
 * cost is that the PRIVATE section changes faster than the ICANN one, so a regeneration diff is
 * larger — which is a review inconvenience, not a correctness problem.
 *
 * Two properties of this script are the security-relevant ones:
 *
 * - **It is run by hand, never at runtime.** The extension ships the generated file and reads it
 *   from its own package; nothing in `src/` fetches anything over a network (INV-3, INV-4).
 *   Auto-updating from a URL would put remote data in charge of a decision about which history
 *   entries get deleted.
 *
 * - **The output is a package asset, not a module.** It used to be three string constants in
 *   `src/history/public-suffix.ts`, which put 144 KB inside `background.js` — a file the service
 *   worker parses every time Chrome wakes it, roughly every 30 seconds, and which may not be
 *   code-split (ARCHITECTURE §2). `src/history/public-suffix.ts` now reads this file at first use.
 *   The rule syntax is publicsuffix.org's own, so the asset can be diffed against its source.
 * - **It emits punycode.** `new URL(…).hostname` is always in its ASCII form, so a rule kept in
 *   Unicode could never match anything the extension actually sees. `domainToASCII` is applied here,
 *   once, rather than being a runtime dependency on an IDN implementation the platform does not
 *   expose.
 *
 * Usage: npm run update-psl
 */

import { writeFile } from 'node:fs/promises';
import { domainToASCII, fileURLToPath, pathToFileURL } from 'node:url';

// Schemeless on purpose: `scripts/**` is not scanned by `verify-no-remote-code.mjs`, but this string
// is also copied into the generated file's header, and that one *is* shipped.
const SOURCE_HOST = 'publicsuffix.org';
const SOURCE_PATH = '/list/public_suffix_list.dat';

const OUTPUT = fileURLToPath(new URL('../public/public-suffix-list.txt', import.meta.url));

/**
 * Every rule, punycoded, deduplicated and sorted.
 *
 * @param {string} text  the raw list
 * @returns {{ plain: string[], wildcard: string[], exception: string[] }}
 */
export function parseList(text) {
  const plain = new Set();
  const wildcard = new Set();
  const exception = new Set();

  for (const line of text.split(/\r?\n/)) {
    const rule = line.trim();
    // `//` is the list's comment marker, and also how it delimits its two sections.
    if (rule === '' || rule.startsWith('//')) continue;

    if (rule.startsWith('!')) exception.add(toAscii(rule.slice(1)));
    else if (rule.startsWith('*.')) wildcard.add(toAscii(rule.slice(2)));
    else plain.add(toAscii(rule));
  }

  // A list that parsed to almost nothing means the fetch answered with a redirect page, an error
  // document, or a format we no longer understand. Writing that over the bundled rules would
  // silently turn every registrable domain back into "the last two labels".
  if (plain.size < 1_000) {
    throw new Error(`Only ${plain.size} rules parsed — has the format changed?`);
  }
  const sorted = (set) => [...set].filter((rule) => rule !== '').sort();
  return { plain: sorted(plain), wildcard: sorted(wildcard), exception: sorted(exception) };
}

/** @param {string} rule */
function toAscii(rule) {
  const ascii = domainToASCII(rule);
  // `domainToASCII` answers with an empty string for anything it cannot map. Keeping the original
  // would ship a rule that can never match; dropping it silently would ship a hole. Neither is
  // acceptable in a list this decision depends on, so it fails the regeneration instead.
  if (ascii === '') throw new Error(`Rule "${rule}" has no ASCII form.`);
  return ascii;
}

/**
 * The list, back in the syntax it was published in: `*.` for wildcards, `!` for exceptions.
 *
 * Sorted within each kind and grouped by kind, so a regeneration diff shows what changed rather
 * than a reshuffle. The header is four comment lines the parser skips; they cost 200 bytes and are
 * the only thing that makes a stale asset visible in a review.
 *
 * @param {{ plain: string[], wildcard: string[], exception: string[] }} rules
 * @param {string} fetchedOn  ISO date, so a stale list is visible in the diff
 */
export function renderList(rules, fetchedOn) {
  const total = rules.plain.length + rules.wildcard.length + rules.exception.length;
  const header = [
    `// The Public Suffix List — generated by scripts/update-psl.mjs, do not edit.`,
    `// Source: ${SOURCE_HOST}${SOURCE_PATH}`,
    `// Fetched: ${fetchedOn}`,
    `// Rules: ${total} (${rules.plain.length} plain, ${rules.wildcard.length} wildcard, ${rules.exception.length} exception)`,
  ];
  const body = [
    ...rules.plain,
    ...rules.wildcard.map((rule) => `*.${rule}`),
    ...rules.exception.map((rule) => `!${rule}`),
  ];
  return [...header, '', ...body, ''].join('\n');
}

async function main() {
  const url = `https://${SOURCE_HOST}${SOURCE_PATH}`;
  process.stdout.write(`Fetching ${url}…\n`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

  const rules = parseList(await response.text());
  const fetchedOn = new Date().toISOString().slice(0, 10);
  await writeFile(OUTPUT, renderList(rules, fetchedOn), 'utf8');

  const total = rules.plain.length + rules.wildcard.length + rules.exception.length;
  process.stdout.write(`✓ wrote ${total} rules to public/public-suffix-list.txt (${fetchedOn})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
