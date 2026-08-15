/**
 * A strict reader for the Netscape bookmark file, for the export's round-trip test.
 *
 * It lives in the test tree rather than in `src/` deliberately: Phase 8 ships an HTML *exporter* and
 * no HTML importer (PLAN §9 scopes the import files explicitly, and none of them is this one), so
 * putting a parser in the product would be widening the phase. What the round trip needs is
 * something that reads the format the way another browser's importer would — and reads it
 * *strictly*, so a malformed export fails the test rather than being tolerated into looking fine.
 *
 * Deliberately not `DOMParser`: it is not available in a service worker, and more to the point a
 * forgiving HTML parser would happily recover from exactly the mistakes this test exists to catch.
 */

export interface ParsedBookmark {
  readonly kind: 'bookmark';
  readonly title: string;
  readonly url: string;
  readonly addDate: number;
  readonly tags: readonly string[];
  readonly note: string;
}

export interface ParsedFolder {
  readonly kind: 'folder';
  readonly title: string;
  readonly addDate: number;
  readonly children: readonly ParsedNode[];
}

export type ParsedNode = ParsedBookmark | ParsedFolder;

export interface ParsedFile {
  /** Lines of the leading `<!-- … -->` comment, trimmed. */
  readonly warning: readonly string[];
  readonly roots: readonly ParsedNode[];
}

/** Parse a Netscape bookmark file, throwing on anything the format does not allow. */
export function parseNetscape(text: string): ParsedFile {
  if (!text.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')) {
    throw new Error('missing the Netscape doctype');
  }

  const commentStart = text.indexOf('<!--');
  const commentEnd = text.indexOf('-->');
  if (commentStart === -1 || commentEnd < commentStart) throw new Error('missing warning comment');
  const warning = text
    .slice(commentStart + 4, commentEnd)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const lines = text.split('\n').map((line) => line.trim());
  let at = lines.findIndex((line) => line === '<DL><p>');
  if (at === -1) throw new Error('missing the root list');

  const parseList = (): ParsedNode[] => {
    const out: ParsedNode[] = [];
    at += 1;
    for (;;) {
      const line = lines[at];
      if (line === undefined) throw new Error('list is not closed');
      if (line === '</DL><p>') return out;
      if (line === '') {
        at += 1;
        continue;
      }

      const folder = /^<DT><H3 ([^>]*)>(.*)<\/H3>$/u.exec(line);
      if (folder !== null) {
        at += 1;
        if (lines[at] !== '<DL><p>') throw new Error('folder is not followed by a list');
        const children = parseList();
        at += 1;
        out.push({
          kind: 'folder',
          title: decode(folder[2] ?? ''),
          addDate: Number(attribute(folder[1] ?? '', 'ADD_DATE')),
          children,
        });
        continue;
      }

      const bookmark = /^<DT><A ([^>]*)>(.*)<\/A>$/u.exec(line);
      if (bookmark === null) throw new Error(`unexpected line: ${line}`);
      const attributes = bookmark[1] ?? '';
      at += 1;

      let note = '';
      const next = lines[at];
      if (next?.startsWith('<DD>') === true) {
        note = decode(next.slice(4));
        at += 1;
      }
      const tags = attribute(attributes, 'TAGS');
      out.push({
        kind: 'bookmark',
        title: decode(bookmark[2] ?? ''),
        url: decode(attribute(attributes, 'HREF')),
        addDate: Number(attribute(attributes, 'ADD_DATE')),
        tags: tags === '' ? [] : tags.split(','),
        note,
      });
    }
  };

  return { warning, roots: parseList() };
}

function attribute(attributes: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`, 'u').exec(attributes);
  return decode(match?.[1] ?? '');
}

/** The five entities the writer produces, and nothing else — a strict reader for a strict writer. */
function decode(text: string): string {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, '&');
}

/** Every bookmark in a parsed tree, depth first. */
export function flattenParsed(nodes: readonly ParsedNode[]): ParsedBookmark[] {
  return nodes.flatMap((node) =>
    node.kind === 'bookmark' ? [node] : flattenParsed(node.children),
  );
}
