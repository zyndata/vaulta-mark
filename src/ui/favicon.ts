/**
 * Favicons, from Chrome's own cache and nowhere else (ARCHITECTURE §10, D28).
 *
 * `chrome-extension://<id>/_favicon/?pageUrl=…` reads the local favicon database the browser
 * already built while the user was browsing. It costs no network request, and that is the entire
 * point: `https://www.google.com/s2/favicons?domain=…`, or any of its equivalents, would send every
 * vaulted domain to a third party every time a list rendered — which would defeat the product. The
 * URL allowlist scanner treats that as a build failure rather than a review comment (INV-3).
 *
 * The documented cost is that a site the profile has never visited has no cached icon, and Chrome
 * answers with a generic globe. So every row also gets a **letter avatar**: an inline SVG built
 * from the host's first character, coloured by a hash of the host. Deterministic, local, and the
 * same colour for the same site on every device.
 *
 * This is the one file under `src/ui/` allowed to touch `chrome.*`, and it only builds a string.
 *
 * Since Phase 17 a row can also be shown an icon **out of the vault** — one this profile has never
 * browsed to, restored with the vault from Drive (§10.1). That changes nothing above: the worker
 * answers with bytes only when Chrome's own cache had nothing better, so on a profile that has
 * visited these sites every row still renders exactly as it did.
 */

import { fromBase64Url } from '../crypto/codec.js';
import { sniffImageType } from './thumb.js';

/** Default favicon edge, in CSS pixels. 32 covers a 16 px row on a 2× display. */
export const DEFAULT_FAVICON_SIZE = 32;

/**
 * The `_favicon/` URL for a page.
 *
 * Requires the `favicon` permission, which produces no user-facing permission warning. Built with
 * `URL`/`searchParams` rather than string concatenation so a URL containing `&` or `#` cannot break
 * out of the `pageUrl` parameter.
 */
export function faviconUrl(pageUrl: string, size: number = DEFAULT_FAVICON_SIZE): string {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

/**
 * The host a row shows, with `www.` dropped.
 *
 * Falls back to the raw string for anything `URL` cannot parse, because a bookmark is stored as the
 * user saved it and a row still has to render one (§3.5).
 */
export function displayHost(pageUrl: string): string {
  try {
    return new URL(pageUrl).host.replace(/^www\./u, '');
  } catch {
    return pageUrl;
  }
}

/**
 * A stable hue for a host.
 *
 * FNV-1a: eight lines, no dependency, and all it has to be is deterministic and well spread. It is
 * not a security primitive and nothing here treats it as one.
 */
export function hostHue(host: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < host.length; i++) {
    hash ^= host.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/**
 * The character a letter avatar shows: the first letter or digit of the host.
 *
 * Uppercased with `toLocaleUpperCase` — unlike the phrase matching in `dom.ts`, this is *display*
 * of the user's own data, so a Turkish `i` should render as the İ that locale expects.
 */
export function avatarLetter(host: string): string {
  const match = /\p{L}|\p{N}/u.exec(host);
  return (match?.[0] ?? '?').toLocaleUpperCase();
}

/**
 * The fallback icon: a coloured tile with a letter in it.
 *
 * A styled element rather than an inline `<svg>` or a `data:` URL. `<svg>` needs
 * `createElementNS('http://www.w3.org/2000/svg', …)`, and a `data:` URI is a string that looks
 * exactly like what the remote-code scanner exists to find — both would mean arguing with an
 * invariant over a decoration. The colour goes on through CSSOM, which no CSP directive touches.
 */
export function letterAvatar(pageUrl: string): HTMLElement {
  const host = displayHost(pageUrl);
  const avatar = document.createElement('span');
  avatar.className = 'vm-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = avatarLetter(host);
  // Only the colour is set here; `.vm-avatar` in styles.css owns the geometry, so the fallback and
  // the real favicon are the same size by construction rather than by two numbers agreeing.
  // 55 %/42 % keeps every hue dark enough for white text at 4.5:1 — the hash picks the hue, never
  // the contrast.
  avatar.style.background = `hsl(${hostHue(host)} 55% 42%)`;
  return avatar;
}

/**
 * What a page can be asked about one host's stored icon (ARCHITECTURE §10.1).
 *
 * A callback rather than a message, for the same reason `thumb.ts` takes its fetch as a function:
 * `src/ui/` stays free of the message protocol and every one of these paths stays testable in jsdom
 * with no service worker anywhere.
 */
export type StoredIconLookup = (pageUrl: string) => Promise<StoredIcon>;

export interface StoredIcon {
  /** base64url bytes to show instead of Chrome's answer, or `null` to keep Chrome's. */
  readonly image: string | null;
  /**
   * Whether this profile stores icons at all. `false` — the Chrome sync tier, or a locked vault —
   * retires the lookup for the life of the page, so a profile that will never have one pays a
   * single message rather than one per host.
   */
  readonly available: boolean;
}

/**
 * Installed once per page, by the page's own bootstrap.
 *
 * Module state rather than an argument threaded through two unrelated lists, and it is the right
 * shape for what this is: a *document*-wide cache keyed by host, which is exactly the granularity
 * that keeps a five-thousand-row manager from asking five thousand times. `faviconImage` is already
 * a free function that reaches for `chrome.runtime`; this is the same kind of thing.
 */
let storedIcons: StoredIconLookup | null = null;

/** Host → the answer for it, asked at most once per document (§10.1). */
const iconCache = new Map<string, Promise<string | null>>();

export function useStoredIcons(lookup: StoredIconLookup | null): void {
  storedIcons = lookup;
  iconCache.clear();
}

/** For tests, and for a page that has just been told the vault locked. */
export function forgetStoredIcons(): void {
  useStoredIcons(null);
}

async function storedIconFor(pageUrl: string): Promise<string | null> {
  const lookup = storedIcons;
  if (lookup === null) return null;
  const host = displayHost(pageUrl);
  const pending = iconCache.get(host);
  if (pending !== undefined) return await pending;

  const answer = lookup(pageUrl).then((result) => {
    // "This profile has no stored icons" is a fact about the profile, not about this host, so it
    // retires the whole lookup rather than caching one `null` per row.
    if (!result.available) forgetStoredIcons();
    return result.image;
  });
  iconCache.set(host, answer);
  try {
    return await answer;
  } catch {
    return null;
  }
}

/**
 * An `<img>` that falls back to the letter avatar.
 *
 * Chrome answers `_favicon/` with a generic globe rather than an error when it has nothing cached,
 * so `onerror` alone does not cover the common case — but it does cover a revoked permission and a
 * malformed `pageUrl`, and the globe is a reasonable icon for "never visited" in the meantime.
 *
 * `size` is what we ask Chrome for, not what is rendered: the row is 16 px and the request is 32,
 * so a 2× display gets a sharp icon. The rendered size belongs to `.vm-favicon` in `styles.css`.
 *
 * **`loading="lazy"` is what lets the list be unbounded.** Building a thousand rows is a few
 * milliseconds of DOM; asking Chrome's favicon service for a thousand icons at once is not. Lazy
 * loading means only the rows actually on screen cost anything, so the popup does not need a row
 * cap to open quickly. The icon still comes from Chrome's local cache — laziness changes when we
 * ask, never who we ask (D28, INV-3).
 */
export function faviconImage(
  pageUrl: string,
  size: number = DEFAULT_FAVICON_SIZE,
): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'vm-favicon';
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.src = faviconUrl(pageUrl, size);
  img.addEventListener('error', () => {
    img.replaceWith(letterAvatar(pageUrl));
  });
  void showStoredIcon(img, pageUrl);
  return img;
}

/**
 * Replace Chrome's answer with the vault's, when the vault has one and Chrome does not.
 *
 * The worker decides that — it is the side that can tell a real icon from the generic globe — and
 * answers with bytes only when there is something better to show. On a profile that has browsed
 * these sites, which is the ordinary case, every answer here is `null` and nothing happens.
 *
 * The bytes become a `blob:` URL rather than a `data:` one, for the reason `thumb.ts` gives: a
 * `data:` image URL is a long string shaped exactly like what the remote-code scanner exists to
 * find. It is revoked as soon as the image has loaded — the decoded frame outlives the URL.
 */
async function showStoredIcon(img: HTMLImageElement, pageUrl: string): Promise<void> {
  const image = await storedIconFor(pageUrl);
  if (image === null) return;
  const bytes = fromBase64Url(image);
  const type = sniffImageType(bytes);
  const url = URL.createObjectURL(new Blob([bytes], ...(type === '' ? [] : [{ type }])));
  img.addEventListener('load', () => {
    URL.revokeObjectURL(url);
  });
  img.addEventListener('error', () => {
    URL.revokeObjectURL(url);
  });
  img.src = url;
}
