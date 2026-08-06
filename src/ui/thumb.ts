/**
 * Showing a preview picture (ARCHITECTURE §14.5).
 *
 * Everything here is callback-injected — the fetch is a function the caller supplies — for the same
 * reason `incognito-prompt.ts` and `tracking.ts` are: it makes the whole of the behaviour testable
 * in jsdom without a service worker, and it keeps `src/ui/` free of the message protocol.
 *
 * Two things are worth reading twice.
 *
 * **The bytes become a `blob:` URL, never a `data:` one.** A `data:` image URL is a long string that
 * looks exactly like what the remote-code scanner exists to find (INV-1), and arguing with an
 * invariant over a decoration is the wrong way round. The URL is revoked when the preview closes;
 * a page that leaked them would hold every picture it had ever shown for as long as it was open.
 *
 * **A preview is a popover, not an expanded row.** §14.5 describes an inline expansion, and the
 * manager's list is windowed (`ui/virtual-list.ts`) with one fixed row height that the scroll
 * arithmetic depends on — a row that grew to 200 px would put every row below it in the wrong place.
 * So the click-to-pin preview and the hover preview are the same floating card, anchored to the row,
 * kept inside the viewport. The detail pane, which is not windowed, does show its preview inline.
 */

import { fromBase64Url } from '../crypto/codec.js';
import type { Bytes } from '../crypto/codec.js';
import { h, msg, render } from './dom.js';

/** How long a pointer has to rest on a row before its preview appears (§14.5). */
export const HOVER_DELAY_MS = 200;

/** What the worker answers for one item. Structurally `ThumbResponse`, without importing it. */
export interface ThumbData {
  readonly state: 'ready' | 'remote' | 'none';
  readonly image: string | null;
  readonly width: number;
  readonly height: number;
}

export type ThumbFetch = (id: string) => Promise<ThumbData>;

/**
 * The image type, from the first few bytes.
 *
 * A blob with no type makes the browser guess, and a wrong guess is a broken image icon in place of
 * a picture we have in hand. Carrying the type on the wire instead would mean either a new field in
 * the stored `ThumbMeta` — a vault schema change for a decoration — or a fourth number in every
 * `THUMB` response. Four magic numbers are cheaper than both.
 */
export function sniffImageType(bytes: Bytes): string {
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) {
    return 'image/webp';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  // Everything this module is shown was produced by `thumbs/process.ts`, which encodes WebP or JPEG
  // and nothing else. An unrecognised prefix is a damaged value, and letting the browser sniff is a
  // better failure than asserting a type it will then refuse.
  return '';
}

/** A `blob:` URL for base64url bytes, and the way to let go of it. */
export function thumbObjectUrl(image: string): { readonly url: string; revoke: () => void } {
  const bytes = fromBase64Url(image);
  const type = sniffImageType(bytes);
  const blob = new Blob([bytes], ...(type === '' ? [] : [{ type }]));
  const url = URL.createObjectURL(blob);
  let revoked = false;
  return {
    url,
    revoke: () => {
      // Idempotent: a card can be closed by a click, by a second hover and by the list rebuilding
      // underneath it, and two of those routinely happen in the same frame.
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(url);
    },
  };
}

/** A preview element, plus whatever has to be released when it leaves the page. */
export interface PreviewCard {
  readonly element: HTMLElement;
  /** A property rather than a method, so it can be handed around without carrying a `this`. */
  readonly release: () => void;
}

/**
 * The picture, or the quiet sentence that stands in for it.
 *
 * `width`/`height` are set as attributes even when there is no image, so the box is the right shape
 * before anything loads and stays the right shape when nothing does — the "no layout shift" half of
 * §14.5's graceful absence. `remote` is a note, not an error: the picture exists, it is in Drive,
 * and this machine is not connected to it.
 */
export function previewCard(data: ThumbData): PreviewCard {
  if (data.state === 'ready' && data.image !== null) {
    const handle = thumbObjectUrl(data.image);
    const img = h('img', {
      class: 'vm-thumb-image',
      alt: '',
      decoding: 'async',
      width: String(data.width),
      height: String(data.height),
    });
    img.src = handle.url;
    return { element: img, release: handle.revoke };
  }

  const element = h(
    'p',
    { class: 'vm-thumb-absent vm-small vm-muted' },
    msg(data.state === 'remote' ? 'thumbInDrive' : 'thumbNone'),
  );
  return { element, release: () => undefined };
}

/* ------------------------------------------------------------------ the floating card */

export interface ThumbPopoverDeps {
  readonly fetch: ThumbFetch;
  /** Where the card is appended. The manager's layout root, so it is positioned against the page. */
  readonly host: HTMLElement;
  /** Test seam for the two media queries below. */
  readonly media?: (query: string) => boolean;
}

/**
 * One floating preview at a time, opened by a click (pinned) or by a hover that outlived its delay.
 *
 * "One at a time" is the whole state machine: opening replaces whatever was there, which is also
 * what releases its object URL. There is no queue, no animation and nothing that survives the list
 * being rebuilt underneath it.
 */
export class ThumbPopover {
  readonly #deps: ThumbPopoverDeps;
  #card: PreviewCard | null = null;
  #element: HTMLElement | null = null;
  #openFor: string | null = null;
  #pinned = false;
  #hoverTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every open so a slow fetch cannot paint over a newer one. */
  #generation = 0;

  constructor(deps: ThumbPopoverDeps) {
    this.#deps = deps;
  }

  /** Whether hover previews are appropriate here at all (§14.5). */
  get hoverEnabled(): boolean {
    const media = this.#deps.media ?? ((query: string) => globalThis.matchMedia(query).matches);
    // Reduced motion takes a preview that appears under the pointer as motion, and a coarse pointer
    // has no hover to speak of — on a touch screen every "hover" is the beginning of a tap.
    return !media('(prefers-reduced-motion: reduce)') && !media('(pointer: coarse)');
  }

  /** Arm the hover delay for a row. Cancelled by {@link cancelHover} on the way out. */
  hover(anchor: HTMLElement, id: string): void {
    if (!this.hoverEnabled || this.#pinned) return;
    this.cancelHover();
    this.#hoverTimer = setTimeout(() => {
      this.#hoverTimer = null;
      void this.open(anchor, id, false);
    }, HOVER_DELAY_MS);
  }

  cancelHover(): void {
    if (this.#hoverTimer !== null) clearTimeout(this.#hoverTimer);
    this.#hoverTimer = null;
    if (!this.#pinned) this.close();
  }

  /** Click-to-pin. Clicking the same row again puts it away. */
  toggle(anchor: HTMLElement, id: string): void {
    if (this.#pinned && this.#openFor === id) {
      this.close();
      return;
    }
    void this.open(anchor, id, true);
  }

  async open(anchor: HTMLElement, id: string, pinned: boolean): Promise<void> {
    // The generation is claimed *after* the close, because `close()` bumps it too — taking one
    // first and then closing would leave every open cancelling itself before it painted.
    this.close();
    const generation = ++this.#generation;
    this.#pinned = pinned;
    this.#openFor = id;

    const data = await this.#deps.fetch(id);
    // The row was rebuilt, another preview opened, or the user moved on while the bytes were
    // arriving — all of which mean this answer is for a card nobody is waiting for any more.
    if (generation !== this.#generation) return;

    const card = previewCard(data);
    const element = h('div', { class: 'vm-thumb-card', role: 'presentation' }, card.element);
    this.#card = card;
    this.#element = element;
    this.#deps.host.append(element);
    position(element, anchor, this.#deps.host);
  }

  close(): void {
    this.#generation++;
    this.#pinned = false;
    this.#openFor = null;
    this.#element?.remove();
    this.#card?.release();
    this.#element = null;
    this.#card = null;
  }

  destroy(): void {
    this.cancelHover();
    this.close();
  }
}

/**
 * Put the card beside its row, and keep it on screen.
 *
 * Positioned against the host's own box rather than the viewport's, because the host is what the
 * card is a child of — reading `getBoundingClientRect` on both and subtracting is what makes the
 * numbers mean the same thing whether or not the page has scrolled.
 */
export function position(card: HTMLElement, anchor: HTMLElement, host: HTMLElement): void {
  const box = anchor.getBoundingClientRect();
  const frame = host.getBoundingClientRect();
  const size = card.getBoundingClientRect();

  const left = Math.min(
    Math.max(8, box.left - frame.left),
    Math.max(8, frame.width - size.width - 8),
  );
  // Below the row if it fits, above it if it does not. Never overlapping the row itself: the card is
  // a preview of what is under the pointer, and covering it is how a hover preview becomes a
  // flickering loop of enter and leave events.
  const below = box.bottom - frame.top + 6;
  const above = box.top - frame.top - size.height - 6;
  const top = below + size.height <= frame.height ? below : Math.max(8, above);

  card.style.left = `${String(Math.round(left))}px`;
  card.style.top = `${String(Math.round(top))}px`;
}

/** The detail pane's inline preview: the picture and, under it, whatever the card said. */
export function inlinePreview(data: ThumbData): PreviewCard {
  const card = previewCard(data);
  const element = h('div', { class: 'vm-thumb-inline' }, card.element);
  return { element, release: card.release };
}

export { render };
