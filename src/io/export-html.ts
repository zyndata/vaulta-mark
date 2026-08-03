/**
 * Plain-HTML export — the Netscape bookmark file every browser can read. ARCHITECTURE §11.
 *
 * This is the one thing VaultaMark produces that undoes VaultaMark. The file is plaintext by
 * definition: anything that reads it learns every vaulted URL, and importing it into Chrome puts
 * those URLs back into the omnibox, which is the exact condition this product exists to avoid. It
 * ships anyway, because a bookmark manager you cannot leave is a worse thing than a file you have to
 * be warned about, and because "get my data out in a format anything can read" is not a feature a
 * user should have to reverse-engineer.
 *
 * So the gates are real and there are three of them:
 *
 * 1. A dialog that states, in the plainest sentence available, what the file is.
 * 2. A **typed** confirmation — `ui/export-gate.ts`. A checkbox is a reflex; typing is a decision.
 * 3. The warning is written into the file itself, as a leading HTML comment, because the file
 *    outlives the dialog and the person who finds it in six months was not there for it.
 *
 * The format is the 1990s Netscape one and is deliberately not negotiable: `<DL><p>` nesting,
 * `<DT><H3>` for folders, `<DT><A HREF>` for bookmarks, `ADD_DATE` in whole seconds. Every browser's
 * importer is a tolerant parser written against that shape, and improving on it means producing a
 * file that only we can read.
 */

import { listChildren } from '../vault/model.js';
import { ROOT_ID, isBookmark, isDeleted, noteOf, tagsOf, type ItemMap, type VaultItem } from '../vault/types.js';

/**
 * The phrase the user types to unlock this export.
 *
 * Not localized, deliberately: it is compared against what was typed, and a phrase that changes with
 * the UI language is a phrase that changes meaning between a screenshot and a support answer. The
 * *explanation* around it is localized; the token is not.
 */
export const PLAIN_EXPORT_PHRASE = 'EXPORT UNENCRYPTED';

export interface HtmlExportOptions {
  /** Lines of the leading comment. Supplied by the caller so the warning is localized. */
  readonly warning?: readonly string[];
  readonly now?: () => number;
  readonly onProgress?: (done: number, total: number) => void;
}

/** The default warning, in English. The UI passes localized text; this is the floor. */
export const DEFAULT_HTML_WARNING: readonly string[] = [
  'WARNING — this file is NOT encrypted.',
  'It lists every bookmark exported from VaultaMark in plain text.',
  'Anything that can read this file can read every address in it.',
  'Importing it into a browser puts those addresses back into the address bar’s suggestions,',
  'which is exactly what VaultaMark keeps them out of.',
  'Delete it once you are done with it.',
];

/**
 * Render the vault as a Netscape bookmark file.
 *
 * Folders nest as they do in the vault, in display order, so a tree that took someone an afternoon
 * to build survives the trip. Tombstones are skipped: a deleted bookmark is not part of "my
 * bookmarks" in any sense a user would recognise, and exporting one would resurrect it in whatever
 * imports the file.
 *
 * Notes and tags travel as `TAGS` and a `<DD>` note, which Chrome ignores and several other tools
 * read. Nothing is lost by including them and something is lost by not.
 */
export function exportHtml(items: ItemMap, options: HtmlExportOptions = {}): string {
  const warning = options.warning ?? DEFAULT_HTML_WARNING;
  const total = items.size;
  let done = 0;
  options.onProgress?.(0, total);

  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    `<!--\n${warning.map(escapeComment).join('\n')}\n-->`,
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];

  const walk = (parentId: string, depth: number): void => {
    const indent = '    '.repeat(depth);
    for (const item of listChildren(items, parentId)) {
      done += 1;
      if (done % PROGRESS_EVERY === 0) options.onProgress?.(done, total);
      if (isBookmark(item)) {
        lines.push(`${indent}<DT>${anchor(item)}`);
        const note = noteOf(item);
        if (note !== '') lines.push(`${indent}<DD>${escapeHtml(note)}`);
        continue;
      }
      lines.push(
        `${indent}<DT><H3 ${dateAttributes(item).join(' ')}>${escapeHtml(item.title)}</H3>`,
      );
      lines.push(`${indent}<DL><p>`);
      walk(item.id, depth + 1);
      lines.push(`${indent}</DL><p>`);
    }
  };
  walk(ROOT_ID, 1);

  lines.push('</DL><p>', '');
  options.onProgress?.(total, total);
  return lines.join('\n');
}

/** How often the progress callback fires. Often enough to move, rarely enough to be free. */
const PROGRESS_EVERY = 200;

function anchor(item: VaultItem): string {
  if (!isBookmark(item)) return '';
  const tags = tagsOf(item);
  const attributes = [
    `HREF="${escapeAttribute(item.url)}"`,
    ...dateAttributes(item),
    ...(tags.length === 0 ? [] : [`TAGS="${escapeAttribute(tags.join(','))}"`]),
  ];
  return `<A ${attributes.join(' ')}>${escapeHtml(item.title)}</A>`;
}

/** `ADD_DATE`/`LAST_MODIFIED` in whole seconds, which is what every importer expects. */
function dateAttributes(item: VaultItem): string[] {
  return [
    `ADD_DATE="${seconds(item.createdAt)}"`,
    `LAST_MODIFIED="${seconds(item.updatedAt)}"`,
  ];
}

function seconds(epochMs: number): string {
  return String(Math.floor(epochMs / 1000));
}

/**
 * Escape text for element content.
 *
 * A bookmark title is user data that arrived from a web page (`background/add.ts` takes the tab's
 * title verbatim), so it may contain anything at all — including `</A><script>`. This file is going
 * to be opened in a browser by whoever imports it.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

/**
 * Neutralise a comment terminator.
 *
 * The warning is assembled from localized strings, and a `-->` in one of them would end the comment
 * early and leave the rest of the warning rendering as page content — with everything after it
 * unmarked. Also strips control characters, so a comment cannot be smuggled shut with a newline
 * trick.
 */
function escapeComment(line: string): string {
  return line.replace(/-->/gu, '--&gt;').replace(/\p{Cc}/gu, ' ');
}

/** Live bookmarks and folders in the file this export would produce. For the confirmation dialog. */
export function htmlExportCounts(items: ItemMap): { bookmarks: number; folders: number } {
  let bookmarks = 0;
  let folders = 0;
  for (const item of items.values()) {
    if (isDeleted(item)) continue;
    if (isBookmark(item)) bookmarks += 1;
    else folders += 1;
  }
  return { bookmarks, folders };
}
