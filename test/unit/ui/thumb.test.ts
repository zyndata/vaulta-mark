/**
 * @vitest-environment jsdom
 *
 * Showing a preview, and putting it away again (ARCHITECTURE §14.5).
 *
 * The two things worth testing here are the ones that leak if they are wrong: an object URL that is
 * never revoked keeps every picture the page has ever shown alive for as long as the window is open,
 * and a hover timer that survives its row means a card opening over a list the user has scrolled
 * away from. Both are asserted directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOVER_DELAY_MS,
  ThumbPopover,
  inlinePreview,
  previewCard,
  position,
  sniffImageType,
  thumbObjectUrl,
  type ThumbData,
} from '../../../src/ui/thumb.js';
import { toBase64Url, type Bytes } from '../../../src/crypto/codec.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  // `previewCard`'s absent states read their sentences from `_locales` through `msg()`.
  installChromeMock();
  created.length = 0;
  revoked.length = 0;
  // jsdom has neither, and both are the whole point of the module.
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:vaultamark/${String(created.length)}#${blob.type}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  document.body.replaceChildren();
});

afterEach(() => {
  vi.useRealTimers();
  uninstallChromeMock();
});

/** No card text unless a case asks for it — the common page publishes an image and nothing else. */
function ready(image: Bytes, width = 320, height = 168): ThumbData {
  return { state: 'ready', image: toBase64Url(image), width, height, ogTitle: null, ogDescription: null };
}

const NO_TEXT = { ogTitle: null, ogDescription: null } as const;

const WEBP: Bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2]);
const JPEG: Bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG: Bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('sniffImageType', () => {
  it.each([
    ['WebP', WEBP, 'image/webp'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['PNG', PNG, 'image/png'],
  ])('recognises %s', (_label, bytes, type) => {
    expect(sniffImageType(bytes)).toBe(type);
  });

  it('says nothing rather than guessing at bytes it does not recognise', () => {
    expect(sniffImageType(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBe('');
    expect(sniffImageType(new Uint8Array([]))).toBe('');
  });
});

describe('thumbObjectUrl', () => {
  it('gives the blob the type it sniffed, so the browser does not have to guess', () => {
    const handle = thumbObjectUrl(toBase64Url(WEBP));
    expect(handle.url).toContain('image/webp');
    handle.revoke();
    expect(revoked).toEqual([handle.url]);
  });

  it('revokes once, however many times it is asked', () => {
    const handle = thumbObjectUrl(toBase64Url(JPEG));
    handle.revoke();
    handle.revoke();
    handle.revoke();
    expect(revoked).toHaveLength(1);
  });
});

describe('previewCard', () => {
  it('renders the picture with the stored dimensions on it', () => {
    const card = previewCard(ready(WEBP, 320, 168));
    const img = card.element as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('width')).toBe('320');
    expect(img.getAttribute('height')).toBe('168');
    // Decorative: the title and the URL are already on the row beside it.
    expect(img.alt).toBe('');
    card.release();
    expect(revoked).toHaveLength(1);
  });

  it('says the picture is in Drive rather than showing a broken image', () => {
    const card = previewCard({ state: 'remote', image: null, width: 320, height: 168, ...NO_TEXT });
    expect(card.element.tagName).toBe('P');
    expect(card.element.className).toContain('vm-thumb-absent');
    expect(created).toEqual([]);
    // Nothing to release, and calling it anyway is harmless.
    card.release();
  });

  it('says there is no preview when there is none', () => {
    const card = previewCard({ state: 'none', image: null, width: 0, height: 0, ...NO_TEXT });
    expect(card.element.tagName).toBe('P');
  });

  it('treats `ready` with no bytes as an absence rather than an empty image', () => {
    const card = previewCard({ state: 'ready', image: null, width: 320, height: 168, ...NO_TEXT });
    expect(card.element.tagName).toBe('P');
  });
});

/*
 * The page's own title and summary — `og:title` and `og:description`, the two fields a chat client
 * renders when a link is pasted into it. Captured since Phase 11 and read by nothing until this.
 */
describe('previewCard, with the page’s own words', () => {
  const TITLE = 'Mushroom risotto, properly';
  const DESCRIPTION = 'Why most recipes rush the stock, and what to do instead.';

  it('puts the text under the picture', () => {
    const card = previewCard({ ...ready(WEBP), ogTitle: TITLE, ogDescription: DESCRIPTION });
    expect(card.element.tagName).toBe('FIGURE');
    expect(card.element.querySelector('img')).not.toBeNull();
    expect(card.element.querySelector('.vm-thumb-og-title')?.textContent).toBe(TITLE);
    expect(card.element.querySelector('.vm-thumb-og-description')?.textContent).toBe(DESCRIPTION);
    card.release();
    // The object URL is still released through the figure — it is the image's, not the card's.
    expect(revoked).toHaveLength(1);
  });

  it('is a bare image when the page published no words, exactly as before', () => {
    // The common case keeps the DOM — and therefore the CSS — it had before any of this existed.
    const card = previewCard(ready(WEBP));
    expect(card.element.tagName).toBe('IMG');
    card.release();
  });

  it('is still a card when the picture was refused but the words were not', () => {
    /*
     * The case the text was captured for, and the reason `thumbs.get()` no longer returns early on
     * a missing image: a CSP, a CDN or a `data:` URL can refuse the picture while the page has
     * published a perfectly good title and summary.
     */
    const card = previewCard({
      state: 'none',
      image: null,
      width: 0,
      height: 0,
      ogTitle: TITLE,
      ogDescription: DESCRIPTION,
    });
    expect(card.element.tagName).toBe('FIGURE');
    expect(card.element.querySelector('img')).toBeNull();
    expect(card.element.textContent).toContain(TITLE);
    // No "there is no preview" line: there *is* one, and saying otherwise contradicts the card.
    expect(card.element.querySelector('.vm-thumb-absent')).toBeNull();
  });

  it('keeps the "it is in Drive" note beside the words, because that is information', () => {
    // Unlike `none`, `remote` means the picture exists and this machine cannot reach it — worth
    // saying even when there is text to read.
    const card = previewCard({
      state: 'remote',
      image: null,
      width: 320,
      height: 168,
      ogTitle: TITLE,
      ogDescription: null,
    });
    expect(card.element.querySelector('.vm-thumb-absent')).not.toBeNull();
    expect(card.element.textContent).toContain(TITLE);
  });

  it('takes either field on its own', () => {
    const titleOnly = previewCard({ ...ready(WEBP), ogTitle: TITLE, ogDescription: null });
    expect(titleOnly.element.querySelector('.vm-thumb-og-description')).toBeNull();
    titleOnly.release();

    const descriptionOnly = previewCard({ ...ready(WEBP), ogTitle: null, ogDescription: DESCRIPTION });
    expect(descriptionOnly.element.querySelector('.vm-thumb-og-title')).toBeNull();
    descriptionOnly.release();
  });

  it('treats whitespace-only text as no text at all', () => {
    // A page that publishes `<meta property="og:title" content="   ">` has published nothing, and a
    // card drawn for it would be an empty box under a picture.
    const card = previewCard({ ...ready(WEBP), ogTitle: '   ', ogDescription: '\n\t ' });
    expect(card.element.tagName).toBe('IMG');
    card.release();
  });

  it('renders the page’s words as text, never as markup', () => {
    /*
     * This is the one place in the product where a *page's own words* reach the document, and a
     * page is hostile by assumption. `h` builds text nodes, so the check is that the angle brackets
     * survive as characters rather than becoming an element.
     */
    const hostile = '<img src=x onerror=alert(1)>';
    const card = previewCard({ ...ready(WEBP), ogTitle: hostile, ogDescription: null });
    const rendered = card.element.querySelector('.vm-thumb-og-title');
    expect(rendered?.textContent).toBe(hostile);
    expect(rendered?.querySelector('img')).toBeNull();
    expect(card.element.querySelectorAll('img')).toHaveLength(1); // the preview itself, and only it
    card.release();
  });
});

describe('inlinePreview', () => {
  it('wraps the card so the detail pane has one element to render', () => {
    const preview = inlinePreview(ready(PNG));
    expect(preview.element.className).toBe('vm-thumb-inline');
    expect(preview.element.firstElementChild?.tagName).toBe('IMG');
    preview.release();
    expect(revoked).toHaveLength(1);
  });
});

describe('ThumbPopover', () => {
  function setup(options: { coarse?: boolean; reduced?: boolean } = {}): {
    popover: ThumbPopover;
    host: HTMLElement;
    anchor: HTMLElement;
    fetch: ReturnType<typeof vi.fn>;
  } {
    const host = document.createElement('div');
    const anchor = document.createElement('div');
    host.append(anchor);
    document.body.append(host);
    const fetch = vi.fn().mockResolvedValue(ready(WEBP));
    const popover = new ThumbPopover({
      host,
      fetch,
      media: (query) =>
        query.includes('reduced-motion') ? options.reduced === true : options.coarse === true,
    });
    return { popover, host, anchor, fetch };
  }

  it('opens on a click and puts itself away on a second one', async () => {
    const { popover, host, anchor } = setup();
    await popover.open(anchor, 'item-a', true);
    expect(host.querySelector('.vm-thumb-card')).not.toBeNull();

    popover.toggle(anchor, 'item-a');
    expect(host.querySelector('.vm-thumb-card')).toBeNull();
    expect(revoked).toHaveLength(1);
  });

  it('replaces the card when a different row is opened, releasing the first', async () => {
    const { popover, host, anchor } = setup();
    await popover.open(anchor, 'item-a', true);
    await popover.open(anchor, 'item-b', true);
    expect(host.querySelectorAll('.vm-thumb-card')).toHaveLength(1);
    expect(revoked).toHaveLength(1);
  });

  it('waits out the hover delay before it asks for anything', () => {
    vi.useFakeTimers();
    const { popover, anchor, fetch } = setup();

    popover.hover(anchor, 'item-a');
    vi.advanceTimersByTime(HOVER_DELAY_MS - 1);
    expect(fetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(fetch).toHaveBeenCalledWith('item-a');
  });

  it('cancels a hover the pointer left before the delay was up', () => {
    vi.useFakeTimers();
    const { popover, anchor, fetch } = setup();

    popover.hover(anchor, 'item-a');
    popover.cancelHover();
    vi.advanceTimersByTime(HOVER_DELAY_MS * 2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves a pinned card alone when the pointer moves off the row', async () => {
    const { popover, host, anchor } = setup();
    await popover.open(anchor, 'item-a', true);
    popover.cancelHover();
    expect(host.querySelector('.vm-thumb-card')).not.toBeNull();
  });

  it('does not hover-preview under prefers-reduced-motion or on a coarse pointer', () => {
    vi.useFakeTimers();
    for (const options of [{ reduced: true }, { coarse: true }]) {
      const { popover, anchor, fetch } = setup(options);
      expect(popover.hoverEnabled).toBe(false);
      popover.hover(anchor, 'item-a');
      vi.advanceTimersByTime(HOVER_DELAY_MS * 2);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('drops an answer that arrived after the card it was for had gone', async () => {
    const { popover, host, anchor, fetch } = setup();
    let settle: (value: ThumbData) => void = () => undefined;
    fetch.mockReturnValueOnce(
      new Promise<ThumbData>((resolve) => {
        settle = resolve;
      }),
    );

    const opening = popover.open(anchor, 'item-a', true);
    popover.close();
    settle(ready(WEBP));
    await opening;

    expect(host.querySelector('.vm-thumb-card')).toBeNull();
    // The late answer never became a blob, so there is nothing to have leaked.
    expect(created).toEqual([]);
  });

  it('releases everything on destroy', async () => {
    vi.useFakeTimers();
    const { popover, host, anchor } = setup();
    const opening = popover.open(anchor, 'item-a', true);
    vi.useRealTimers();
    await opening;

    popover.destroy();
    expect(host.querySelector('.vm-thumb-card')).toBeNull();
    expect(revoked).toHaveLength(1);
  });
});

describe('position', () => {
  /** jsdom reports zeroes for every rectangle, so the boxes are stubbed. */
  function boxed(element: HTMLElement, box: Partial<DOMRect>): void {
    element.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, ...box }) as DOMRect;
  }

  it('sits under the row when there is room below it', () => {
    const host = document.createElement('div');
    const anchor = document.createElement('div');
    const card = document.createElement('div');
    boxed(host, { left: 0, top: 0, width: 1000, height: 800 });
    boxed(anchor, { left: 100, top: 200, bottom: 244, width: 600, height: 44 });
    boxed(card, { width: 320, height: 200 });

    position(card, anchor, host);
    expect(card.style.left).toBe('100px');
    expect(card.style.top).toBe('250px');
  });

  it('flips above the row when there is not', () => {
    const host = document.createElement('div');
    const anchor = document.createElement('div');
    const card = document.createElement('div');
    boxed(host, { left: 0, top: 0, width: 1000, height: 400 });
    boxed(anchor, { left: 100, top: 300, bottom: 344, width: 600, height: 44 });
    boxed(card, { width: 320, height: 200 });

    position(card, anchor, host);
    expect(card.style.top).toBe('94px');
  });

  it('keeps the card inside the host when the row runs to the right edge', () => {
    const host = document.createElement('div');
    const anchor = document.createElement('div');
    const card = document.createElement('div');
    boxed(host, { left: 0, top: 0, width: 500, height: 800 });
    boxed(anchor, { left: 400, top: 100, bottom: 144, width: 100, height: 44 });
    boxed(card, { width: 320, height: 200 });

    position(card, anchor, host);
    expect(Number.parseInt(card.style.left, 10)).toBe(500 - 320 - 8);
  });
});
