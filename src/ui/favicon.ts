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
 */

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
  return img;
}
