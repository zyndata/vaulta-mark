/**
 * Reading a page's Open Graph card, and fetching the picture it names — in the page's own context
 * (ARCHITECTURE §14.1).
 *
 * **Why the fetch happens here and not in the service worker.** A request from the worker would
 * originate from the extension: a genuine third-party request VaultaMark made, attributable by the
 * site to "an extension" rather than to a page load, and a breach of INV-4. A request from a content
 * script is made under the page's own origin, against the page's own cache, for an image that origin
 * already served to that page a moment ago. Nobody new learns anything.
 *
 * The cost is real and accepted: a page whose CSP forbids the connection, or an image without
 * permissive CORS, yields nothing. No thumbnail is a fine outcome — the favicon is always there —
 * and no failure here is ever surfaced as an error.
 *
 * This module is the testable half; `og-capture.ts` beside it is the fifteen lines that the browser
 * actually injects.
 */

/** Longest `og:title` we keep. The card is a hint on a row, not a document. */
export const MAX_OG_TITLE = 300;

/** Longest `og:description` we keep. */
export const MAX_OG_DESCRIPTION = 600;

/** Hard ceiling on the fetch. Mirrors `thumbs/validate.ts`; enforced on both sides on purpose. */
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;

/** How long the page is given to produce the image before we stop waiting (§14.1). */
export const FETCH_TIMEOUT_MS = 8_000;

/**
 * What one capture produced.
 *
 * Every field is JSON-serialisable, because this crosses `chrome.scripting.executeScript`'s
 * boundary, which serialises. That is why the bytes travel as base64url text rather than as an
 * `ArrayBuffer`: a transferable would arrive as `{}` and the failure would be silent.
 */
export interface CaptureResult {
  readonly ogTitle?: string;
  readonly ogDescription?: string;
  /** Which family of tags the image came from. */
  readonly src?: 'og' | 'twitter';
  readonly imageUrl?: string;
  readonly contentType?: string;
  /** `Content-Length`, when the server declared one. */
  readonly declaredBytes?: number;
  /** base64url of the image bytes. */
  readonly image?: string;
  /** Why there are no bytes. Absent exactly when {@link image} is present. */
  readonly reason?: 'no-image' | 'blocked' | 'too-large';
}

/** The metadata half, with no network involved. */
export interface OgMeta {
  readonly ogTitle?: string;
  readonly ogDescription?: string;
  readonly imageUrl?: string;
  readonly src?: 'og' | 'twitter';
}

/**
 * The image tags, in the order §14.1 fixes.
 *
 * `og:image:secure_url` before `og:image:url` before `og:image`, then Twitter's two. The order is
 * the spec's and matters: a page that offers both an `http:` `og:image` and an `https:`
 * `og:image:secure_url` is offering the second one to anybody who can take it, and the validator
 * would refuse the first.
 */
const IMAGE_TAGS: readonly { readonly key: string; readonly src: 'og' | 'twitter' }[] = [
  { key: 'og:image:secure_url', src: 'og' },
  { key: 'og:image:url', src: 'og' },
  { key: 'og:image', src: 'og' },
  { key: 'twitter:image', src: 'twitter' },
  { key: 'twitter:image:src', src: 'twitter' },
];

/**
 * Read the card off a document.
 *
 * Both `property=` and `name=` are consulted for every tag. The Open Graph protocol says `property`
 * and Twitter's says `name`, and a large part of the web does the opposite of whichever one it is
 * using — insisting on the correct attribute would mean no preview for a great many perfectly
 * ordinary pages.
 */
export function readOgMeta(doc: Document): OgMeta {
  const title = clamp(metaContent(doc, 'og:title'), MAX_OG_TITLE);
  const description = clamp(
    metaContent(doc, 'og:description') ?? metaContent(doc, 'twitter:description'),
    MAX_OG_DESCRIPTION,
  );

  let imageUrl: string | undefined;
  let src: 'og' | 'twitter' | undefined;
  for (const tag of IMAGE_TAGS) {
    const raw = metaContent(doc, tag.key);
    if (raw === undefined) continue;
    const resolved = resolveAgainstBase(raw, doc.baseURI);
    if (resolved === undefined) continue;
    imageUrl = resolved;
    src = tag.src;
    break;
  }

  return {
    ...(title === undefined ? {} : { ogTitle: title }),
    ...(description === undefined ? {} : { ogDescription: description }),
    ...(imageUrl === undefined ? {} : { imageUrl }),
    ...(src === undefined ? {} : { src }),
  };
}

/**
 * A relative `og:image` made absolute.
 *
 * Pages do publish `og:image` as `/static/card.png`, and `document.baseURI` — which honours a
 * `<base href>` — is what the page itself would resolve it against. Anything `URL` cannot make sense
 * of is dropped here rather than passed on as a string the validator would only refuse later.
 */
export function resolveAgainstBase(raw: string, base: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return undefined;
  }
}

function metaContent(doc: Document, key: string): string | undefined {
  const escaped = key.replace(/"/gu, '\\"');
  const element = doc.querySelector(`meta[property="${escaped}"], meta[name="${escaped}"]`);
  const content = element?.getAttribute('content')?.trim() ?? '';
  return content === '' ? undefined : content;
}

function clamp(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : value.slice(0, max);
}

/* ------------------------------------------------------------------ the fetch */

/**
 * Pull the image, in page context, with a hard byte ceiling.
 *
 * Streamed rather than read whole: a server that declares no `Content-Length`, or declares a small
 * one and sends a hundred megabytes, must not be able to make the page allocate it. The reader is
 * cancelled the moment the running total passes {@link MAX_FETCH_BYTES}.
 *
 * `credentials: 'omit'` because a preview picture is never worth sending the user's cookies for, and
 * `mode: 'cors'` because a request that would have to be opaque is one whose bytes we could not read
 * anyway.
 */
export async function fetchImageBytes(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array; readonly contentType?: string; readonly declaredBytes?: number }
  | { readonly ok: false; readonly reason: 'blocked' | 'too-large' }
> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      credentials: 'omit',
      mode: 'cors',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'blocked' };
  }

  // A redirect that landed anywhere but https is a redirect we do not follow the rest of the way.
  if (!response.ok || !response.url.startsWith('https:')) return { ok: false, reason: 'blocked' };

  const declaredHeader = response.headers.get('content-length');
  const declared = declaredHeader === null ? undefined : Number(declaredHeader);
  if (declared !== undefined && Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
    return { ok: false, reason: 'too-large' };
  }

  const contentType = response.headers.get('content-type') ?? undefined;
  const body = response.body;
  if (body === null) return { ok: false, reason: 'blocked' };

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FETCH_BYTES) {
        await reader.cancel();
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'blocked' };
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return {
    ok: true,
    bytes,
    ...(contentType === undefined ? {} : { contentType }),
    ...(declared === undefined || !Number.isFinite(declared) ? {} : { declaredBytes: declared }),
  };
}

/**
 * base64url, without reaching into `src/crypto/`.
 *
 * The content script is a separate bundle injected into arbitrary pages, and it should carry the
 * fifteen lines it needs rather than the compression and padding helpers that come with the vault's
 * codec. The alphabet matches `fromBase64Url`, which is what unpacks this on the other side.
 */
export function toBase64UrlText(bytes: Uint8Array): string {
  // 8 KB at a time: `String.fromCharCode(...bytes)` on a five-megabyte array overflows the argument
  // limit, and a per-byte string concatenation of the same array is measurably slower.
  const CHUNK = 0x2000;
  let binary = '';
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/**
 * Read the card and fetch the picture. The whole of what the injected script does.
 *
 * Never rejects: every path answers with a {@link CaptureResult}, because the caller is a service
 * worker deciding whether to store a decoration and there is no failure here worth propagating.
 */
export async function capture(
  doc: Document,
  fetchImpl: typeof fetch = fetch,
): Promise<CaptureResult> {
  const meta = readOgMeta(doc);
  if (meta.imageUrl === undefined) return { ...meta, reason: 'no-image' };

  const fetched = await fetchImageBytes(meta.imageUrl, fetchImpl);
  if (!fetched.ok) return { ...meta, reason: fetched.reason };

  return {
    ...meta,
    image: toBase64UrlText(fetched.bytes),
    ...(fetched.contentType === undefined ? {} : { contentType: fetched.contentType }),
    ...(fetched.declaredBytes === undefined ? {} : { declaredBytes: fetched.declaredBytes }),
  };
}
