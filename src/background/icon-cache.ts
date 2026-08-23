/**
 * The hosts this worker has already looked for an icon for and not found (ARCHITECTURE §10.1).
 *
 * A negative cache, and nothing else. Without it a row on a host with no stored icon costs a Drive
 * lookup **every time a list is rendered** — and the common case for that is a vault whose owner
 * has not visited the site, which is a great many rows. One negative answer per host per worker
 * lifetime is enough; MV3 tears the worker down every ~30 seconds, so it re-learns often.
 *
 * **It lives in its own module because two modules invalidate it.** `background/favicons.ts` owns
 * icon policy and fills the set; `background/thumbs.ts` owns the injection and is where a
 * page-declared icon is stored, which is exactly the event that makes an entry wrong. Keeping the
 * set private to one of them would mean either an import cycle or a refreshed icon that no open
 * list shows until the worker next dies — which is the bug this file was extracted to fix.
 */

const missing = new Set<string>();

/** Remember that nothing is stored for this host. */
export function markIconMissing(host: string): void {
  missing.add(host);
}

/** Whether this worker has already learned there is nothing stored for this host. */
export function iconKnownMissing(host: string): boolean {
  return missing.has(host);
}

/** Forget a negative answer, because something was just stored for this host. */
export function forgetIconMiss(host: string): void {
  missing.delete(host);
}

/** Forget everything. Tests only; the worker's own lifetime does it for free. */
export function resetIconMisses(): void {
  missing.clear();
}
