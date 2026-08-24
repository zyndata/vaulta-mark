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
 * **It carries two images since Phase 19** (ARCHITECTURE §10.1, D37). The worker asks for the
 * page's icon and may pass the one Chrome resolved for this tab — `tab.favIconUrl` — as a hint, and
 * the same visit to the page fetches that too. It is the same argument as above, one step further:
 * the page's own origin already served that icon to draw the tab strip. The two fetches run
 * **concurrently**, because they are independent and because serialising them would put two
 * eight-second timeouts end to end on the last thing an add does.
 *
 * **The icon is chosen here, and an SVG one is rasterised here.** Both because this is the only
 * context that can. The worker's `tab.favIconUrl` is one URL and often the wrong one — it is absent
 * for a site the user has only ever opened through the vault, and for a growing share of the web it
 * points at an SVG, which no service worker will decode (§10.1). This module sees the page's whole
 * `<link rel="icon">` set, so it can prefer a raster icon near the stored size; and it has a DOM, so
 * an SVG that is all a page offers is drawn into a canvas and leaves here as a PNG. An `<img>` runs
 * no script and loads no external reference, and the blob URL is the page's own, so the canvas is
 * not tainted — the bytes come back out.
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
 * Longest edge an SVG icon is rasterised to before it leaves the page (§10.1).
 *
 * Twice the size the vault stores, deliberately: the worker re-encodes everything through a canvas
 * anyway, and handing it 64 px lets that downscale resample rather than accept whatever a 32 px
 * draw of a vector produced. A 64 px PNG of a favicon is two or three kilobytes.
 */
export const ICON_RASTER_EDGE = 64;

/** How long an SVG is given to decode before the raster attempt is abandoned. */
export const RASTER_TIMEOUT_MS = 3_000;

/**
 * How many icon candidates one capture will try.
 *
 * A bound on work done inside somebody else's page, not a guess at how many a page declares. Four
 * covers every real ordering below — the hint, the best raster the page declares, `/favicon.ico`,
 * and the SVG that is all some sites have.
 */
export const MAX_ICON_CANDIDATES = 4;

/**
 * The size an icon is wanted at, which is what the vault stores (`thumbs/process.ts`,
 * `ICON_MAX_EDGE`).
 *
 * Not imported from there: this file is bundled into a script injected in arbitrary pages, and it
 * carries what it needs rather than the worker's image pipeline. A unit test asserts the two agree.
 */
const PREFERRED_ICON_SIZE = 32;

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

  /*
   * The icon half (§10.1, D37). Every one of these is absent unless the worker asked for an icon —
   * a capture that was not asked says nothing about icons rather than saying no.
   */

  /**
   * The URL the bytes came from.
   *
   * Echoed rather than assumed, because the page chooses which candidate wins and the worker
   * validates the one that was actually used. On a failure it is the first candidate that was
   * tried, which is the only one worth naming.
   */
  readonly iconUrl?: string;
  /** base64url of the icon bytes. PNG when an SVG was rasterised here. */
  readonly icon?: string;
  readonly iconContentType?: string;
  readonly iconDeclaredBytes?: number;
  /** Why there are no icon bytes. Absent exactly when {@link icon} is present. */
  readonly iconReason?: 'no-icon' | 'blocked' | 'too-large' | 'undecodable';
}

/**
 * What the worker is asking this capture for.
 *
 * Every field exists so that a capture can be *narrower* than the default, never wider. `image`
 * defaults to true because that is what every caller before Phase 19 wanted, and the one caller
 * that sets it false — an icon refresh — would otherwise pull a picture it is going to throw away,
 * which is a fetch made in someone's page for nothing (§14.4's rule, in spirit).
 */
export interface CaptureRequest {
  /**
   * Ask for the page's icon at all.
   *
   * Separate from {@link iconUrl}, and that separation is the whole of the fix for "Chrome has no
   * icon for this site": a page the regular profile has never visited has no `favIconUrl` to hint
   * with, and it is exactly the page whose own `<link rel="icon">` this needs to read. The worker
   * asks; the page decides what to fetch.
   */
  readonly icon?: boolean;
  /** `tab.favIconUrl`, when Chrome resolved one. A hint at the head of the candidate list. */
  readonly iconUrl?: string;
  /** Fetch the OG picture. Default true. */
  readonly image?: boolean;
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
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer>; readonly contentType?: string; readonly declaredBytes?: number }
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

/* ------------------------------------------------------------------ the icon */

/**
 * The `rel` tokens that name an icon worth trying.
 *
 * `mask-icon` is deliberately absent. Safari's pinned-tab icon is a monochrome silhouette meant to
 * be tinted by the browser, so rasterising one gives a solid black square — a worse row than the
 * lettered avatar it would replace.
 */
const ICON_RELS: ReadonlySet<string> = new Set([
  'icon',
  'apple-touch-icon',
  'apple-touch-icon-precomposed',
]);

/**
 * The icon URLs this page offers, best first (§10.1).
 *
 * The order is the whole of the SVG fix, and it is a preference rather than a refusal: a raster
 * icon near the stored size is tried before `/favicon.ico`, which is tried before anything that
 * looks like a vector. Most sites that publish an SVG publish a PNG beside it, so most of the time
 * nothing is rasterised at all — and the sites that publish only an SVG still get an icon, which
 * before this was about a quarter of the web getting none.
 *
 * `https:` only, checked here rather than left to the worker: everything downstream of this point
 * happens **inside somebody's page**, and a fetch the worker is going to refuse for its scheme is a
 * request made in their name for nothing.
 */
export function readIconCandidates(doc: Document, hint?: string): readonly string[] {
  const declared: { url: string; svg: boolean; rank: number }[] = [];
  for (const link of Array.from(doc.querySelectorAll('link[rel][href]'))) {
    const rels = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/u);
    if (!rels.some((rel) => ICON_RELS.has(rel))) continue;
    const url = resolveAgainstBase(link.getAttribute('href') ?? '', doc.baseURI);
    if (url === undefined || !isHttps(url)) continue;
    const type = (link.getAttribute('type') ?? '').toLowerCase();
    declared.push({
      url,
      svg: type.includes('svg') || hasPathSuffix(url, '.svg'),
      rank: iconRank(
        declaredSize(link.getAttribute('sizes')),
        rels.some((rel) => rel.startsWith('apple-touch-icon')),
      ),
    });
  }
  declared.sort((left, right) => left.rank - right.rank);

  const trimmed = hint?.trim() ?? '';
  const hinted = trimmed !== '' && isHttps(trimmed) ? trimmed : undefined;
  const hintIsSvg = hinted !== undefined && hasPathSuffix(hinted, '.svg');

  const ordered: (string | undefined)[] = [
    // Chrome's own answer first: it is what the tab strip is showing, so it is what the user would
    // expect the row to show — unless it is the vector this whole ordering exists to work around.
    hintIsSvg ? undefined : hinted,
    ...declared.filter((candidate) => !candidate.svg).map((candidate) => candidate.url),
    defaultIconUrl(doc.baseURI),
    hintIsSvg ? hinted : undefined,
    ...declared.filter((candidate) => candidate.svg).map((candidate) => candidate.url),
  ];

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of ordered) {
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }
  return unique.slice(0, MAX_ICON_CANDIDATES);
}

/** Icon bytes, and the description of them the worker will re-validate. */
export interface IconBytes {
  readonly url: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly declaredBytes?: number;
}

/** Turn SVG source into raster bytes, or `null`. Injected so the policy above is testable. */
export type IconRasteriser = (
  bytes: Uint8Array<ArrayBuffer>,
  edge: number,
) => Promise<Uint8Array<ArrayBuffer> | null>;

/** Why a capture came back with no icon. Informational: no caller treats any of them as an error. */
export type IconReason = 'no-icon' | 'blocked' | 'too-large' | 'undecodable';

/**
 * Try the candidates in order and answer with the first that produced an image.
 *
 * A non-image body does not end the search, and that is the case `/favicon.ico` makes routine: a
 * site with no such file very often answers 200 with an HTML error page, and stopping there would
 * mean never reaching the SVG the page actually declared.
 *
 * Never rejects. The reason carried back is the last real one, and "no icon" is the ordinary
 * outcome for a great many pages.
 */
export async function fetchIconBytes(
  candidates: readonly string[],
  fetchImpl: typeof fetch = fetch,
  rasterise: IconRasteriser = rasteriseSvg,
): Promise<IconBytes | { readonly reason: IconReason }> {
  if (candidates.length === 0) return { reason: 'no-icon' };

  let reason: IconReason = 'blocked';
  for (const url of candidates) {
    const fetched = await fetchImageBytes(url, fetchImpl);
    if (!fetched.ok) {
      reason = fetched.reason;
      continue;
    }

    const type = (fetched.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (looksLikeSvg(fetched.bytes, type)) {
      const raster = await rasterise(fetched.bytes, ICON_RASTER_EDGE);
      if (raster === null) {
        reason = 'undecodable';
        continue;
      }
      // A PNG this browser drew, so the length the server declared no longer describes it and is
      // dropped: the worker checks the bytes it was handed against its own ceiling either way.
      return { url, bytes: raster, contentType: 'image/png' };
    }

    if (type !== '' && !type.startsWith('image/')) {
      reason = 'blocked';
      continue;
    }

    return {
      url,
      bytes: fetched.bytes,
      contentType: type,
      ...(fetched.declaredBytes === undefined ? {} : { declaredBytes: fetched.declaredBytes }),
    };
  }
  return { reason };
}

/**
 * Whether these bytes are SVG source.
 *
 * The declared type is consulted first and the bytes second, because the two lie in different
 * directions: servers send `.svg` as `text/xml`, as `application/octet-stream` and as nothing at
 * all. Sniffing the head of the body is what settles it — an XML prologue, a doctype or a comment
 * may come before the root element, so this looks for the tag inside the first kilobyte rather than
 * at offset zero.
 */
export function looksLikeSvg(bytes: Uint8Array, contentType: string): boolean {
  if (contentType.includes('svg')) return true;
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 1024))
    .toLowerCase();
  return head.includes('<svg');
}

/**
 * Draw an SVG into a canvas and hand back PNG bytes — the half of the icon capture that can only
 * happen here (§10.1).
 *
 * `createImageBitmap` refuses SVG in a service worker outright, which is why the vault stored
 * nothing for a site whose only icon is a vector. A document has an `<img>`, and an `<img>` renders
 * SVG: it runs no script in it, resolves no external reference from it, and — because the blob URL
 * was minted in this page — leaves the canvas untainted, so the pixels can be read back out.
 *
 * Everything about it is bounded. The source is already capped at {@link MAX_FETCH_BYTES} by the
 * fetch that produced it, the draw is at most `edge` square, and a decode that has not finished
 * within {@link RASTER_TIMEOUT_MS} is abandoned — a page must not be able to hold the injection
 * open with an SVG that never loads.
 *
 * Never rejects: `null` is "no icon", and the caller moves on to the next candidate.
 */
export async function rasteriseSvg(
  bytes: Uint8Array<ArrayBuffer>,
  edge: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  let objectUrl: string | null = null;
  try {
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    const source = objectUrl;
    const image = new Image();
    const loaded = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, RASTER_TIMEOUT_MS);
      const settle = (ok: boolean): void => {
        clearTimeout(timer);
        resolve(ok);
      };
      image.onload = () => {
        settle(true);
      };
      image.onerror = () => {
        settle(false);
      };
      image.src = source;
    });
    if (!loaded) return null;

    // A sizeless SVG has no intrinsic dimensions to preserve, so it is drawn square. One that has
    // them keeps its aspect ratio: a wordmark squashed into a square reads as a smudge at 32 px.
    const naturalWidth = image.naturalWidth > 0 ? image.naturalWidth : edge;
    const naturalHeight = image.naturalHeight > 0 ? image.naturalHeight : edge;
    const scale = Math.min(edge / naturalWidth, edge / naturalHeight);
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.drawImage(image, 0, 0, width, height);

    // PNG rather than WebP: favicons are overwhelmingly transparent, and the worker's own icon
    // pipeline settles for PNG for exactly that reason (`thumbs/process.ts`, `ICON_FALLBACK_TYPE`).
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    if (blob === null) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  } finally {
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Where one candidate sits in the order: nearest to the stored size wins.
 *
 * Sizes at or above {@link PREFERRED_ICON_SIZE} beat sizes below it whatever the distance —
 * downscaling 180 px to 32 gives a clean icon, upscaling 16 px to 32 gives a blurred one. An
 * undeclared size sits between the two, because it is usually `/favicon.ico`, which is usually
 * right. Apple's touch icon goes last among rasters: a 180 px opaque square meant for a home
 * screen is a fallback rather than a choice.
 */
function iconRank(size: number | undefined, apple: boolean): number {
  const nearness =
    size === undefined
      ? 500
      : size >= PREFERRED_ICON_SIZE
        ? size - PREFERRED_ICON_SIZE
        : 1_000 + (PREFERRED_ICON_SIZE - size);
  return nearness + (apple ? 2_000 : 0);
}

/** The largest square in a `sizes` attribute, or `undefined` for `any` and for nonsense. */
function declaredSize(raw: string | null): number | undefined {
  let largest: number | undefined;
  for (const token of (raw ?? '').toLowerCase().split(/\s+/u)) {
    const match = /^(\d+)x(\d+)$/u.exec(token);
    if (match === null) continue;
    const size = Math.max(Number(match[1]), Number(match[2]));
    if (Number.isFinite(size) && (largest === undefined || size > largest)) largest = size;
  }
  return largest;
}

/** `/favicon.ico` at this page's origin — what a browser tries when a page declares nothing. */
function defaultIconUrl(base: string): string | undefined {
  try {
    const url = new URL('/favicon.ico', base);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isHttps(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

function hasPathSuffix(raw: string, suffix: string): boolean {
  try {
    return new URL(raw).pathname.toLowerCase().endsWith(suffix);
  } catch {
    return false;
  }
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
 * Read the card, fetch the picture, and — when the worker asked for one — the icon. The whole of
 * what the injected script does.
 *
 * Never rejects: every path answers with a {@link CaptureResult}, because the caller is a service
 * worker deciding whether to store a decoration and there is no failure here worth propagating.
 *
 * **The two halves are started together and awaited together.** They share nothing, and the page is
 * only ours for as long as the injection lasts; running them in sequence would double the worst
 * case for no benefit. `Promise.all` is safe here because neither branch can reject —
 * {@link fetchImageBytes} and {@link fetchIconBytes} answer with a reason instead.
 *
 * The icon half may make more than one request, because {@link readIconCandidates} produces an
 * ordered list rather than a single URL. That is bounded by {@link MAX_ICON_CANDIDATES}, and the
 * ordering is written so the first attempt is the right one for almost every page.
 */
export async function capture(
  doc: Document,
  fetchImpl: typeof fetch = fetch,
  request: CaptureRequest = {},
  rasterise: IconRasteriser = rasteriseSvg,
): Promise<CaptureResult> {
  const meta = readOgMeta(doc);
  const hint = request.iconUrl;
  const wantsIcon = request.icon === true || (typeof hint === 'string' && hint.trim() !== '');
  const wantsImage = request.image !== false;
  const candidates = wantsIcon ? readIconCandidates(doc, hint) : [];

  const [picture, icon] = await Promise.all([
    !wantsImage || meta.imageUrl === undefined
      ? null
      : fetchImageBytes(meta.imageUrl, fetchImpl),
    wantsIcon ? fetchIconBytes(candidates, fetchImpl, rasterise) : null,
  ]);

  const attempted = candidates[0];
  const iconFields: Partial<CaptureResult> =
    icon === null
      ? {}
      : 'reason' in icon
        ? {
            ...(attempted === undefined ? {} : { iconUrl: attempted }),
            iconReason: icon.reason,
          }
        : {
            iconUrl: icon.url,
            icon: toBase64UrlText(icon.bytes),
            iconContentType: icon.contentType,
            ...(icon.declaredBytes === undefined ? {} : { iconDeclaredBytes: icon.declaredBytes }),
          };

  if (picture === null) return { ...meta, reason: 'no-image', ...iconFields };
  if (!picture.ok) return { ...meta, reason: picture.reason, ...iconFields };

  return {
    ...meta,
    image: toBase64UrlText(picture.bytes),
    ...(picture.contentType === undefined ? {} : { contentType: picture.contentType }),
    ...(picture.declaredBytes === undefined ? {} : { declaredBytes: picture.declaredBytes }),
    ...iconFields,
  };
}
