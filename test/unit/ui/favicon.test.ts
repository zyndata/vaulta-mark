/**
 * @vitest-environment jsdom
 *
 * Favicons (ARCHITECTURE §10, D28).
 *
 * The load-bearing assertion is that the URL is extension-origin. `https://www.google.com/s2/favicons?domain=…`
 * and its equivalents would send every vaulted domain to a third party on every render, which would
 * defeat the product — so this is INV-4's neighbourhood, and it is checked here rather than only by
 * the E2E network assertion, because a unit test names the mistake and a network trace does not.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_FAVICON_SIZE,
  avatarLetter,
  displayHost,
  faviconImage,
  faviconUrl,
  hostHue,
  letterAvatar,
} from '../../../src/ui/favicon.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('faviconUrl', () => {
  it('is always extension-origin, never a third-party service', () => {
    const url = faviconUrl('https://example.com/page');
    expect(url.startsWith(`chrome-extension://${mock.chrome.runtime.id}/_favicon/`)).toBe(true);
    expect(url).not.toMatch(/^https?:/);
  });

  it('carries the page URL and the size as parameters', () => {
    const url = new URL(faviconUrl('https://example.com/page', 64));
    expect(url.searchParams.get('pageUrl')).toBe('https://example.com/page');
    expect(url.searchParams.get('size')).toBe('64');
  });

  it('defaults to 32, so a 16 px row is sharp on a 2× display', () => {
    const url = new URL(faviconUrl('https://example.com/'));
    expect(url.searchParams.get('size')).toBe(String(DEFAULT_FAVICON_SIZE));
  });

  it('cannot be escaped by a URL full of separators', () => {
    const hostile = 'https://example.com/a?b=1&size=999#/../x';
    expect(new URL(faviconUrl(hostile)).searchParams.get('pageUrl')).toBe(hostile);
    expect(new URL(faviconUrl(hostile)).searchParams.get('size')).toBe('32');
  });
});

describe('displayHost', () => {
  it('drops www., keeps everything else', () => {
    expect(displayHost('https://www.example.com/a')).toBe('example.com');
    expect(displayHost('https://docs.example.com/a')).toBe('docs.example.com');
    expect(displayHost('https://example.com:8443/a')).toBe('example.com:8443');
  });

  it('gives back what it was handed when there is no URL to parse', () => {
    expect(displayHost('not a url')).toBe('not a url');
  });
});

describe('avatarLetter', () => {
  it('is the first letter or digit of the host, uppercased', () => {
    expect(avatarLetter('example.com')).toBe('E');
    expect(avatarLetter('7-zip.org')).toBe('7');
    expect(avatarLetter('изба.рф')).toBe('И');
  });

  it('falls back to a question mark rather than rendering nothing', () => {
    expect(avatarLetter('...')).toBe('?');
    expect(avatarLetter('')).toBe('?');
  });
});

describe('hostHue', () => {
  it('is deterministic, so the same site is the same colour on every device', () => {
    expect(hostHue('example.com')).toBe(hostHue('example.com'));
  });

  it('is a hue', () => {
    for (const host of ['a.com', 'b.com', 'example.org', 'news.ycombinator.com']) {
      expect(hostHue(host)).toBeGreaterThanOrEqual(0);
      expect(hostHue(host)).toBeLessThan(360);
    }
  });

  it('separates hosts that look alike', () => {
    expect(hostHue('example.com')).not.toBe(hostHue('example.org'));
  });
});

describe('letterAvatar', () => {
  it('is local markup with no URL in it at all', () => {
    const avatar = letterAvatar('https://example.com/a');
    expect(avatar.textContent).toBe('E');
    // No `src`, no `data:`, no namespace URI — the reason this is a styled span rather than an
    // <svg> or a data: URI is that neither of those can be said about them.
    expect(avatar.outerHTML).not.toContain('http');
    expect(avatar.outerHTML).not.toContain('data:');
  });

  it('colours by host, so the same site looks the same everywhere', () => {
    // jsdom normalises the `hsl()` we set into `rgb()`, so this asserts the property that matters
    // rather than the notation: a colour is set, and it follows the host.
    expect(letterAvatar('https://example.com/a').style.background).not.toBe('');
    expect(letterAvatar('https://example.com/a').style.background).toBe(
      letterAvatar('https://example.com/b').style.background,
    );
    expect(letterAvatar('https://example.com/').style.background).not.toBe(
      letterAvatar('https://example.org/').style.background,
    );
  });
});

describe('faviconImage', () => {
  it('points at _favicon/ and swaps itself for the avatar when it fails', () => {
    const img = faviconImage('https://example.com/a');
    expect(img.src).toContain('/_favicon/');

    const holder = document.createElement('div');
    holder.append(img);
    img.dispatchEvent(new Event('error'));

    expect(holder.querySelector('img')).toBe(null);
    expect(holder.querySelector('.vm-avatar')?.textContent).toBe('E');
  });
});
