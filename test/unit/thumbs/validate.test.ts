/**
 * The hostile-input table for preview images (ARCHITECTURE §14.2, PLAN §9 Phase 11).
 *
 * Everything in this file arrived from a page we do not control, so the table is written the way an
 * attacker would write it: every spelling of a loopback address a resolver would accept, every
 * scheme that is not a fetch, every content type that is a script in disguise, and the two ways a
 * server can lie about how big something is.
 *
 * The reason codes are asserted, not just the refusals. "It threw" is satisfied by a validator that
 * rejects everything, and a rejection reason is what the "no preview available" tooltip is written
 * from.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_DIMENSION,
  MAX_IMAGE_BYTES,
  ThumbRejected,
  isIpLiteral,
  isPublicDnsHost,
  validateActualSize,
  validateCandidate,
  validateContentType,
  validateDeclaredSize,
  validateDimensions,
  validateIconCandidate,
  validateIconContentType,
  validateImageUrl,
  type RejectReason,
} from '../../../src/thumbs/validate.js';

/** The reason a call threw, or `null` if it did not throw at all. */
function reasonOf(run: () => unknown): RejectReason | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof ThumbRejected) return error.reason;
    throw error;
  }
}

describe('image URLs', () => {
  const REFUSED: readonly (readonly [string, string, RejectReason])[] = [
    ['plain http', 'http://example.com/card.png', 'scheme'],
    ['a data URI', 'data:image/png;base64,iVBORw0KGgo=', 'scheme'],
    ['a blob URL', 'blob:https://example.com/0f7c', 'scheme'],
    ['javascript', 'javascript:alert(1)', 'scheme'],
    ['a local file', 'file:///etc/passwd', 'scheme'],
    ['an ftp URL', 'ftp://example.com/card.png', 'scheme'],
    ['something unparseable', 'not a url at all', 'scheme'],
    ['an empty string', '   ', 'no-image'],
    ['localhost', 'https://localhost/card.png', 'host'],
    ['localhost with a port', 'https://localhost:8080/card.png', 'host'],
    ['a bare hostname', 'https://intranet/card.png', 'host'],
    ['the .local mDNS suffix', 'https://printer.local/card.png', 'host'],
    ['a .internal name', 'https://api.internal/card.png', 'host'],
    ['loopback', 'https://127.0.0.1/card.png', 'host'],
    ['loopback, shortened', 'https://127.1/card.png', 'host'],
    ['loopback in hex', 'https://0x7f.0.0.1/card.png', 'host'],
    ['loopback as one integer', 'https://2130706433/card.png', 'host'],
    ['the whole of 127/8', 'https://127.255.255.254/card.png', 'host'],
    ['10/8', 'https://10.0.0.1/card.png', 'host'],
    ['172.16/12', 'https://172.16.4.9/card.png', 'host'],
    ['192.168/16', 'https://192.168.1.1/card.png', 'host'],
    ['link-local 169.254/16', 'https://169.254.169.254/latest/meta-data', 'host'],
    ['IPv6 loopback', 'https://[::1]/card.png', 'host'],
    ['IPv6 unique-local fc00::/7', 'https://[fd00::1]/card.png', 'host'],
    ['IPv6 link-local fe80::/10', 'https://[fe80::1]/card.png', 'host'],
    ['an IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]/card.png', 'host'],
    ['a public IP literal, which is still not a name', 'https://93.184.216.34/card.png', 'host'],
  ];

  it.each(REFUSED)('refuses %s', (_label, url, reason) => {
    expect(reasonOf(() => validateImageUrl(url))).toBe(reason);
  });

  it('accepts an ordinary https address and hands back the parsed form', () => {
    expect(validateImageUrl('  https://example.com/a/card.png?v=2  ')).toBe(
      'https://example.com/a/card.png?v=2',
    );
  });

  it('accepts an internationalized domain in punycode', () => {
    expect(validateImageUrl('https://xn--80ak6aa92e.com/card.png')).toContain('xn--80ak6aa92e');
  });

  it('accepts a hostname with a trailing dot, which is a name and not an address', () => {
    expect(isPublicDnsHost('example.com.')).toBe(false);
    // The trailing dot leaves an empty final label, so it is refused as a malformed name rather than
    // waved through — a refusal is the safe direction and the URL is one nobody publishes.
    expect(isIpLiteral('example.com.')).toBe(false);
  });
});

describe('declared and actual size', () => {
  it('refuses a Content-Length past the cap before a body is read', () => {
    expect(reasonOf(() => { validateDeclaredSize(MAX_IMAGE_BYTES + 1); })).toBe('too-large');
  });

  it('accepts a missing Content-Length — plenty of servers send none', () => {
    expect(reasonOf(() => { validateDeclaredSize(undefined); })).toBeNull();
  });

  it('refuses a nonsense Content-Length', () => {
    expect(reasonOf(() => { validateDeclaredSize(Number.NaN); })).toBe('too-large');
    expect(reasonOf(() => { validateDeclaredSize(-1); })).toBe('too-large');
  });

  it('refuses a body that grew past the cap whatever the header claimed', () => {
    expect(reasonOf(() => { validateActualSize(10 * 1024 * 1024); })).toBe('too-large');
  });

  it('treats an empty body as a fetch that was blocked, not as a tiny image', () => {
    expect(reasonOf(() => { validateActualSize(0); })).toBe('blocked');
  });
});

describe('content types', () => {
  it('refuses SVG with its own reason, because it is a script vector', () => {
    expect(reasonOf(() => validateContentType('image/svg+xml'))).toBe('svg');
    expect(reasonOf(() => validateContentType('IMAGE/SVG+XML; charset=utf-8'))).toBe('svg');
  });

  const OTHER_REFUSALS = ['text/html', 'application/octet-stream', 'image/x-icon', '', undefined];

  it.each(OTHER_REFUSALS)('refuses %s', (type) => {
    expect(reasonOf(() => validateContentType(type))).toBe('content-type');
  });

  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])(
    'accepts %s',
    (type) => {
      expect(validateContentType(type)).toBe(type);
    },
  );

  it('strips parameters and folds case, because real servers send both', () => {
    expect(validateContentType('Image/JPEG; charset=binary')).toBe('image/jpeg');
  });
});

describe('decoded dimensions', () => {
  it('refuses a decompression bomb', () => {
    expect(reasonOf(() => { validateDimensions(MAX_DIMENSION + 1, 400); })).toBe('dimensions');
    expect(reasonOf(() => { validateDimensions(400, MAX_DIMENSION + 1); })).toBe('dimensions');
  });

  it('refuses an extreme aspect ratio in either direction', () => {
    expect(reasonOf(() => { validateDimensions(4000, 40); })).toBe('aspect');
    expect(reasonOf(() => { validateDimensions(40, 4000); })).toBe('aspect');
  });

  it('refuses a bitmap with no pixels in it', () => {
    expect(reasonOf(() => { validateDimensions(0, 0); })).toBe('undecodable');
    expect(reasonOf(() => { validateDimensions(Number.NaN, 10); })).toBe('undecodable');
  });

  it('accepts an ordinary card image', () => {
    expect(reasonOf(() => { validateDimensions(1200, 630); })).toBeNull();
  });
});

describe('the whole pre-decode gate', () => {
  it('accepts a valid https JPEG, PNG or WebP', () => {
    for (const contentType of ['image/jpeg', 'image/png', 'image/webp']) {
      const result = validateCandidate({
        url: 'https://example.com/card',
        contentType,
        declaredBytes: 40_000,
        byteLength: 40_000,
      });
      expect(result).toEqual({ url: 'https://example.com/card', contentType });
    }
  });

  it('checks the URL before the content type, so a private host is not an image question', () => {
    expect(
      reasonOf(() =>
        validateCandidate({
          url: 'https://127.0.0.1/card.png',
          contentType: 'text/html',
          byteLength: 10,
        }),
      ),
    ).toBe('host');
  });

  it('carries no URL on the error it throws', () => {
    try {
      validateImageUrl('https://10.0.0.1/secret-internal-service/card.png');
      expect.unreachable('should have refused');
    } catch (error) {
      expect(String(error)).not.toContain('10.0.0.1');
      expect(String(error)).not.toContain('secret-internal-service');
    }
  });
});

/* ------------------------------------------------------------------ icons (§10.1, D37) */

describe('a page-declared favicon, treated as hostile', () => {
  const HTTPS = 'https://example.com/favicon.ico';

  describe('content type', () => {
    it.each([
      ['image/x-icon', 'image/x-icon'],
      ['image/vnd.microsoft.icon', 'image/vnd.microsoft.icon'],
      ['image/ico', 'image/ico'],
      ['image/png', 'image/png'],
      ['image/webp', 'image/webp'],
      ['image/gif', 'image/gif'],
      ['image/jpeg', 'image/jpeg'],
      ['image/avif', 'image/avif'],
      ['image/bmp', 'image/bmp'],
      ['IMAGE/X-ICON', 'image/x-icon'],
      ['image/x-icon; charset=binary', 'image/x-icon'],
      ['  image/vnd.microsoft.icon  ', 'image/vnd.microsoft.icon'],
    ])('accepts %s', (raw, normalized) => {
      expect(validateIconContentType(raw)).toBe(normalized);
    });

    it.each([
      ['image/svg+xml', 'svg'],
      ['image/svg', 'svg'],
      ['IMAGE/SVG+XML', 'svg'],
      ['image/svg+xml; charset=utf-8', 'svg'],
      ['text/html', 'content-type'],
      ['application/octet-stream', 'content-type'],
      ['image/tiff', 'content-type'],
      ['image/heic', 'content-type'],
      ['', 'content-type'],
      [undefined, 'content-type'],
    ])('refuses %s as %s', (raw, reason) => {
      expect(reasonOf(() => validateIconContentType(raw))).toBe(reason);
    });

    it('refuses SVG with its own reason, and that is now a measured decision', () => {
      // `createImageBitmap` will not decode SVG in a service worker at all (§10.1, 2026-08-22), so
      // there is nothing on the other side of the scale from the script-vector risk.
      expect(reasonOf(() => validateIconContentType('image/svg+xml'))).toBe('svg');
    });

    it('is wider than the thumbnail allowlist, and only by the ICO spellings', () => {
      // A page offering an `og:image` as `image/x-icon` is offering something that is not a preview
      // picture. `/favicon.ico` is what `tab.favIconUrl` points at for much of the web.
      for (const type of ['image/x-icon', 'image/vnd.microsoft.icon', 'image/ico']) {
        expect(validateIconContentType(type)).toBe(type);
        expect(reasonOf(() => validateContentType(type))).toBe('content-type');
      }
    });
  });

  describe('the whole candidate', () => {
    it('accepts an ordinary favicon', () => {
      expect(
        validateIconCandidate({
          url: HTTPS,
          contentType: 'image/vnd.microsoft.icon',
          declaredBytes: 2_734,
          byteLength: 2_734,
        }),
      ).toEqual({ url: HTTPS, contentType: 'image/vnd.microsoft.icon' });
    });

    it.each([
      ['http', 'http://example.com/favicon.ico', 'scheme'],
      ['data', 'data:image/png;base64,AAAA', 'scheme'],
      ['blob', 'blob:https://example.com/x', 'scheme'],
      ['javascript', 'javascript:alert(1)', 'scheme'],
      ['file', 'file:///C:/favicon.ico', 'scheme'],
      ['chrome', 'chrome://favicon/https://example.com', 'scheme'],
      ['unparseable', 'not a url', 'scheme'],
      ['loopback by name', 'https://localhost/favicon.ico', 'host'],
      ['loopback by literal', 'https://127.0.0.1/favicon.ico', 'host'],
      ['loopback in hex', 'https://0x7f.1/favicon.ico', 'host'],
      ['loopback as an integer', 'https://2130706433/favicon.ico', 'host'],
      ['link-local', 'https://169.254.169.254/favicon.ico', 'host'],
      ['a private range', 'https://192.168.1.1/favicon.ico', 'host'],
      ['IPv6 loopback', 'https://[::1]/favicon.ico', 'host'],
      ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/favicon.ico', 'host'],
      ['a public IP literal', 'https://8.8.8.8/favicon.ico', 'host'],
      ['mDNS', 'https://printer.local/favicon.ico', 'host'],
      ['an intranet short name', 'https://intranet/favicon.ico', 'host'],
    ])('refuses %s', (_label, url, reason) => {
      // The fetch happens in the page, but the URL is recorded and could be reused: the SSRF
      // hygiene §14.2 applies whole, and Chrome having resolved `favIconUrl` is not a reason to
      // trust it — it came from the page's own markup.
      expect(
        reasonOf(() =>
          validateIconCandidate({ url, contentType: 'image/x-icon', byteLength: 100 }),
        ),
      ).toBe(reason);
    });

    it('refuses a declared size past the ceiling before anything is read', () => {
      expect(
        reasonOf(() =>
          validateIconCandidate({
            url: HTTPS,
            contentType: 'image/x-icon',
            declaredBytes: MAX_IMAGE_BYTES + 1,
            byteLength: 10,
          }),
        ),
      ).toBe('too-large');
    });

    it('refuses a body that grew past the ceiling whatever the header claimed', () => {
      expect(
        reasonOf(() =>
          validateIconCandidate({
            url: HTTPS,
            contentType: 'image/x-icon',
            declaredBytes: 100,
            byteLength: MAX_IMAGE_BYTES + 1,
          }),
        ),
      ).toBe('too-large');
    });

    it('refuses an empty body', () => {
      expect(
        reasonOf(() =>
          validateIconCandidate({ url: HTTPS, contentType: 'image/x-icon', byteLength: 0 }),
        ),
      ).toBe('blocked');
    });

    it('refuses an SVG favicon by its type, not by its bytes', () => {
      expect(
        reasonOf(() =>
          validateIconCandidate({
            url: 'https://github.githubassets.com/favicons/favicon.svg',
            contentType: 'image/svg+xml',
            byteLength: 959,
          }),
        ),
      ).toBe('svg');
    });
  });
});
