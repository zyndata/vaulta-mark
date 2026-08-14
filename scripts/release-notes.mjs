#!/usr/bin/env node
/**
 * Extracts one version's section out of `CHANGELOG.md` for a GitHub Release body (PLAN §9
 * Phase 13, RELEASE §7).
 *
 * The changelog is written by hand, for users, in the same commit as the change it describes
 * (RELEASE §1). Nothing here generates prose from commit subjects; this only *finds* the section
 * that was already written and hands it to `softprops/action-gh-release` as `body_path`.
 *
 * Two refusals are the point of the script rather than incidental to it:
 *
 * - **`[Unreleased]` is never a release.** Asking for the notes of a version whose section was
 *   never renamed is the exact mistake step 3 of RELEASE §4 exists to prevent, and the failure
 *   mode without this check is a release published under the heading of the next one.
 * - **An empty section fails.** A tagged version with nothing written under it means the changelog
 *   was not finalized, and a Release with an empty body is worse than a failed workflow step —
 *   it is only noticed after users have seen it.
 *
 * The heading itself is dropped: the Release is already titled with its tag, so repeating
 * `## [1.2.3] - 2026-08-14` above the body reads as a stray artifact. HTML comments are dropped
 * too — they are editorial notes addressed to whoever edits the file next, not to users.
 *
 * Usage: node scripts/release-notes.mjs v1.2.3 [--changelog CHANGELOG.md]
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export class ReleaseNotesError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ReleaseNotesError';
  }
}

/**
 * `v1.2.3` and `1.2.3` are the same request. The tag prefix is a git convention; the changelog
 * heading carries the bare SemVer string, and neither side should have to know about the other.
 *
 * @param {string} tag
 * @returns {string}
 */
export function versionOf(tag) {
  const trimmed = String(tag ?? '').trim();
  if (trimmed === '') throw new ReleaseNotesError('No tag given. Usage: release-notes.mjs v1.2.3');

  const version = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
  if (/^unreleased$/i.test(version)) {
    throw new ReleaseNotesError(
      '"Unreleased" is not a version. Rename the section to `## [X.Y.Z] - YYYY-MM-DD` first '
        + '(RELEASE §4 step 3).',
    );
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ReleaseNotesError(`"${tag}" is not a SemVer version — expected something like v1.2.3.`);
  }
  return version;
}

/** A `## ` heading at the start of a line ends a section; `### Added` inside one does not. */
const SECTION = /^## +\[?([^\]\s]+)\]?(?:\s*[-–]\s*(\S+))?\s*$/;

/**
 * @param {string} changelog
 * @param {string} tag
 * @returns {{ version: string, date: string | null, body: string }}
 */
export function extractNotes(changelog, tag) {
  const version = versionOf(tag);
  const lines = changelog.split(/\r?\n/);

  let start = -1;
  let date = null;
  /** @type {string[]} */
  const found = [];

  for (const [index, line] of lines.entries()) {
    const match = SECTION.exec(line);
    if (!match) continue;

    if (start === -1 && match[1] === version) {
      start = index + 1;
      date = match[2] ?? null;
      continue;
    }
    if (start !== -1) {
      return { version, date, body: clean(lines.slice(start, index)) };
    }
    found.push(match[1] ?? '');
  }

  if (start === -1) {
    throw new ReleaseNotesError(
      `No \`## [${version}]\` section in the changelog. It has: ${found.join(', ') || '(no sections)'}.`,
    );
  }
  return { version, date, body: clean(lines.slice(start)) };
}

/**
 * Link-reference definitions are dropped. The block at the foot of the file belongs to the
 * document rather than to whichever section happens to be last, and it would otherwise be carried
 * into the notes of the newest release every time. They render as nothing, so this is only ever a
 * loss for a section written in reference style — this changelog links inline.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function clean(lines) {
  const kept = lines
    .filter((line) => !/^\[[^\]]+\]:\s*\S+\s*$/.test(line))
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '');
  return `${kept.trim()}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  let path = resolve(repoRoot, 'CHANGELOG.md');
  let tag = '';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--changelog') {
      path = resolve(process.cwd(), args[i + 1] ?? '');
      i += 1;
    } else if (tag === '') {
      tag = args[i] ?? '';
    }
  }

  try {
    const { version, body } = extractNotes(await readFile(path, 'utf8'), tag);
    if (body.trim() === '') {
      throw new ReleaseNotesError(
        `The \`## [${version}]\` section is empty. A release with no notes is a release nobody can `
          + 'read; write the section before tagging.',
      );
    }
    process.stdout.write(body);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
