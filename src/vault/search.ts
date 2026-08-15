/**
 * In-memory search over the unlocked vault.
 *
 * The index is built on unlock and thrown away on lock, along with everything else derived from
 * plaintext. It is never persisted: a search index *is* the vault content, reorganised, so writing
 * one to `storage.local` would put titles and URLs on disk in the clear and break INV-6 — which is
 * exactly the kind of accident that makes a "we encrypt everything" claim false.
 *
 * Matching is deliberately generous. A bookmark manager that cannot find `github` in
 * `https://github.com/…` because the user did not type a word boundary is useless, so every term
 * matches as an exact token, a token prefix, **or** a substring anywhere in the field, in that
 * order of confidence. Multiple terms are AND-ed; the `tag:`, `folder:`, `host:` and `in:` prefixes
 * filter rather than score.
 *
 * Text is folded to NFKD with combining marks stripped, so `Beyoncé` is found by `beyonce` and
 * `Straße`-style input does not depend on which of two equivalent encodings the page used. Folding
 * changes a string's length, which is why {@link foldWithMap} exists: highlighting a match in the
 * *original* text needs to know where each folded character came from.
 */

import { ROOT_ID, isBookmark, isDeleted, isFolder, noteOf, tagsOf, type VaultItem } from './types.js';

/** Relative confidence per field. Title beats URL beats note; tags sit near the top on purpose. */
const FIELD_WEIGHTS = { title: 4, tags: 3, url: 2, note: 1 } as const;

export type FieldName = keyof typeof FIELD_WEIGHTS;

const FIELD_NAMES = Object.keys(FIELD_WEIGHTS) as readonly FieldName[];

interface IndexedField {
  readonly name: FieldName;
  readonly text: string;
  readonly tokens: readonly string[];
}

interface IndexEntry {
  readonly item: VaultItem;
  readonly fields: readonly IndexedField[];
  readonly tags: ReadonlySet<string>;
  /** Folded host, for `host:`. Empty for a folder and for a URL that will not parse. */
  readonly host: string;
}

export interface SearchIndex {
  /** Live (non-tombstoned) items in the index. */
  readonly size: number;
  readonly entries: readonly IndexEntry[];
  readonly parents: ReadonlyMap<string, string>;
  /** Folded titles of the live folders, by id — what `folder:` is matched against. */
  readonly folderTitles: ReadonlyMap<string, string>;
}

export interface SearchOptions {
  /** Restrict to this folder's subtree. `ROOT_ID` means the whole vault. */
  readonly folderId?: string;
  /** Include folders in the results. Off by default: folder titles rarely answer a search. */
  readonly includeFolders?: boolean;
  readonly limit?: number;
}

export interface SearchHit {
  readonly item: VaultItem;
  readonly score: number;
}

/** A parsed query: free-text terms plus the filters lifted out of it. */
export interface ParsedQuery {
  readonly terms: readonly string[];
  readonly tags: readonly string[];
  /** Folded folder-title fragments from `folder:`. An item matches via any ancestor. */
  readonly folders: readonly string[];
  /** Folded host fragments from `host:`. */
  readonly hosts: readonly string[];
  /** Fields the free terms are restricted to, from `in:`. Empty means "any field". */
  readonly fields: readonly FieldName[];
}

/** Whether a parsed query asks for anything at all. */
export function isEmptyQuery(query: ParsedQuery): boolean {
  return (
    query.terms.length === 0 &&
    query.tags.length === 0 &&
    query.folders.length === 0 &&
    query.hosts.length === 0
  );
}

/**
 * Fold text for comparison: NFKD, combining marks stripped, lowercased.
 *
 * NFKD rather than NFD so that compatibility forms fold too — a fullwidth or ligature character
 * pasted from a PDF should still be found by the ASCII the user types.
 */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/**
 * Fold text and keep a map back to the original.
 *
 * Folding is not length-preserving: `é` becomes one character, `ﬁ` becomes two, and a combining
 * mark disappears entirely. Highlighting a hit means painting a range of the string the *user*
 * wrote, so a match found at folded offset `i` has to be translated back through `map[i]`, which is
 * the index of the code point it came from. Folding one code point at a time is what makes that
 * map exist at all.
 */
export function foldWithMap(text: string): { folded: string; map: readonly number[] } {
  let folded = '';
  const map: number[] = [];
  let at = 0;
  for (const codePoint of text) {
    const piece = foldText(codePoint);
    // One entry per UTF-16 unit, not per code point: `map` is indexed by `String.indexOf`, which
    // counts units, so an astral character needs two entries pointing at the same origin.
    map.push(...Array.from<number>({ length: piece.length }).fill(at));
    folded += piece;
    at += codePoint.length;
  }
  return { folded, map };
}

/** Lift the `tag:`, `folder:`, `host:` and `in:` filters out of a query and fold the rest. */
export function parseQuery(query: string): ParsedQuery {
  const terms: string[] = [];
  const tags: string[] = [];
  const folders: string[] = [];
  const hosts: string[] = [];
  const fields: FieldName[] = [];

  for (const word of query.split(/\s+/u)) {
    if (word === '') continue;
    const filter = /^(tag|folder|host|in):(.+)$/iu.exec(word);
    const kind = filter?.[1]?.toLowerCase();
    const value = filter?.[2];
    if (kind === undefined || value === undefined) {
      terms.push(foldText(word));
      continue;
    }
    switch (kind) {
      case 'tag':
        tags.push(foldText(value));
        break;
      case 'folder':
        folders.push(foldText(value));
        break;
      case 'host':
        hosts.push(foldText(value));
        break;
      default: {
        // An unknown field name is treated as an ordinary term rather than as an empty restriction.
        // `in:noets` silently matching everything is the worst of the three possible behaviours.
        const name = foldText(value);
        if (isFieldName(name)) {
          if (!fields.includes(name)) fields.push(name);
        } else terms.push(foldText(word));
      }
    }
  }
  return { terms, tags, folders, hosts, fields };
}

function isFieldName(value: string): value is FieldName {
  return (FIELD_NAMES as readonly string[]).includes(value);
}

/** Split folded text into tokens on anything that is not a letter or a digit. */
export function tokenize(folded: string): string[] {
  return folded.split(/[^\p{L}\p{N}]+/u).filter((token) => token !== '');
}

/** Build the index. Tombstones are skipped — a deleted bookmark must not be findable. */
export function buildSearchIndex(items: Iterable<VaultItem>): SearchIndex {
  const entries: IndexEntry[] = [];
  const parents = new Map<string, string>();
  const folderTitles = new Map<string, string>();

  for (const item of items) {
    parents.set(item.id, item.parentId);
    if (isDeleted(item)) continue;
    if (isFolder(item)) folderTitles.set(item.id, foldText(item.title));

    const itemTags = tagsOf(item).map(foldText);
    const fields: IndexedField[] = [field('title', item.title)];
    let host = '';
    if (isBookmark(item)) {
      fields.push(field('url', searchableUrl(item.url)));
      if (itemTags.length > 0) fields.push(field('tags', itemTags.join(' ')));
      const note = noteOf(item);
      if (note !== '') fields.push(field('note', note));
      host = foldText(hostOf(item.url));
    }
    entries.push({ item, fields, tags: new Set(itemTags), host });
  }

  return { size: entries.length, entries, parents, folderTitles };
}

/**
 * Run a query. Every term must match somewhere; every filter must match.
 *
 * An empty query returns nothing rather than everything: the caller that wants "everything" has
 * `listChildren`, and returning the whole vault from an empty search box makes the UI flash the
 * entire collection on the way to the first keystroke.
 */
export function search(
  index: SearchIndex,
  query: string | ParsedQuery,
  options: SearchOptions = {},
): SearchHit[] {
  const parsed = typeof query === 'string' ? parseQuery(query) : query;
  if (isEmptyQuery(parsed)) return [];
  const { terms, tags, folders, hosts, fields } = parsed;

  const scope = options.folderId;
  const hits: SearchHit[] = [];

  for (const entry of index.entries) {
    if (!isBookmark(entry.item) && options.includeFolders !== true) continue;
    if (scope !== undefined && scope !== ROOT_ID && !isWithin(index, entry.item.id, scope)) continue;
    if (!tags.every((tag) => entry.tags.has(tag))) continue;
    if (!hosts.every((host) => entry.host.includes(host))) continue;
    if (!folders.every((folder) => hasAncestorTitled(index, entry.item.id, folder))) continue;

    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      const termScore = scoreTerm(entry, term, fields);
      if (termScore === 0) {
        matchedAll = false;
        break;
      }
      score += termScore;
    }
    if (!matchedAll) continue;
    hits.push({ item: entry.item, score: terms.length === 0 ? FIELD_WEIGHTS.tags : score });
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      b.item.updatedAt - a.item.updatedAt ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );
  return options.limit === undefined ? hits : hits.slice(0, options.limit);
}

/* ------------------------------------------------------------------ highlighting */

export interface MatchRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Where `terms` occur in `text`, as ranges into the **original** string.
 *
 * Matching is done on the folded form so that `beyonce` highlights `Beyoncé`, and the offsets are
 * translated back through the fold map so the UI can wrap the characters the user actually typed.
 * Overlapping and adjacent hits are merged, so `git` and `github` on the same title produce one
 * highlight rather than two nested ones.
 */
export function matchRanges(text: string, terms: readonly string[]): MatchRange[] {
  const wanted = terms.filter((term) => term !== '');
  if (wanted.length === 0 || text === '') return [];

  const { folded, map } = foldWithMap(text);
  const found: MatchRange[] = [];
  for (const term of wanted) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at === -1) break;
      const start = map[at] ?? 0;
      const end = map[at + term.length] ?? text.length;
      if (end > start) found.push({ start, end });
      // `at + 1`, not `at + term.length`: overlapping occurrences of the same term are still
      // occurrences, and the merge below collapses whatever overlaps.
      from = at + 1;
    }
  }
  return mergeRanges(found);
}

function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MatchRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      if (range.end > last.end) merged[merged.length - 1] = { start: last.start, end: range.end };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

/* ------------------------------------------------------------------ internals */

function field(name: FieldName, text: string): IndexedField {
  const folded = foldText(text);
  return { name, text: folded, tokens: tokenize(folded) };
}

/**
 * The part of a URL worth searching: host and path, with the scheme and the `www.` prefix dropped.
 *
 * Leaving `https://` in every entry would mean every single-letter query starting with `h` matched
 * every bookmark, which is noise, not recall. The query string is kept — people do search for an
 * article id.
 */
function searchableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./u, '');
    return `${host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** The host `host:` matches against, `www.` included — people type it either way. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** 0 when the term is absent; higher when the match is more confident. */
function scoreTerm(entry: IndexEntry, term: string, fields: readonly FieldName[]): number {
  let best = 0;
  for (const indexed of entry.fields) {
    if (fields.length > 0 && !fields.includes(indexed.name)) continue;
    const weight = FIELD_WEIGHTS[indexed.name];
    let kind = 0;
    if (indexed.tokens.includes(term)) kind = 3;
    else if (indexed.tokens.some((token) => token.startsWith(term))) kind = 2;
    else if (indexed.text.includes(term)) kind = 1;
    best = Math.max(best, weight * kind);
  }
  return best;
}

/** Whether `itemId` sits anywhere under `folderId`. Cycle-guarded: a merge can produce one. */
function isWithin(index: SearchIndex, itemId: string, folderId: string): boolean {
  const seen = new Set<string>();
  let current = index.parents.get(itemId);
  while (current !== undefined && current !== ROOT_ID && !seen.has(current)) {
    if (current === folderId) return true;
    seen.add(current);
    current = index.parents.get(current);
  }
  return current === folderId;
}

/** Whether any ancestor folder's title contains `fragment`. Cycle-guarded, like {@link isWithin}. */
function hasAncestorTitled(index: SearchIndex, itemId: string, fragment: string): boolean {
  const seen = new Set<string>();
  let current = index.parents.get(itemId);
  while (current !== undefined && current !== ROOT_ID && !seen.has(current)) {
    if ((index.folderTitles.get(current) ?? '').includes(fragment)) return true;
    seen.add(current);
    current = index.parents.get(current);
  }
  return false;
}
