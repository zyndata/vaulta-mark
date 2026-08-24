/**
 * Registrable-domain extraction (ARCHITECTURE §12.1).
 *
 * This is the function the history cleanup's correctness rests on. `chrome.history.search` does
 * **substring** matching, so asking it for `example.com` answers with `notexample.community` too —
 * and the difference between "the domains you vaulted" and "the domains whose names contain one you
 * vaulted" is the difference between a tool that does what it says and one that deletes a stranger's
 * browsing history. Everything `search` returns is re-checked here before a single `deleteUrl`.
 *
 * "Last two labels" is not good enough and never was: it treats `bbc.co.uk` as `co.uk` (so a cleanup
 * of one BBC page would target every `.co.uk` site in history) and `alice.github.io` as `github.io`
 * (likewise). Hence the Public Suffix List.
 *
 * Pure, and deliberately dependency-free: no `chrome.*`, no I/O, no vault types. It is handed its
 * rules rather than reaching for them, which is what keeps it that way now that the list is a
 * packaged asset read at first use (`public-suffix.ts`) rather than a bundled string. That is also
 * why the entry point is a factory: a caller that has a matcher has already paid for the list, so
 * the hot loop in `cleanup.ts` — one call per history result — stays synchronous.
 */

/** The list, split the three ways the matching rules distinguish. */
export interface PublicSuffixRules {
  /** Ordinary rules: the whole label sequence is a public suffix. */
  readonly plain: ReadonlySet<string>;
  /** `*.` rules, stored without the prefix: any single label under these is a public suffix. */
  readonly wildcard: ReadonlySet<string>;
  /** `!` rules, stored without the prefix: registrable despite a wildcard above them. */
  readonly exception: ReadonlySet<string>;
}

/** Everything the history code asks of the list, bound to one set of rules. */
export interface DomainMatcher {
  registrableDomain(host: string): string | null;
  registrableDomainOf(url: string): string | null;
  urlBelongsTo(url: string, domain: string): boolean;
  domainsOf(urls: Iterable<string>): string[];
}

/** An IPv4 literal. Chrome normalises these, so a loose shape check is enough to recognise one. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** Bind the matching rules to a set of functions over them. Pure; safe to call more than once. */
export function createDomainMatcher(rules: PublicSuffixRules): DomainMatcher {
  const { plain, wildcard, exception } = rules;

  /**
   * The registrable domain of a hostname — `bbc.co.uk`, `github.io`'s `alice.github.io`,
   * `example.com`.
   *
   * `null` when the host *is* a public suffix (`co.uk` on its own), when it has no dot at all
   * (`localhost`), or when it is empty. A `null` here means "there is nothing here that can be
   * meaningfully compared against another host", and every caller treats that as "do not touch it".
   *
   * IP literals are answered with themselves. They have no registrable domain in the PSL sense, and
   * the alternative — dropping them — would mean a bookmark saved against a NAS or a dev box could
   * never be cleaned from history. Comparing two IP literals for equality is exactly the right
   * containment test, which is what the callers do with the result.
   */
  function registrableDomain(host: string): string | null {
    const normalized = normalizeHost(host);
    if (normalized === null) return null;

    // A bracketed IPv6 literal keeps its brackets from `URL.hostname`; both forms are their own unit.
    if (IPV4.test(normalized) || normalized.startsWith('[')) return normalized;

    const labels = normalized.split('.');
    if (labels.length < 2) return null;

    // Longest candidate first. An exception rule is always longer than the wildcard it excepts
    // (`!www.ck` beats `*.ck`), so "longest match wins" already gives exceptions their priority
    // without a second pass.
    for (let at = 0; at < labels.length; at++) {
      const candidate = labels.slice(at).join('.');
      if (exception.has(candidate)) {
        // An exception's public suffix is the rule minus its leftmost label, which makes the rule
        // itself the registrable domain.
        return candidate;
      }
      if (plain.has(candidate)) {
        return at === 0 ? null : labels.slice(at - 1).join('.');
      }
      // `*.foo` matches exactly one label under `foo` — never two.
      if (at + 1 < labels.length && wildcard.has(labels.slice(at + 1).join('.'))) {
        return at === 0 ? null : labels.slice(at - 1).join('.');
      }
    }

    // No rule matched, so the default `*` applies: the rightmost label is the public suffix.
    return labels.slice(-2).join('.');
  }

  /** The registrable domain of a URL, or `null` if it has no host we can reason about. */
  function registrableDomainOf(url: string): string | null {
    const host = hostOf(url);
    return host === null ? null : registrableDomain(host);
  }

  /**
   * Whether a URL belongs to a given registrable domain.
   *
   * The exact check that stands between `history.search`'s substring matching and `deleteUrl`. It
   * compares registrable domains rather than testing for a suffix, because `notexample.com` ends in
   * `example.com` by string and belongs to somebody else by fact.
   */
  function urlBelongsTo(url: string, domain: string): boolean {
    const found = registrableDomainOf(url);
    return found !== null && found === domain;
  }

  /**
   * The distinct registrable domains of a set of URLs, in first-seen order.
   *
   * Order is stable so a dry run and the run after it list the same domains in the same places — a
   * review list that reshuffles between the two is one nobody can compare.
   */
  function domainsOf(urls: Iterable<string>): string[] {
    const domains = new Set<string>();
    for (const url of urls) {
      const domain = registrableDomainOf(url);
      if (domain !== null) domains.add(domain);
    }
    return [...domains];
  }

  return { registrableDomain, registrableDomainOf, urlBelongsTo, domainsOf };
}

/** The hostname of a URL, or `null` if it is not one. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Lowercase, strip a trailing root dot, reject anything left that cannot be a host. */
function normalizeHost(host: string): string | null {
  const trimmed = host.trim().toLowerCase().replace(/\.+$/u, '');
  if (trimmed === '' || trimmed.startsWith('.') || trimmed.includes('..')) return null;
  return trimmed;
}
