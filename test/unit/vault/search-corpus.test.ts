/**
 * Search against a 2,000-item vault: precision, recall, and the query-latency budget
 * (PLAN §9 Phase 6).
 *
 * The corpus is **generated deterministically here rather than committed as JSON**. Two reasons:
 * a 2,000-entry fixture file is unreviewable, and PLAN §8.1 bans committing anything that looks
 * like a real vault — a file full of plausible titles and URLs is exactly the thing a reader should
 * never have to decide about. The generator is seeded, so a failure reproduces exactly.
 *
 * The shape of the corpus is what makes the table meaningful: ~1,980 **filler** items whose every
 * word is nonsense prefixed with `zz`, and a couple of dozen **probe** items with hand-written
 * content. No probe word occurs in the filler, so a query's expected answer is exactly the probes
 * that should match — which turns "did we find it" (recall) and "did we find only it" (precision)
 * into a single `toEqual`.
 */

import { describe, expect, it } from 'vitest';

import { addItem, toItemMap, type MutationContext } from '../../../src/vault/model.js';
import { buildSearchIndex, search, type SearchIndex } from '../../../src/vault/search.js';
import type { ItemMap, VaultItem } from '../../../src/vault/types.js';

const NOW = 1_750_000_000_000;
const FILLER_COUNT = 1_990;

/** Per-query budget from PLAN §9 Phase 6. */
const LATENCY_BUDGET_MS = 20;

function context(prefix: string): MutationContext {
  let next = 0;
  return { now: NOW, rev: 1, newId: () => `${prefix}-${String(++next)}` };
}

/* ------------------------------------------------------------------ the corpus */

interface Probe {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly tags?: readonly string[];
  readonly note?: string;
  readonly folder?: string;
}

const FOLDERS: Record<string, { readonly title: string; readonly parent?: string }> = {
  work: { title: 'Work' },
  research: { title: 'Research', parent: 'work' },
  kitchen: { title: 'Kitchen' },
};

const PROBES: readonly Probe[] = [
  {
    id: 'p-github',
    title: 'GitHub · Where software is built',
    url: 'https://github.com/explore',
    tags: ['dev', 'daily'],
  },
  {
    id: 'p-gitlab',
    title: 'GitLab handbook',
    url: 'https://about.gitlab.com/handbook/',
    tags: ['dev'],
  },
  {
    id: 'p-padding',
    title: 'Padding oracles, revisited',
    url: 'https://eprint.iacr.org/2024/1337',
    tags: ['crypto', 'papers'],
    note: 'Section 3 explains the CBC variant and why it survived so long',
    folder: 'research',
  },
  {
    id: 'p-lattice',
    title: 'Lattice reduction in practice',
    url: 'https://eprint.iacr.org/2023/0042',
    tags: ['crypto', 'papers'],
    note: 'Skim the appendix before the seminar',
    folder: 'research',
  },
  {
    id: 'p-standup',
    title: 'Quarterly planning',
    url: 'https://intranet.acme-internal.test/planning?quarter=2026Q1',
    tags: ['planning'],
    folder: 'work',
  },
  {
    id: 'p-okr',
    title: 'OKR review notes',
    url: 'https://intranet.acme-internal.test/okr',
    note: 'Planning owns the roadmap column this quarter',
    folder: 'work',
  },
  {
    id: 'p-cafe',
    title: 'Café Beyoncé — résumé of a résumé',
    url: 'https://culture.acme-internal.test/cafe',
    tags: ['música'],
  },
  {
    id: 'p-risotto',
    title: 'Mushroom risotto, properly',
    url: 'https://cooking.acme-internal.test/risotto',
    tags: ['recipe', 'dinner'],
    note: 'Toast the rice until it squeaks',
    folder: 'kitchen',
  },
  {
    id: 'p-bread',
    title: 'Overnight bread',
    url: 'https://cooking.acme-internal.test/bread',
    tags: ['recipe'],
    folder: 'kitchen',
  },
  {
    id: 'p-untagged',
    title: 'A page with nothing on it',
    url: 'https://lonely.acme-internal.test/nothing',
  },
];

/**
 * Filler that cannot be confused with a probe.
 *
 * Every token starts with `zz`, and the serial number is spelled in **letters** rather than digits.
 * Both details are load-bearing. A term matches as a substring anywhere in a field, not only as a
 * whole token, so a filler item numbered `zzn1337` would answer a probe query for the article id
 * `1337` — a real match by the rules, and a false positive for this table. With no digit anywhere
 * in the filler, no probe query can reach it, which is what lets each row assert an exact id set
 * instead of "contains".
 */
function fillerItem(index: number): { title: string; url: string; tags: string[] } {
  const n = `zz${serial(index)}`;
  return {
    title: `zztitle ${n} zzsubject zzdetail`,
    url: `https://${n}.zzhost.test/zzpath/${n}`,
    tags: [`zztag${serial(index % 17)}`],
  };
}

/** A fixed-width, digit-free serial: 0 → `aaaa`, 27 → `aabb`. */
function serial(index: number): string {
  let out = '';
  for (let place = 0; place < 4; place++) {
    out = String.fromCharCode(97 + (Math.floor(index / 26 ** place) % 26)) + out;
  }
  return out;
}

function buildCorpus(): { items: ItemMap; index: SearchIndex } {
  let items: ItemMap = new Map();
  const ctx = context('corpus');

  for (const [key, folder] of Object.entries(FOLDERS)) {
    items = addItem(
      items,
      {
        type: 'folder',
        id: key,
        title: folder.title,
        ...(folder.parent === undefined ? {} : { parentId: folder.parent }),
      },
      ctx,
    ).items;
  }

  for (const probe of PROBES) {
    items = addItem(
      items,
      {
        type: 'bookmark',
        id: probe.id,
        title: probe.title,
        url: probe.url,
        ...(probe.tags === undefined ? {} : { tags: probe.tags }),
        ...(probe.note === undefined ? {} : { note: probe.note }),
        ...(probe.folder === undefined ? {} : { parentId: probe.folder }),
      },
      ctx,
    ).items;
  }

  for (let i = 0; i < FILLER_COUNT; i++) {
    const filler = fillerItem(i);
    items = addItem(
      items,
      { type: 'bookmark', id: `f-${String(i)}`, ...filler },
      ctx,
    ).items;
  }

  return { items, index: buildSearchIndex(items.values()) };
}

const { items: CORPUS, index: INDEX } = buildCorpus();

function ids(hits: readonly { item: VaultItem }[]): string[] {
  return hits.map((hit) => hit.item.id).toSorted();
}

/* ------------------------------------------------------------------ the table */

/** `[query, expected ids]`. Exact sets: anything extra is a precision failure. */
const CASES: readonly (readonly [string, readonly string[]])[] = [
  // --- bare terms, across every indexed field
  ['github', ['p-github']],
  ['GITHUB', ['p-github']],
  ['git', ['p-github', 'p-gitlab']],
  ['padding', ['p-padding']],
  ['lattice', ['p-lattice']],
  ['risotto', ['p-risotto']],
  ['squeaks', ['p-risotto']],
  ['handbook', ['p-gitlab']],
  ['explore', ['p-github']],
  ['1337', ['p-padding']],
  ['2026q1', ['p-standup']],
  // --- substring, not just prefix or token
  ['ranet', ['p-okr', 'p-standup']],
  ['isott', ['p-risotto']],
  // --- diacritic and compatibility folding, both directions
  ['beyonce', ['p-cafe']],
  ['Beyoncé', ['p-cafe']],
  ['musica', ['p-cafe']],
  ['RÉSUMÉ', ['p-cafe']],
  // --- multiple terms are AND-ed
  ['planning quarterly', ['p-standup']],
  ['planning roadmap', ['p-okr']],
  ['padding github', []],
  // --- tag:
  ['tag:recipe', ['p-bread', 'p-risotto']],
  ['tag:crypto', ['p-lattice', 'p-padding']],
  ['tag:recipe bread', ['p-bread']],
  ['tag:crypto tag:papers', ['p-lattice', 'p-padding']],
  ['tag:nonexistent', []],
  // --- folder:, including through a grandparent
  ['folder:kitchen', ['p-bread', 'p-risotto']],
  ['folder:research', ['p-lattice', 'p-padding']],
  ['folder:work', ['p-lattice', 'p-okr', 'p-padding', 'p-standup']],
  ['folder:work tag:papers', ['p-lattice', 'p-padding']],
  // --- host:
  ['host:github.com', ['p-github']],
  ['host:eprint.iacr.org', ['p-lattice', 'p-padding']],
  ['host:cooking.acme-internal.test', ['p-bread', 'p-risotto']],
  // --- in:
  ['in:note planning', ['p-okr']],
  ['in:title planning', ['p-standup']],
  ['in:note appendix', ['p-lattice']],
  ['in:url okr', ['p-okr']],
  // --- nothing at all
  ['zznothinglikethis', []],
];

describe('a 2,000-item vault', () => {
  it('is the size the table assumes', () => {
    expect(CORPUS.size).toBe(FILLER_COUNT + PROBES.length + Object.keys(FOLDERS).length);
    expect(CORPUS.size).toBeGreaterThanOrEqual(2_000);
    expect(INDEX.size).toBe(CORPUS.size);
  });

  it.each(CASES)('answers %j with exactly the right items', (query, expected) => {
    expect(ids(search(INDEX, query))).toEqual([...expected].toSorted());
  });

  it('answers every query in the table well inside the 20 ms budget', () => {
    // Timed as a whole and reported per query: a single `performance.now()` around one call is
    // mostly measuring the clock's own resolution on a fast machine.
    const started = performance.now();
    for (const [query] of CASES) search(INDEX, query);
    const perQuery = (performance.now() - started) / CASES.length;
    expect(perQuery).toBeLessThan(LATENCY_BUDGET_MS);
  });

  it('answers the worst case — a single common letter — inside the budget too', () => {
    // `z` is in every one of the filler items and in none of the probes, so this is the query that
    // builds the largest possible result set and sorts it.
    const started = performance.now();
    const hits = search(INDEX, 'z');
    expect(hits).toHaveLength(FILLER_COUNT);
    expect(performance.now() - started).toBeLessThan(LATENCY_BUDGET_MS);
  });

  it('builds the index for the whole corpus in a fraction of an unlock', () => {
    // The index is rebuilt on every unlock and after every change, so it has to stay cheap on a
    // vault far larger than the documented ~1,000-bookmark sync ceiling (D16).
    const started = performance.now();
    buildSearchIndex(toItemMap(CORPUS.values()).values());
    expect(performance.now() - started).toBeLessThan(250);
  });
});
