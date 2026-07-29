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
 * order of confidence. Multiple terms are AND-ed; `tag:foo` filters rather than scores.
 *
 * Text is folded to NFKD with combining marks stripped, so `Beyoncé` is found by `beyonce` and
 * `Straße`-style input does not depend on which of two equivalent encodings the page used.
 */

import { ROOT_ID, isBookmark, isDeleted, noteOf, tagsOf, type VaultItem } from './types.js';

/** Relative confidence per field. Title beats URL beats note; tags sit near the top on purpose. */
const FIELD_WEIGHTS = { title: 4, tags: 3, url: 2, note: 1 } as const;

type FieldName = keyof typeof FIELD_WEIGHTS;

interface IndexedField {
  readonly name: FieldName;
  readonly text: string;
  readonly tokens: readonly string[];
}

interface IndexEntry {
  readonly item: VaultItem;
  readonly fields: readonly IndexedField[];
  readonly tags: ReadonlySet<string>;
}

export interface SearchIndex {
  /** Live (non-tombstoned) items in the index. */
  readonly size: number;
  readonly entries: readonly IndexEntry[];
  readonly parents: ReadonlyMap<string, string>;
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

/** A parsed query: free-text terms plus the tag filters lifted out of it. */
export interface ParsedQuery {
  readonly terms: readonly string[];
  readonly tags: readonly string[];
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

/** Split folded text into tokens on anything that is not a letter or a digit. */
export function tokenize(folded: string): string[] {
  return folded.split(/[^\p{L}\p{N}]+/u).filter((token) => token !== '');
}

/** Lift `tag:` filters out of a query and fold the rest into search terms. */
export function parseQuery(query: string): ParsedQuery {
  const terms: string[] = [];
  const tags: string[] = [];
  for (const word of query.split(/\s+/u)) {
    if (word === '') continue;
    const tagMatch = /^tag:(.+)$/iu.exec(word);
    if (tagMatch?.[1] !== undefined) {
      tags.push(foldText(tagMatch[1]));
      continue;
    }
    terms.push(foldText(word));
  }
  return { terms, tags };
}

/** Build the index. Tombstones are skipped — a deleted bookmark must not be findable. */
export function buildSearchIndex(items: Iterable<VaultItem>): SearchIndex {
  const entries: IndexEntry[] = [];
  const parents = new Map<string, string>();

  for (const item of items) {
    parents.set(item.id, item.parentId);
    if (isDeleted(item)) continue;

    const itemTags = tagsOf(item).map(foldText);
    const fields: IndexedField[] = [field('title', item.title)];
    if (isBookmark(item)) {
      fields.push(field('url', searchableUrl(item.url)));
      if (itemTags.length > 0) fields.push(field('tags', itemTags.join(' ')));
      const note = noteOf(item);
      if (note !== '') fields.push(field('note', note));
    }
    entries.push({ item, fields, tags: new Set(itemTags) });
  }

  return { size: entries.length, entries, parents };
}

/**
 * Run a query. Every term must match somewhere; every `tag:` filter must match exactly.
 *
 * An empty query returns nothing rather than everything: the caller that wants "everything" has
 * `listChildren`, and returning the whole vault from an empty search box makes the UI flash the
 * entire collection on the way to the first keystroke.
 */
export function search(
  index: SearchIndex,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const { terms, tags } = parseQuery(query);
  if (terms.length === 0 && tags.length === 0) return [];

  const scope = options.folderId;
  const hits: SearchHit[] = [];

  for (const entry of index.entries) {
    if (!isBookmark(entry.item) && options.includeFolders !== true) continue;
    if (scope !== undefined && scope !== ROOT_ID && !isWithin(index, entry.item.id, scope))
      continue;
    if (!tags.every((tag) => entry.tags.has(tag))) continue;

    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      const termScore = scoreTerm(entry, term);
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

/** 0 when the term is absent; higher when the match is more confident. */
function scoreTerm(entry: IndexEntry, term: string): number {
  let best = 0;
  for (const indexed of entry.fields) {
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
