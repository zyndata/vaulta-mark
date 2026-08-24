/**
 * Everything a page told us about its preview image, treated as hostile (ARCHITECTURE §14.2).
 *
 * The bytes arrive from `src/content/og-capture.ts`, which read them out of a document we do not
 * control, and every field of the description around them — the URL, the declared content type, the
 * declared length — was written by whoever wrote the page. Nothing here trusts any of it.
 *
 * The checks are ordered by cost: a scheme is a string comparison, a decode is a megabyte of work.
 * A rejection is not an error condition — it is the normal outcome for most of the web, and it
 * carries a machine-readable reason so the UI can say "no preview available" and, if asked, why.
 * Nothing is reported anywhere else (INV-8).
 */

/** Why a candidate was refused. Codes, never sentences — user-facing text lives in `_locales`. */
export type RejectReason =
  /** The page named no OG or Twitter image at all. By far the most common outcome. */
  | 'no-image'
  /** Not `https:`. `http:`, `data:`, `blob:`, `javascript:` and `file:` all land here. */
  | 'scheme'
  /** `localhost`, an IP literal, `*.local`, or anything else that is not a public DNS name. */
  | 'host'
  /** The page-context fetch never produced bytes: CSP, CORS, a network failure, a redirect to http. */
  | 'blocked'
  /** Not an `image/` content type. */
  | 'content-type'
  /** `image/svg+xml`. A script vector, refused outright and separately so the reason is legible. */
  | 'svg'
  /** Declared or actual size past {@link MAX_IMAGE_BYTES}. */
  | 'too-large'
  /** `createImageBitmap` would not decode it. */
  | 'undecodable'
  /** Past {@link MAX_DIMENSION} on either axis — a decompression bomb. */
  | 'dimensions'
  /** Past {@link MAX_ASPECT_RATIO}. A 4000×40 banner is furniture, not a preview. */
  | 'aspect'
  /** Decoded and downscaled, and still would not fit in {@link THUMB_MAX_BYTES}. */
  | 'unencodable';

/**
 * A refused candidate.
 *
 * Carries the reason and nothing else. It deliberately does **not** carry the URL that was refused:
 * this object crosses module boundaries and could end up somewhere it is stringified, and the URL
 * of an image on a page the user just vaulted is exactly the kind of thing that must never be
 * logged (INV-6's spirit, and the "never log a URL" rule).
 */
export class ThumbRejected extends Error {
  readonly reason: RejectReason;

  constructor(reason: RejectReason, options?: ErrorOptions) {
    super(`Preview image refused: ${reason}.`, options);
    this.name = 'ThumbRejected';
    this.reason = reason;
  }
}

/** Hard ceiling on what we will pull off a page, declared or actual (§14.2). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Decompression-bomb guard: a 10,000 × 10,000 RGBA bitmap is already 400 MB decoded. */
export const MAX_DIMENSION = 10_000;

/** Beyond this an image is a rule, a banner or a tracking pixel stretched — not a preview. */
export const MAX_ASPECT_RATIO = 20;

/**
 * Content types we will decode.
 *
 * An allowlist rather than "starts with `image/`", for the same reason `add.ts` allowlists schemes:
 * forgetting to ban a format means handing `createImageBitmap` something we never considered, while
 * forgetting to allow one means a user tells us about a format we then add. `image/svg+xml` is
 * absent by design and is also refused explicitly below, so the reason reads as "SVG" rather than
 * as "some content type".
 */
const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
]);

/**
 * The same allowlist plus the three spellings of ICO, for a **page-declared favicon** (§10.1, D37).
 *
 * It is a separate set rather than three more entries in the one above, because the two questions
 * are different: a page offering an `og:image` as `image/x-icon` is offering something that is not a
 * preview picture, while `/favicon.ico` is what `tab.favIconUrl` points at for a large share of the
 * web — 7 of the 18 icons measured on 2026-08-22 were one of these types.
 *
 * `image/svg+xml` is absent here too, and that is now a *measured* decision rather than only a
 * cautious one: `createImageBitmap` will not decode SVG in a service worker at all (§10.1), so
 * there is nothing to weigh against the script-vector risk. It stays refused with its own reason.
 *
 * **The allowlist is policy, not a guard on the decoder.** Measured the same day: `createImageBitmap`
 * sniffs the bytes and ignores the type it was handed — an ICO labelled `text/html` decodes fine. So
 * this list decides what we are willing to accept, and nothing downstream re-checks it.
 */
const ALLOWED_ICON_TYPES: ReadonlySet<string> = new Set([
  ...ALLOWED_TYPES,
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/ico',
]);

/**
 * A DNS label: letters, digits and hyphens, not starting or ending with one.
 *
 * Punycode passes (`xn--80ak6aa92e`), which is deliberate — an internationalized domain is a normal
 * domain, and refusing one would silently exclude a large part of the web from previews.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

/**
 * The private ranges §14.2 names: `10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `::1`,
 * `fc00::/7`, `fe80::/10`.
 *
 * There is no code below that tests them one by one, and that is not an omission: {@link isIpLiteral}
 * refuses **every** address literal, public ones included, which is strictly stronger than the list.
 * A preview image addressed by IP rather than by name is either an internal service or something
 * trying to be one, and neither is worth a picture. The ranges are written down here because a
 * reader coming from the spec should find them, and because the test table drives every one of them.
 */

/**
 * The image URL a page offered, or `ThumbRejected`.
 *
 * Returns the URL rather than a boolean so the caller uses the parsed-and-normalized form rather
 * than the raw string — the two differ, and the one that gets used should be the one that was
 * checked.
 */
export function validateImageUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new ThumbRejected('no-image');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Unparseable, so there is no scheme to have checked. `scheme` rather than a fourteenth reason:
    // to a user this is the same event as `data:` — "that is not an address we will fetch".
    throw new ThumbRejected('scheme');
  }

  if (url.protocol !== 'https:') throw new ThumbRejected('scheme');
  if (!isPublicDnsHost(url.hostname)) throw new ThumbRejected('host');
  return url.href;
}

/**
 * Whether a hostname is a public DNS name we are willing to have fetched.
 *
 * Written as "must look like a name" rather than "must not look like these ranges", because a
 * denylist of address forms has to be complete to be worth anything — `0x7f.1`, `2130706433` and
 * `[::ffff:127.0.0.1]` are all `127.0.0.1`, and that is before IPv6 zone identifiers.
 */
export function isPublicDnsHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === '') return false;
  // A bracketed literal is IPv6 by definition; `URL` keeps the brackets in `hostname`.
  if (host.startsWith('[')) return false;
  if (isIpLiteral(host)) return false;

  const labels = host.split('.');
  // A single label is `localhost`, an intranet short name, or a typo — never a public host.
  if (labels.length < 2) return false;
  if (!labels.every((label) => LABEL.test(label))) return false;

  const tld = labels[labels.length - 1] ?? '';
  // `.local` is mDNS: the local network, by definition. `.localhost` is reserved to the loopback.
  if (tld === 'local' || tld === 'localhost' || tld === 'internal' || tld === 'home') return false;
  return /^[a-z]{2,}$/u.test(tld) || tld.startsWith('xn--');
}

/**
 * Whether a hostname is an address literal in any spelling `URL` or a resolver would accept.
 *
 * Covers dotted quads, the shortened and octal/hex forms `inet_aton` still honours, bare integers,
 * and anything with a colon in it (which in a hostname position can only be IPv6).
 */
export function isIpLiteral(host: string): boolean {
  if (host.includes(':')) return true;
  const parts = host.split('.');
  if (parts.length > 4) return false;
  // Every part numeric in some base, and the last one non-empty: `1.2.3.4`, `127.1`, `0x7f.1`,
  // `2130706433`. A trailing dot (`example.com.`) leaves an empty last part and is a name.
  return parts.every((part) => part !== '' && NUMERIC_PART.test(part));
}

const NUMERIC_PART = /^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/u;

/** Reject a declared `Content-Length` we already know is too big, before reading a body. */
export function validateDeclaredSize(declared: number | undefined): void {
  if (declared === undefined) return;
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_IMAGE_BYTES) {
    throw new ThumbRejected('too-large');
  }
}

/**
 * Reject a content type we will not decode.
 *
 * Parameters are stripped (`image/jpeg; charset=binary` is a real header from real servers), and the
 * comparison is case-insensitive, because media types are.
 */
export function validateContentType(raw: string | undefined): string {
  const type = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === '') throw new ThumbRejected('content-type');
  if (type === 'image/svg+xml' || type === 'image/svg') throw new ThumbRejected('svg');
  if (!ALLOWED_TYPES.has(type)) throw new ThumbRejected('content-type');
  return type;
}

/**
 * Reject an icon content type we will not decode.
 *
 * {@link validateContentType} with {@link ALLOWED_ICON_TYPES}; the SVG special case is identical and
 * deliberately duplicated rather than shared, so that removing it from one path cannot silently
 * remove it from the other.
 */
export function validateIconContentType(raw: string | undefined): string {
  const type = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === '') throw new ThumbRejected('content-type');
  if (type === 'image/svg+xml' || type === 'image/svg') throw new ThumbRejected('svg');
  if (!ALLOWED_ICON_TYPES.has(type)) throw new ThumbRejected('content-type');
  return type;
}

/** Reject a body that grew past the cap regardless of what the headers claimed. */
export function validateActualSize(byteLength: number): void {
  if (byteLength === 0) throw new ThumbRejected('blocked');
  if (byteLength > MAX_IMAGE_BYTES) throw new ThumbRejected('too-large');
}

/** Reject a decoded bitmap that is a bomb or a strip of furniture. */
export function validateDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new ThumbRejected('undecodable');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw new ThumbRejected('dimensions');
  const ratio = Math.max(width / height, height / width);
  if (ratio > MAX_ASPECT_RATIO) throw new ThumbRejected('aspect');
}

/**
 * Everything that can be checked before a decode, in the order §14.2 lists it.
 *
 * One entry point so a caller cannot perform three of the four checks; the decode-time ones
 * ({@link validateDimensions}) belong to `process.ts`, which is the module that has a bitmap.
 */
export function validateCandidate(candidate: {
  readonly url: string;
  readonly contentType?: string | undefined;
  readonly declaredBytes?: number | undefined;
  readonly byteLength: number;
}): { readonly url: string; readonly contentType: string } {
  const url = validateImageUrl(candidate.url);
  validateDeclaredSize(candidate.declaredBytes);
  const contentType = validateContentType(candidate.contentType);
  validateActualSize(candidate.byteLength);
  return { url, contentType };
}

/**
 * The same, for a page-declared favicon (§10.1, D37).
 *
 * Identical in every check but the content-type allowlist — the URL still has to be `https:` and a
 * public DNS name, the same 5 MB ceiling still applies to what the page was allowed to pull. A
 * favicon on `http://192.168.1.1` is exactly the SSRF-shaped thing {@link isPublicDnsHost} exists
 * for, and the fact that Chrome resolved the URL is not a reason to trust it: `favIconUrl` comes
 * from the page's own markup.
 */
export function validateIconCandidate(candidate: {
  readonly url: string;
  readonly contentType?: string | undefined;
  readonly declaredBytes?: number | undefined;
  readonly byteLength: number;
}): { readonly url: string; readonly contentType: string } {
  const url = validateImageUrl(candidate.url);
  validateDeclaredSize(candidate.declaredBytes);
  const contentType = validateIconContentType(candidate.contentType);
  validateActualSize(candidate.byteLength);
  return { url, contentType };
}
