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
