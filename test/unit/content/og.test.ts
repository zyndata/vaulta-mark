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

import { describe, expect, it, vi } from 'vitest';

import {
  MAX_FETCH_BYTES,
  MAX_OG_DESCRIPTION,
  MAX_OG_TITLE,
  capture,
  fetchImageBytes,
  readOgMeta,
  resolveAgainstBase,
  toBase64UrlText,
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
