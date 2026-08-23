/**
 * @vitest-environment jsdom
 *
 * What the injected script reads off a page, and what it will not pull down (ARCHITECTURE §14.1).
 *
 * Everything here is written against pages of the kind that actually exist: `og:` tags spelled with
 * `name=` instead of `property=`, relative image paths, a `<base href>`, a card with text and no
 * picture. The failure paths matter as much as the happy one — the point of the module is that
 * "this page has no preview" is an ordinary answer rather than an error.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ICON_RASTER_EDGE,
  MAX_FETCH_BYTES,
  MAX_ICON_CANDIDATES,
  MAX_OG_DESCRIPTION,
  MAX_OG_TITLE,
  capture,
  fetchIconBytes,
  fetchImageBytes,
  looksLikeSvg,
  RASTER_TIMEOUT_MS,
  rasteriseSvg,
  readIconCandidates,
  readOgMeta,
  resolveAgainstBase,
  toBase64UrlText,
  type IconRasteriser,
} from '../../../src/content/og.js';
import { fromBase64Url } from '../../../src/crypto/codec.js';

/** A document built from head markup, with a page URL of its own. */
function pageWith(head: string, url = 'https://example.com/articles/one'): Document {
  const doc = document.implementation.createHTMLDocument('test');
  // jsdom has no way to set `baseURI` directly; a `<base>` is what a real page would use anyway.
  doc.head.innerHTML = `<base href="${url}">${head}`;
  return doc;
}

/** A `Response` with a readable body, for the streaming path. */
function response(options: {
  readonly bytes?: Uint8Array;
  readonly headers?: Record<string, string>;
  readonly url?: string;
  readonly status?: number;
  readonly chunks?: readonly Uint8Array[];
}): Response {
  const chunks = options.chunks ?? [options.bytes ?? new Uint8Array([1, 2, 3])];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const res = new Response(body, {
    status: options.status ?? 200,
    headers: options.headers ?? { 'content-type': 'image/png' },
  });
  Object.defineProperty(res, 'url', { value: options.url ?? 'https://cdn.example.com/card.png' });
  return res;
}

describe('reading the card', () => {
  it('prefers og:image:secure_url over the others, in the order §14.1 fixes', () => {
    const meta = readOgMeta(
      pageWith(`
        <meta property="og:image" content="https://cdn.example.com/plain.png">
        <meta property="og:image:url" content="https://cdn.example.com/url.png">
        <meta property="og:image:secure_url" content="https://cdn.example.com/secure.png">
        <meta name="twitter:image" content="https://cdn.example.com/twitter.png">
      `),
    );
    expect(meta.imageUrl).toBe('https://cdn.example.com/secure.png');
    expect(meta.src).toBe('og');
  });

  it('falls through to Twitter when there is no Open Graph image', () => {
    const meta = readOgMeta(
      pageWith('<meta name="twitter:image:src" content="https://cdn.example.com/t.png">'),
    );
    expect(meta.imageUrl).toBe('https://cdn.example.com/t.png');
    expect(meta.src).toBe('twitter');
  });

  it('reads og: tags spelled with name= and twitter: tags spelled with property=', () => {
    const meta = readOgMeta(
      pageWith(`
        <meta name="og:title" content="Spelled the other way">
        <meta property="twitter:image" content="https://cdn.example.com/t.png">
      `),
    );
    expect(meta.ogTitle).toBe('Spelled the other way');
    expect(meta.imageUrl).toBe('https://cdn.example.com/t.png');
  });

  it('resolves a relative image against the document base', () => {
    const meta = readOgMeta(
      pageWith('<meta property="og:image" content="/static/card.png">'),
    );
    expect(meta.imageUrl).toBe('https://example.com/static/card.png');
  });

  it('truncates the title and the description rather than refusing them', () => {
    const meta = readOgMeta(
      pageWith(`
        <meta property="og:title" content="${'t'.repeat(500)}">
        <meta property="og:description" content="${'d'.repeat(900)}">
      `),
    );
    expect(meta.ogTitle).toHaveLength(MAX_OG_TITLE);
    expect(meta.ogDescription).toHaveLength(MAX_OG_DESCRIPTION);
  });

  it('leaves a card with no picture perfectly usable', () => {
    const meta = readOgMeta(pageWith('<meta property="og:title" content="Just words">'));
    expect(meta).toEqual({ ogTitle: 'Just words' });
  });

  it('ignores empty and whitespace-only content', () => {
    expect(readOgMeta(pageWith('<meta property="og:image" content="   ">')).imageUrl).toBeUndefined();
  });

  it('answers nothing for a page with no card at all', () => {
    expect(readOgMeta(pageWith(''))).toEqual({});
  });

  it('does not let a quote in a tag name break out of the selector', () => {
    // The selector is built from a constant list, so this is belt and braces — but the escaping is
    // there and a test is what keeps it there.
    expect(() => readOgMeta(pageWith('<meta property="og:image" content="x">'))).not.toThrow();
  });
});

describe('resolveAgainstBase', () => {
  it('drops anything URL cannot make sense of', () => {
    expect(resolveAgainstBase('http://[', 'https://example.com/')).toBeUndefined();
    expect(resolveAgainstBase('  ', 'https://example.com/')).toBeUndefined();
  });

  it('leaves an absolute URL alone', () => {
    expect(resolveAgainstBase('https://cdn.example.com/a.png', 'https://example.com/')).toBe(
      'https://cdn.example.com/a.png',
    );
  });
});

describe('fetching in page context', () => {
  it('reads the bytes, the type and the declared length', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const result = await fetchImageBytes(
      'https://cdn.example.com/card.png',
      vi.fn().mockResolvedValue(
        response({ bytes, headers: { 'content-type': 'image/png', 'content-length': '4' } }),
      ),
    );
    expect(result).toEqual({
      ok: true,
      bytes,
      contentType: 'image/png',
      declaredBytes: 4,
    });
  });

  it('omits credentials and asks for CORS', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    await fetchImageBytes('https://cdn.example.com/card.png', fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
    });
  });

  it('reports a fetch the page’s CSP or CORS refused as blocked, not as an error', async () => {
    const result = await fetchImageBytes(
      'https://cdn.example.com/card.png',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    expect(result).toEqual({ ok: false, reason: 'blocked' });
  });

  it('refuses a redirect that landed on plain http', async () => {
    const result = await fetchImageBytes(
      'https://cdn.example.com/card.png',
      vi.fn().mockResolvedValue(response({ url: 'http://cdn.example.com/card.png' })),
    );
    expect(result).toEqual({ ok: false, reason: 'blocked' });
  });

  it('refuses a non-OK response', async () => {
    const result = await fetchImageBytes(
      'https://cdn.example.com/card.png',
      vi.fn().mockResolvedValue(response({ status: 404 })),
    );
    expect(result).toEqual({ ok: false, reason: 'blocked' });
  });

  it('refuses a declared length past the cap before reading a body', async () => {
    const body = vi.fn();
    const res = response({ headers: { 'content-length': String(MAX_FETCH_BYTES + 1) } });
    Object.defineProperty(res, 'body', { get: body });
    const result = await fetchImageBytes(
      'https://cdn.example.com/card.png',
      vi.fn().mockResolvedValue(res),
    );
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(body).not.toHaveBeenCalled();
  });

  it('aborts a body that grows past the cap however small the header claimed to be', async () => {
    // Ten one-megabyte chunks behind a header that says four bytes.
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(1024 * 1024));
    const result = await fetchImageBytes(
      'https://cdn.example.com/card.png',
      vi.fn().mockResolvedValue(
        response({ chunks, headers: { 'content-type': 'image/png', 'content-length': '4' } }),
      ),
    );
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('reassembles a body that arrived in several chunks', async () => {
    const result = await fetchImageBytes(
      'https://cdn.example.com/card.png',
      vi.fn().mockResolvedValue(
        response({ chunks: [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])] }),
      ),
    );
    expect(result).toMatchObject({ ok: true, bytes: new Uint8Array([1, 2, 3, 4, 5]) });
  });
});

describe('base64url', () => {
  it('round-trips through the codec the service worker unpacks with', () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    expect(fromBase64Url(toBase64UrlText(bytes))).toEqual(bytes);
  });

  it('handles a payload past the chunking threshold without overflowing the argument list', () => {
    const bytes = new Uint8Array(70_000).fill(0xab);
    expect(fromBase64Url(toBase64UrlText(bytes))).toEqual(bytes);
  });

  it('uses the URL-safe alphabet and no padding', () => {
    const text = toBase64UrlText(new Uint8Array([251, 255, 190, 1]));
    expect(text).not.toMatch(/[+/=]/u);
  });
});

describe('capture', () => {
  it('brings back the card and the picture', async () => {
    const doc = pageWith(`
      <meta property="og:title" content="An article">
      <meta property="og:description" content="About something">
      <meta property="og:image" content="/card.png">
    `);
    const result = await capture(
      doc,
      vi.fn().mockResolvedValue(
        response({ bytes: new Uint8Array([1, 2, 3, 4]), headers: { 'content-type': 'image/png' } }),
      ),
    );
    expect(result).toMatchObject({
      ogTitle: 'An article',
      ogDescription: 'About something',
      imageUrl: 'https://example.com/card.png',
      src: 'og',
      contentType: 'image/png',
    });
    expect(fromBase64Url(result.image ?? '')).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.reason).toBeUndefined();
  });

  it('never fetches when the page named no image', async () => {
    const fetchImpl = vi.fn();
    const result = await capture(
      pageWith('<meta property="og:title" content="Just words">'),
      fetchImpl,
    );
    expect(result).toEqual({ ogTitle: 'Just words', reason: 'no-image' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the card’s text when the picture could not be fetched', async () => {
    const result = await capture(
      pageWith(`
        <meta property="og:title" content="An article">
        <meta property="og:image" content="https://cdn.example.com/card.png">
      `),
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    expect(result).toMatchObject({ ogTitle: 'An article', reason: 'blocked' });
    expect(result.image).toBeUndefined();
  });
});

/* ------------------------------------------------ the icon half (§10.1, D37) */

/**
 * Which icon the page offers, and what happens when the only one is a vector.
 *
 * The worker used to hand this module a single URL — `tab.favIconUrl` — and a capture that could
 * not use it came back empty. Two things made that the wrong shape. Chrome has no `favIconUrl` at
 * all for a site the user only ever opens through the vault, which is the exact site the feature
 * exists for; and for a growing share of the web it points at an SVG, which no service worker will
 * decode, so about a quarter of pages stored nothing. Both are answered here, because this is the
 * only context with a `<link>` set to read and a canvas to draw into.
 *
 * The canvas half is asserted through the injected {@link IconRasteriser} rather than for real —
 * jsdom has no canvas. That the technique works in a real page is measured in
 * `test/e2e/thumbs.spec.ts`.
 */
describe('choosing the icon to fetch', () => {
  const PAGE_URL = 'https://example.com/articles/one';

  function candidates(head: string, hint?: string): readonly string[] {
    return readIconCandidates(pageWith(head, PAGE_URL), hint);
  }

  it('puts Chrome’s own answer first — it is what the tab strip is showing', () => {
    const list = candidates(
      '<link rel="icon" type="image/png" sizes="32x32" href="/small.png">',
      'https://example.com/chrome-knows.png',
    );
    expect(list[0]).toBe('https://example.com/chrome-knows.png');
  });

  it('demotes an SVG hint below every raster the page declares', () => {
    // The whole of the fix, in one assertion: a page that publishes both is asking for the raster.
    const list = candidates(
      '<link rel="icon" type="image/png" sizes="32x32" href="/small.png">',
      'https://example.com/logo.svg',
    );
    expect(list.indexOf('https://example.com/small.png')).toBeLessThan(
      list.indexOf('https://example.com/logo.svg'),
    );
  });

  it('still offers the SVG last, rather than refusing it', () => {
    // A site whose only icon is a vector gets one now. It is rasterised on the way out.
    const list = candidates('<link rel="icon" type="image/svg+xml" href="/logo.svg">');
    expect(list).toContain('https://example.com/logo.svg');
  });

  it('prefers the declared size nearest the stored one, downscaling rather than up', () => {
    const list = candidates(`
      <link rel="icon" sizes="16x16" href="/tiny.png">
      <link rel="icon" sizes="180x180" href="/big.png">
      <link rel="icon" sizes="32x32" href="/right.png">
    `);
    expect(list.slice(0, 3)).toEqual([
      'https://example.com/right.png',
      'https://example.com/big.png',
      'https://example.com/tiny.png',
    ]);
  });

  it('falls back to /favicon.ico, which is what a browser would try', () => {
    expect(candidates('')).toEqual(['https://example.com/favicon.ico']);
  });

  it('puts an apple-touch-icon behind every ordinary one', () => {
    const list = candidates(`
      <link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
      <link rel="icon" sizes="16x16" href="/tiny.png">
    `);
    expect(list.indexOf('https://example.com/tiny.png')).toBeLessThan(
      list.indexOf('https://example.com/apple.png'),
    );
  });

  it('leaves a mask-icon alone — it is a silhouette meant to be tinted', () => {
    const list = candidates('<link rel="mask-icon" color="#000" href="/pinned.svg">');
    expect(list).not.toContain('https://example.com/pinned.svg');
  });

  it.each([
    ['a data: URL', 'data:image/png;base64,AAAA'],
    ['plain http', 'http://example.com/favicon.ico'],
  ])('refuses to fetch %s from inside the page', (_label, href) => {
    expect(candidates(`<link rel="icon" href="${href}">`)).not.toContain(href);
  });

  it('never grows past the attempt budget', () => {
    const head = Array.from(
      { length: 12 },
      (_unused, at) => `<link rel="icon" sizes="32x32" href="/icon-${at}.png">`,
    ).join('');
    expect(candidates(head).length).toBeLessThanOrEqual(MAX_ICON_CANDIDATES);
  });

  it('lists a duplicate once', () => {
    const list = candidates(
      '<link rel="icon" href="/favicon.ico">',
      'https://example.com/favicon.ico',
    );
    expect(list).toEqual(['https://example.com/favicon.ico']);
  });
});

describe('fetching the icon', () => {
  const RASTER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 7]);
  const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');

  /** A rasteriser that always succeeds, standing in for the canvas jsdom does not have. */
  const drawsIt: IconRasteriser = () => Promise.resolve(RASTER);

  function answering(answers: Record<string, () => Promise<Response>>) {
    return vi.fn<typeof fetch>((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const answer = answers[url];
      return answer === undefined ? Promise.reject(new TypeError('Failed to fetch')) : answer();
    });
  }

  it('answers with the first candidate that produced an image', async () => {
    const result = await fetchIconBytes(
      ['https://example.com/a.png', 'https://example.com/b.png'],
      answering({
        'https://example.com/a.png': () =>
          Promise.resolve(
            response({ bytes: RASTER, url: 'https://example.com/a.png' }),
          ),
      }),
      drawsIt,
    );
    expect(result).toMatchObject({ url: 'https://example.com/a.png', contentType: 'image/png' });
  });

  it('walks past a 200 that is not an image at all', async () => {
    /*
     * `/favicon.ico` on a site that has no such file very often answers 200 with an HTML error
     * page. Stopping there would mean never reaching the icon the page actually declared, which is
     * the failure this ordering exists to avoid.
     */
    const result = await fetchIconBytes(
      ['https://example.com/favicon.ico', 'https://example.com/real.png'],
      answering({
        'https://example.com/favicon.ico': () =>
          Promise.resolve(
            response({
              bytes: new TextEncoder().encode('<!doctype html><title>404</title>'),
              headers: { 'content-type': 'text/html' },
              url: 'https://example.com/favicon.ico',
            }),
          ),
        'https://example.com/real.png': () =>
          Promise.resolve(response({ bytes: RASTER, url: 'https://example.com/real.png' })),
      }),
      drawsIt,
    );
    expect(result).toMatchObject({ url: 'https://example.com/real.png' });
  });

  it('rasterises an SVG rather than refusing it, and calls it a PNG', async () => {
    const rasterise = vi.fn<IconRasteriser>(() => Promise.resolve(RASTER));
    const result = await fetchIconBytes(
      ['https://example.com/logo.svg'],
      answering({
        'https://example.com/logo.svg': () =>
          Promise.resolve(
            response({
              bytes: SVG,
              headers: { 'content-type': 'image/svg+xml', 'content-length': String(SVG.length) },
              url: 'https://example.com/logo.svg',
            }),
          ),
      }),
      rasterise,
    );

    // The bytes are compared by content: the fetch reassembles the stream into a fresh array, and
    // jsdom's `Uint8Array` is not the one this realm would deep-equal against.
    expect(rasterise).toHaveBeenCalledTimes(1);
    expect(Array.from(rasterise.mock.calls[0]?.[0] ?? new Uint8Array())).toEqual(Array.from(SVG));
    expect(rasterise.mock.calls[0]?.[1]).toBe(ICON_RASTER_EDGE);
    expect(result).toMatchObject({ contentType: 'image/png' });
    // The server's declared length described the vector, not the picture that came out of it.
    expect(result).not.toHaveProperty('declaredBytes');
  });

  it('moves on when the SVG will not draw', async () => {
    const result = await fetchIconBytes(
      ['https://example.com/logo.svg'],
      answering({
        'https://example.com/logo.svg': () =>
          Promise.resolve(
            response({
              bytes: SVG,
              headers: { 'content-type': 'image/svg+xml' },
              url: 'https://example.com/logo.svg',
            }),
          ),
      }),
      () => Promise.resolve(null),
    );
    expect(result).toEqual({ reason: 'undecodable' });
  });

  it('says so when there was nothing to try', async () => {
    expect(await fetchIconBytes([], answering({}), drawsIt)).toEqual({ reason: 'no-icon' });
  });

  it.each([
    ['a declared type', new Uint8Array([1, 2, 3]), 'image/svg+xml', true],
    ['a type with parameters', new Uint8Array([1, 2, 3]), 'image/svg+xml; charset=utf-8', true],
    ['bytes after an XML prologue', new TextEncoder().encode('<?xml version="1.0"?>\n<svg/>'), '', true],
    ['bytes after a comment', new TextEncoder().encode('<!-- made by hand -->\n<SVG/>'), '', true],
    ['a PNG', new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png', false],
    ['an ICO with no type at all', new Uint8Array([0, 0, 1, 0]), '', false],
  ])('recognises SVG from %s', (_label, bytes, contentType, expected) => {
    // Servers send `.svg` as `text/xml`, as `application/octet-stream` and as nothing at all, so
    // the bytes settle it when the header does not.
    expect(looksLikeSvg(bytes, contentType)).toBe(expected);
  });
});

/**
 * The rasteriser's own bookkeeping, with the drawing stubbed out.
 *
 * jsdom has no canvas and no `createObjectURL`, so what is exercised here is everything *around*
 * the two lines that draw: the aspect ratio, the sizeless-SVG default, the object URL being revoked
 * on every exit, and each of the four ways this is allowed to answer `null` rather than throw. That
 * the drawing itself works in a real browser — and that the canvas is not tainted, which is the
 * whole reason this technique is available — is measured in `test/e2e/thumbs.spec.ts`.
 */
describe('rasterising an SVG', () => {
  const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 5]);

  interface FakeImage {
    onload: (() => void) | null;
    onerror: (() => void) | null;
    naturalWidth: number;
    naturalHeight: number;
    src: string;
  }

  let revoked: string[] = [];
  let drawnAt: { width: number; height: number } | null = null;

  /**
   * Stand in for the three platform pieces jsdom does not have.
   *
   * `settle` decides what the `<img>` does: load at a size, fail, or never answer at all — which is
   * the case the timeout exists for and the one a hostile page could otherwise hold open.
   */
  function stubPlatform(options: {
    settle?: 'load' | 'error' | 'never';
    natural?: { width: number; height: number };
    context?: boolean;
    blob?: Blob | null;
  }): void {
    revoked = [];
    drawnAt = null;
    const settle = options.settle ?? 'load';
    const natural = options.natural ?? { width: 64, height: 64 };

    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:vm/one',
      revokeObjectURL: (url: string) => {
        revoked.push(url);
      },
    });

    vi.stubGlobal(
      'Image',
      class implements FakeImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = natural.width;
        naturalHeight = natural.height;
        #src = '';
        get src(): string {
          return this.#src;
        }
        set src(value: string) {
          this.#src = value;
          if (settle === 'never') return;
          queueMicrotask(() => {
            if (settle === 'load') this.onload?.();
            else this.onerror?.();
          });
        }
      },
    );

    const canvas = {
      width: 0,
      height: 0,
      getContext: () =>
        options.context === false
          ? null
          : {
              drawImage: (_image: unknown, _x: number, _y: number, width: number, height: number) => {
                drawnAt = { width, height };
              },
            },
      toBlob: (callback: (blob: Blob | null) => void) => {
        callback(options.blob === undefined ? new Blob([PNG]) : options.blob);
      },
    };
    vi.spyOn(document, 'createElement').mockImplementation(
      () => canvas as unknown as HTMLElement,
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws inside the edge and keeps the aspect ratio', async () => {
    stubPlatform({ natural: { width: 128, height: 64 } });

    const out = await rasteriseSvg(SVG, 64);

    expect(out).not.toBeNull();
    // A 128 × 64 wordmark squashed into a square would read as a smudge at 32 px.
    expect(drawnAt).toEqual({ width: 64, height: 32 });
  });

  it('draws a sizeless SVG square, at the edge', async () => {
    // A vector with no intrinsic dimensions has no ratio to preserve; anything else would be a guess.
    stubPlatform({ natural: { width: 0, height: 0 } });

    await rasteriseSvg(SVG, 64);

    expect(drawnAt).toEqual({ width: 64, height: 64 });
  });

  it('fills the edge even for a vector that declares a smaller size', async () => {
    stubPlatform({ natural: { width: 16, height: 16 } });

    await rasteriseSvg(SVG, 64);

    // The one place in this codebase that scales *up* on purpose, and the reason is the subject: a
    // vector has no pixels to blur, so a 16 px declaration is a hint about layout rather than a
    // resolution. Everything downstream never upscales, because everything downstream has pixels.
    expect(drawnAt).toEqual({ width: 64, height: 64 });
  });

  it.each([
    ['the image will not load', { settle: 'error' as const }],
    ['the image never answers', { settle: 'never' as const }],
    ['there is no 2d context', { context: false }],
    ['the canvas hands back nothing', { blob: null }],
  ])('answers null when %s, rather than throwing', async (_label, options) => {
    vi.useFakeTimers();
    stubPlatform(options);
    try {
      const running = rasteriseSvg(SVG, 64);
      await vi.advanceTimersByTimeAsync(RASTER_TIMEOUT_MS + 1);
      expect(await running).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('revokes the object URL whichever way it leaves', async () => {
    // A blob URL that outlives the capture pins its bytes in the page's memory for the page's life.
    stubPlatform({ settle: 'error' });
    await rasteriseSvg(SVG, 64);
    expect(revoked).toEqual(['blob:vm/one']);

    stubPlatform({});
    await rasteriseSvg(SVG, 64);
    expect(revoked).toEqual(['blob:vm/one']);
  });
});

describe('asking for an icon without naming one', () => {
  it('reads the page’s own declaration when Chrome had nothing to hint with', async () => {
    /*
     * "Chrome has no icon for this site" was a message before it was a capture. The site the user
     * only ever opens through the vault has no entry in the regular profile's favicon cache and
     * never will — and it is a perfectly ordinary site with a perfectly ordinary `<link rel=icon>`.
     */
    const fetchImpl = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        response({
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        }),
      ),
    );

    const result = await capture(
      pageWith('<link rel="icon" type="image/png" sizes="32x32" href="/icon.png">'),
      fetchImpl,
      { icon: true, image: false },
    );

    expect(result.iconUrl).toBe('https://example.com/icon.png');
    expect(result.icon).toBeDefined();
  });

  it('names the first candidate it tried when every one failed', async () => {
    const result = await capture(
      pageWith('<link rel="icon" href="/icon.png">'),
      vi.fn<typeof fetch>(() => Promise.reject(new TypeError('Failed to fetch'))),
      { icon: true, image: false },
    );
    expect(result).toMatchObject({
      iconUrl: 'https://example.com/icon.png',
      iconReason: 'blocked',
    });
    expect(result.icon).toBeUndefined();
  });
});

describe('the icon the worker asked for', () => {
  const ICON_URL = 'https://example.com/favicon.ico';
  const ICON_BYTES = new Uint8Array([0, 0, 1, 0, 9, 9]);
  const CARD = `
    <meta property="og:title" content="An article">
    <meta property="og:image" content="https://cdn.example.com/card.png">
  `;

  /** The URL a `fetch` call names, whichever of the three shapes it was given. */
  function urlOf(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    return input instanceof URL ? input.href : input.url;
  }

  /** A fetch that answers per URL, so the two requests can be told apart. */
  function fetchByUrl(answers: Record<string, () => Promise<Response>>) {
    return vi.fn<typeof fetch>((input) => {
      const answer = answers[urlOf(input)];
      return answer === undefined ? Promise.reject(new TypeError('Failed to fetch')) : answer();
    });
  }

  /** A fetch that answers everything the same way. */
  function fetchAlways(make: () => Response) {
    return vi.fn<typeof fetch>(() => Promise.resolve(make()));
  }

  it('says nothing about icons when none was asked for', async () => {
    // A capture that was not asked says nothing, rather than saying no: the fields are absent, so
    // the worker cannot mistake "we did not ask" for "the page had nothing".
    const result = await capture(
      pageWith(CARD),
      fetchAlways(() => response({ bytes: new Uint8Array([1]) })),
    );
    expect(result.icon).toBeUndefined();
    expect(result.iconUrl).toBeUndefined();
    expect(result.iconReason).toBeUndefined();
  });

  it('fetches the icon and brings back its bytes', async () => {
    const result = await capture(
      pageWith(CARD),
      fetchByUrl({
        'https://cdn.example.com/card.png': () =>
          Promise.resolve(
            response({ bytes: new Uint8Array([1, 2]), headers: { 'content-type': 'image/png' } }),
          ),
        [ICON_URL]: () =>
          Promise.resolve(
            response({
              bytes: ICON_BYTES,
              headers: { 'content-type': 'image/x-icon', 'content-length': '6' },
              url: ICON_URL,
            }),
          ),
      }),
      { iconUrl: ICON_URL },
    );

    expect(result).toMatchObject({
      iconUrl: ICON_URL,
      iconContentType: 'image/x-icon',
      iconDeclaredBytes: 6,
    });
    expect(fromBase64Url(result.icon ?? '')).toEqual(ICON_BYTES);
    expect(result.iconReason).toBeUndefined();
  });

  it('starts both fetches before awaiting either', async () => {
    // They share nothing, and the page is ours only for as long as the injection lasts. In
    // sequence this would put two eight-second timeouts end to end on the last thing an add does.
    const started: string[] = [];
    let releaseCard: (() => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = urlOf(input);
      started.push(url);
      if (url === ICON_URL) return Promise.resolve(response({ bytes: ICON_BYTES }));
      return new Promise<Response>((resolve) => {
        releaseCard = () => {
          resolve(response({ bytes: new Uint8Array([1]) }));
        };
      });
    });

    const running = capture(pageWith(CARD), fetchImpl, { iconUrl: ICON_URL });
    await Promise.resolve();
    // The picture has not answered yet, and the icon request has already gone out.
    expect(started).toContain(ICON_URL);
    releaseCard?.();
    await running;
  });

  it.each([
    ['a CSP or CORS refusal', () => Promise.reject(new TypeError('Failed to fetch')), 'blocked'],
    [
      'a body past the ceiling',
      () =>
        Promise.resolve(
          response({ headers: { 'content-length': String(MAX_FETCH_BYTES + 1) }, url: ICON_URL }),
        ),
      'too-large',
    ],
    ['a 404', () => Promise.resolve(response({ status: 404, url: ICON_URL })), 'blocked'],
  ])('reports %s as %s, and keeps the card', async (_label, answer, reason) => {
    const result = await capture(
      pageWith(CARD),
      fetchByUrl({
        'https://cdn.example.com/card.png': () =>
          Promise.resolve(response({ bytes: new Uint8Array([1]) })),
        [ICON_URL]: answer,
      }),
      { iconUrl: ICON_URL },
    );

    expect(result).toMatchObject({ ogTitle: 'An article', iconUrl: ICON_URL, iconReason: reason });
    expect(result.icon).toBeUndefined();
  });

  it.each([
    ['an empty string', ''],
    ['only whitespace', '   '],
  ])('treats %s as no request at all', async (_label, iconUrl) => {
    const fetchImpl = fetchAlways(() => response({ bytes: new Uint8Array([1]) }));
    const result = await capture(pageWith(CARD), fetchImpl, { iconUrl });
    expect(result.iconUrl).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still brings the icon back from a page with no card at all', async () => {
    // The two halves are independent, and this is the shape of a great many vault-only pages.
    const fetchImpl = fetchByUrl({
      [ICON_URL]: () => Promise.resolve(response({ bytes: ICON_BYTES, url: ICON_URL })),
    });
    const result = await capture(pageWith(''), fetchImpl, { iconUrl: ICON_URL });

    expect(result.reason).toBe('no-image');
    expect(fromBase64Url(result.icon ?? '')).toEqual(ICON_BYTES);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetches no picture when only the icon was asked for', async () => {
    // *Use this page's icon* would discard a picture, so it must not make the page pull one:
    // a fetch in somebody's page that keeps nothing is exactly what §14.4's rule is about.
    const fetchImpl = fetchByUrl({
      [ICON_URL]: () => Promise.resolve(response({ bytes: ICON_BYTES, url: ICON_URL })),
    });
    const result = await capture(pageWith(CARD), fetchImpl, { iconUrl: ICON_URL, image: false });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(ICON_URL, expect.anything());
    expect(result.image).toBeUndefined();
    expect(result.reason).toBe('no-image');
    expect(fromBase64Url(result.icon ?? '')).toEqual(ICON_BYTES);
  });

  it('reads the card’s text even when only the icon was asked for', async () => {
    // Free — it is a DOM query, not a fetch — and the worker simply ignores it on that path.
    const result = await capture(
      pageWith(CARD),
      fetchByUrl({ [ICON_URL]: () => Promise.resolve(response({ bytes: ICON_BYTES })) }),
      { iconUrl: ICON_URL, image: false },
    );
    expect(result.ogTitle).toBe('An article');
  });
});
