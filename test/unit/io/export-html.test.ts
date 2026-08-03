/**
 * The plain-HTML export.
 *
 * Two things are being checked, and the second matters more than the first. One: the file is valid
 * Netscape and survives a round trip through a strict reader, because a backup no browser can import
 * is not an escape hatch. Two: **nothing from the vault reaches the file as markup.** A bookmark
 * title arrives from a web page verbatim, this file is going to be opened in a browser by whoever
 * imports it, and `</A><script>` in a title is not a hypothetical shape for hostile input — it is
 * the obvious one.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HTML_WARNING,
  PLAIN_EXPORT_PHRASE,
  escapeHtml,
  exportHtml,
  htmlExportCounts,
} from '../../../src/io/export-html.js';
import { T0, bookmark, deleted, folder, itemMap } from '../../helpers/items.js';
import { flattenParsed, parseNetscape } from '../../helpers/netscape.js';

const VAULT = itemMap(
  folder('f1', { title: 'Work', order: 'a0' }),
  folder('f2', { title: 'Deep', parentId: 'f1', order: 'a0' }),
  bookmark('b1', {
    parentId: 'f2',
    title: 'Spec',
    url: 'https://example.com/spec?a=1&b=2',
    order: 'a0',
    tags: ['reading', 'work'],
    note: 'read chapter 3',
  }),
  bookmark('b2', { title: 'Home', url: 'https://example.com/', order: 'a1' }),
  deleted(bookmark('b3', { title: 'Gone', order: 'a2' })),
);

describe('exportHtml', () => {
  it('produces a file the importer parses back', () => {
    const parsed = parseNetscape(exportHtml(VAULT));

    expect(parsed.roots).toHaveLength(2);
    const work = parsed.roots[0];
    expect(work).toMatchObject({ kind: 'folder', title: 'Work' });
    if (work?.kind !== 'folder') throw new Error('first root should be the folder');

    const deep = work.children[0];
    expect(deep).toMatchObject({ kind: 'folder', title: 'Deep' });
    if (deep?.kind !== 'folder') throw new Error('Work should contain Deep');

    expect(deep.children[0]).toEqual({
      kind: 'bookmark',
      title: 'Spec',
      url: 'https://example.com/spec?a=1&b=2',
      addDate: Math.floor(T0 / 1000),
      tags: ['reading', 'work'],
      note: 'read chapter 3',
    });
  });

  it('preserves the whole folder tree and every live bookmark', () => {
    const parsed = parseNetscape(exportHtml(VAULT));
    expect(flattenParsed(parsed.roots).map((entry) => entry.title).sort()).toEqual(['Home', 'Spec']);
  });

  it('leaves tombstones out — an export must not resurrect a deletion', () => {
    expect(exportHtml(VAULT)).not.toContain('Gone');
  });

  it('carries the warning as a leading comment', () => {
    const parsed = parseNetscape(exportHtml(VAULT));
    expect(parsed.warning).toEqual([...DEFAULT_HTML_WARNING]);
    expect(exportHtml(VAULT).indexOf('<!--')).toBeLessThan(exportHtml(VAULT).indexOf('<DL><p>'));
  });

  it('uses the caller-supplied warning, so the file is localized', () => {
    const html = exportHtml(VAULT, { warning: ['Uwaga — ten plik nie jest zaszyfrowany.'] });
    expect(parseNetscape(html).warning).toEqual(['Uwaga — ten plik nie jest zaszyfrowany.']);
  });

  it('cannot have its warning comment closed early by a localized string', () => {
    const html = exportHtml(VAULT, { warning: ['sneaky --> <script>alert(1)</script>'] });
    // One comment, closed exactly once, and the script tag is inside it.
    expect(html.split('-->')).toHaveLength(2);
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('-->'));
  });

  it('strips control characters from the warning', () => {
    const bell = String.fromCharCode(7);
    const html = exportHtml(VAULT, { warning: [`line${bell}one`] });
    expect(html).not.toContain(bell);
    expect(parseNetscape(html).warning).toEqual(['line one']);
  });

  it('escapes a hostile title rather than emitting it as markup', () => {
    const hostile = itemMap(
      bookmark('x', {
        title: '</A><script>alert(1)</script>',
        url: 'https://example.com/?q="><img onerror=alert(1) src=x>',
        note: '<b>note</b>',
      }),
    );
    const html = exportHtml(hostile);

    // No tag from user data survives as a tag. The characters are still there — `onerror=alert(1)`
    // reads back verbatim below — but every `<` and `>` around them is an entity, so a browser
    // parsing this file sees text where the attacker wrote markup.
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    // And it survives the trip: escaping is not the same as mangling.
    const parsed = flattenParsed(parseNetscape(html).roots);
    expect(parsed[0]?.title).toBe('</A><script>alert(1)</script>');
    expect(parsed[0]?.url).toBe('https://example.com/?q="><img onerror=alert(1) src=x>');
    expect(parsed[0]?.note).toBe('<b>note</b>');
  });

  it('escapes an apostrophe in an attribute', () => {
    const html = exportHtml(itemMap(bookmark('x', { url: "https://example.com/it's" })));
    expect(html).toContain('&#39;');
  });

  it('reports progress', () => {
    const many = itemMap(
      ...Array.from({ length: 450 }, (_unused, index) =>
        bookmark(`b${String(index)}`, { order: `a${String(index).padStart(4, '0')}` }),
      ),
    );
    const seen: number[] = [];
    exportHtml(many, { onProgress: (done) => seen.push(done) });
    expect(seen[0]).toBe(0);
    expect(seen).toContain(200);
    expect(seen.at(-1)).toBe(450);
  });

  it('renders an empty vault as a valid empty file', () => {
    const parsed = parseNetscape(exportHtml(new Map()));
    expect(parsed.roots).toEqual([]);
  });
});

describe('escapeHtml', () => {
  it('escapes ampersands before the entities it introduces', () => {
    expect(escapeHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });
});

describe('htmlExportCounts', () => {
  it('counts live bookmarks and folders only', () => {
    expect(htmlExportCounts(VAULT)).toEqual({ bookmarks: 2, folders: 2 });
  });
});

describe('PLAIN_EXPORT_PHRASE', () => {
  it('is the literal the UI gate compares against, and is not localized', () => {
    // Pinned by a test because it is a token, not a sentence: a phrase that changed with the UI
    // language would mean something different in a screenshot than in a support answer.
    expect(PLAIN_EXPORT_PHRASE).toBe('EXPORT UNENCRYPTED');
  });
});
