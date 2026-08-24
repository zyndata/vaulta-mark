/**
 * The icon a page declares about itself (PLAN §9 Phase 19, ARCHITECTURE §10.1, D37).
 *
 * The feature exists for one case and it is worth naming before the first assertion: a bookmark
 * whose site the user reaches **only** through VaultaMark is opened in an incognito window, an
 * incognito profile writes no favicon entry, and so `_favicon/` answers with the generic globe for
 * that host **for ever**. No amount of waiting fixes it. The page's own declared icon is the only
 * source left, and the only legal way to reach it is the one thumbnails already use — fetch it in
 * the page's own context, inside the add-time `activeTab` injection.
 *
 * Three claims here are about what is *not* done, and each is asserted against the injection seam
 * rather than against stored state, because a build that asked and then discarded the answer would
 * pass every "nothing was stored" test and would be a different product:
 *
 * - an icon is asked for **only** when `captureOnAdd` stored nothing (§10.1, *an upgrade never
 *   overwrites*);
 * - nothing is injected at all on the Chrome tier with the opt-in off (§14.4, unchanged by this
 *   phase and re-asserted here from the icon side);
 * - the icon-only path asks for no OG picture, because it would discard one.
 *
 * **The ask and the hint are two different things**, and half of these assertions are about the
 * difference. The worker asks the page for an icon (`icon: true`) and passes `tab.favIconUrl` as a
 * *hint* when Chrome resolved a usable one. A missing or unusable hint is no longer a reason not to
 * ask: the page reads its own `<link rel="icon">` set, and the page Chrome has no icon for is
 * precisely the page this feature exists for.
 *
 * The platform half — `createImageBitmap`, `OffscreenCanvas` — does not exist in Node, so a
 * stand-in answers with fixed sizes while `thumbs/process.ts` runs for real. The genuine decode of a
 * genuine `.ico`, in Chromium, is `test/e2e/icons.spec.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';
import { chromeTier, fakeDrive, type FakeProvider } from '../../helpers/provider.js';
import { toBase64Url, type Bytes } from '../../../src/crypto/codec.js';
import { VaultRepository } from '../../../src/storage/repo.js';
import { listIconNames } from '../../../src/storage/local.js';
import { configureSync, resetSync } from '../../../src/sync/engine.js';
import { loadIcon, type IconStoreDeps } from '../../../src/thumbs/favicons.js';
import {
  captureOnAdd,
  refreshIcon,
  resetIconState,
  wantsPageIcon,
  type IconOutcome,
} from '../../../src/background/favicons.js';
import { capture, refresh } from '../../../src/background/thumbs.js';
import { parseResponse } from '../../../src/shared/messages.js';

const PASSWORD = 'a reasonably long master password';
const PAGE = 'https://vault-only.example/private/page';
const FAVICON = 'https://vault-only.example/favicon.ico';

let mock: ChromeMock;
let repo: VaultRepository;
let provider: FakeProvider;

/** What `_favicon/` answers, by `pageUrl`. Anything absent gets Chrome's globe — the common case. */
let cache: Map<string, Bytes>;
/** Every URL `fetch` saw. `_favicon/` reads are our own origin; nothing else may appear. */
let fetched: string[] = [];

/** Chrome's generic globe: byte-identical for every host it knows nothing about (measured). */
const PLACEHOLDER = bytes(646, 1);
/** A real answer from Chrome's cache, for a site the user *has* browsed normally. */
const CHROME_ICON = bytes(646, 9);
/** What the page itself serves at `/favicon.ico`. */
const PAGE_ICON = bytes(2_734, 17);

function bytes(length: number, seed: number): Bytes {
  const out = new Uint8Array(length);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < length; i++) out[i] = (i * seed) % 251;
  return out;
}

function deps(): IconStoreDeps {
  return { cipher: repo.iconCipher(), provider };
}

/** The tab the user is on, as `activeTab` makes it readable — `favIconUrl` included (§10.1). */
function openPage(options: { url?: string; favIconUrl?: string | undefined } = {}): void {
  mock.openTabs.length = 0;
  mock.openTabs.push({
    id: 7,
    url: options.url ?? PAGE,
    title: 'A private page',
    active: true,
    ...(options.favIconUrl === undefined ? {} : { favIconUrl: options.favIconUrl }),
  });
}

/**
 * A page that answers with an icon **only when it was asked for one**.
 *
 * That is the whole shape of D37 on the page side, and modelling it as a function rather than a
 * fixed value is what lets "the worker did not ask" be distinguishable from "the page had nothing".
 */
function pageAnswers(options: { icon?: Bytes; contentType?: string; image?: boolean } = {}): void {
  mock.captureResult = (request: unknown) => {
    const asked = (request ?? {}) as { icon?: boolean; iconUrl?: string; image?: boolean };
    const wantsImage = asked.image !== false;
    return {
      ogTitle: 'A private page',
      ...(wantsImage
        ? {
            imageUrl: 'https://cdn.vault-only.example/card.png',
            src: 'og',
            contentType: 'image/png',
            image: toBase64Url(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])),
          }
        : {}),
      // Keyed on the *ask*, not on the hint: the real page resolves a candidate itself, and echoes
      // back whichever URL it actually fetched.
      ...(asked.icon !== true
        ? {}
        : {
            iconUrl: asked.iconUrl ?? FAVICON,
            iconContentType: options.contentType ?? 'image/vnd.microsoft.icon',
            icon: toBase64Url(options.icon ?? PAGE_ICON),
          }),
    };
  };
}

/** A page that was asked for an icon and had nothing usable — no `<link>`, or a CSP that said no. */
function pageOffersNoIcon(): void {
  mock.captureResult = (request: unknown) => {
    const asked = (request ?? {}) as { icon?: boolean };
    return {
      ogTitle: 'A private page',
      ...(asked.icon !== true ? {} : { iconReason: 'no-icon' }),
    };
  };
}

async function addBookmark(url = PAGE): Promise<string> {
  const [item] = await repo.apply([
    { kind: 'add', input: { type: 'bookmark', title: 'A private page', url } },
  ]);
  await repo.flush();
  return item!.id;
}

/**
 * What `items.addActiveTab` does, in the order it does it.
 *
 * `_favicon/` first — free, and it reaches all four add gestures — and what it came to is what
 * decides whether the injection is also asked for the page's icon. Reproduced here rather than
 * driven through the router because the router has no way to put this profile on the Drive tier.
 */
async function addLikeTheProductDoes(url = PAGE): Promise<{ id: string; outcome: IconOutcome }> {
  const id = await addBookmark(url);
  const outcome = await captureOnAdd(repo, url);
  await capture(repo, id, { wantIcon: wantsPageIcon(outcome) });
  return { id, outcome };
}

/** What the worker handed the page, or `undefined` if it made no reader injection. */
function captureRequest(): { icon?: boolean; iconUrl?: string; image?: boolean } | undefined {
  const reader = mock.injections.find((injection) => injection.hasFunc);
  return reader?.args?.[0] as { icon?: boolean; iconUrl?: string; image?: boolean } | undefined;
}

/** Whether the page was asked for an icon at all. */
function iconAsked(): boolean {
  return captureRequest()?.icon === true;
}

/** The hint the worker passed, or `undefined` — which now means "Chrome has no opinion". */
function iconHint(): string | undefined {
  return captureRequest()?.iconUrl;
}

/* ------------------------------------------------------------------ the platform stand-in */

interface StubbedGlobals {
  createImageBitmap?: unknown;
  OffscreenCanvas?: unknown;
}

let bitmapSize = { width: 48, height: 48 };

beforeAll(() => {
  const globals = globalThis as StubbedGlobals;
  globals.createImageBitmap = () => Promise.resolve({ ...bitmapSize, close: () => undefined });
  globals.OffscreenCanvas = class {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext(): { drawImage: () => void } {
      return { drawImage: () => undefined };
    }
    convertToBlob(options: { type: string }): Promise<Blob> {
      return Promise.resolve(new Blob([new Uint8Array(900)], { type: options.type }));
    }
  };
});

afterAll(() => {
  const globals = globalThis as StubbedGlobals;
  delete globals.createImageBitmap;
  delete globals.OffscreenCanvas;
  uninstallChromeMock();
});

beforeEach(async () => {
  bitmapSize = { width: 48, height: 48 };
  uninstallChromeMock();
  mock = installChromeMock();
  cache = new Map();
  fetched = [];
  resetIconState();
  resetSync();

  vi.stubGlobal('fetch', (input: string) => {
    fetched.push(input);
    const pageUrl = new URL(input).searchParams.get('pageUrl') ?? '';
    return Promise.resolve(new Response(new Uint8Array(cache.get(pageUrl) ?? PLACEHOLDER)));
  });

  repo = new VaultRepository({ coalesceMs: 0 });
  await repo.create(PASSWORD);
  provider = fakeDrive();
  configureSync({ repository: () => Promise.resolve(repo), provider: () => provider });

  openPage({ favIconUrl: FAVICON });
  pageAnswers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSync();
  uninstallChromeMock();
});

/* ------------------------------------------------------------------ the four combinations */

describe('an icon is asked for only where one is missing (§10.1)', () => {
  it('Chrome has one, the page declares one → Chrome wins and the page is never asked', async () => {
    cache.set(PAGE, CHROME_ICON);

    const { outcome } = await addLikeTheProductDoes();

    expect(outcome).toBe('stored');
    expect(iconAsked()).toBe(false);
    expect((await loadIcon(deps(), 'vault-only.example'))?.source).toBe('chrome');
  });

  it('Chrome has nothing, the page declares one → the page fills the gap', async () => {
    // The case the whole phase exists for: a site reached only through the vault.
    const { outcome } = await addLikeTheProductDoes();

    expect(outcome).toBe('placeholder');
    expect(iconAsked()).toBe(true);
    expect(iconHint()).toBe(FAVICON);
    expect(await loadIcon(deps(), 'vault-only.example')).toMatchObject({ source: 'page' });
  });

  it('Chrome has one, the page declares none → Chrome wins, still unasked', async () => {
    cache.set(PAGE, CHROME_ICON);
    pageOffersNoIcon();

    await addLikeTheProductDoes();

    expect(iconAsked()).toBe(false);
    expect((await loadIcon(deps(), 'vault-only.example'))?.source).toBe('chrome');
  });

  it('neither has one → nothing is stored, and that is not an error', async () => {
    pageOffersNoIcon();

    await addLikeTheProductDoes();

    expect(iconAsked()).toBe(true);
    expect(await listIconNames()).toEqual([]);
  });
});

describe('which outcomes are worth asking the page about', () => {
  it.each([
    ['placeholder', true],
    ['unreadable', true],
    ['stored', false],
    ['held', false],
    ['off', false],
    ['unusable', false],
  ] as const)('%s → %s', (outcome, expected) => {
    expect(wantsPageIcon(outcome)).toBe(expected);
  });
});

/* ------------------------------------------------------------------ what is never asked */

describe('the tier gate, from the icon side (§14.4)', () => {
  it('injects nothing at all on the Chrome tier with the opt-in off', async () => {
    provider = chromeTier();
    configureSync({ repository: () => Promise.resolve(repo), provider: () => provider });

    const { outcome } = await addLikeTheProductDoes();

    expect(outcome).toBe('off');
    expect(mock.injections).toEqual([]);
    expect(await listIconNames()).toEqual([]);
  });
});

describe('what the worker hands the page', () => {
  it('still asks when the tab declares no icon — that is the case this exists for', async () => {
    // The page whose host the regular profile has never visited has no `favIconUrl`, and it is
    // exactly the page whose own `<link rel="icon">` is the only source left. Asking without a hint
    // is what makes "Chrome has no icon for this site" answerable instead of merely reportable.
    openPage({ favIconUrl: undefined });
    await addLikeTheProductDoes();

    expect(iconAsked()).toBe(true);
    expect(iconHint()).toBeUndefined();
    expect(await loadIcon(deps(), 'vault-only.example')).toMatchObject({ source: 'page' });
  });

  it.each([
    ['a data: URL', 'data:image/png;base64,AAAA'],
    ['a chrome:// address', 'chrome://favicon/https://vault-only.example'],
    ['plain http', 'http://vault-only.example/favicon.ico'],
    ['nothing at all', ''],
  ])('passes no hint for %s, and still asks', async (_label, favIconUrl) => {
    // A hint is a URL the page is going to fetch, so an unusable one is worse than none: it would
    // be routine wasted work inside somebody else's page. The ask survives it; the hint does not.
    openPage({ favIconUrl });
    await addLikeTheProductDoes();

    expect(iconAsked()).toBe(true);
    expect(iconHint()).toBeUndefined();
  });

  it('asks for no OG picture when only the icon is wanted', async () => {
    await addBookmark();
    await refreshIcon(repo, PAGE);

    expect(captureRequest()).toMatchObject({ icon: true, iconUrl: FAVICON, image: false });
  });
});

/* ------------------------------------------------------------------ hostile bytes */

describe('what comes back from the page is hostile (§14.2)', () => {
  it.each([
    ['an SVG, which no worker will decode', 'image/svg+xml'],
    ['an HTML error page served as the icon', 'text/html'],
    ['a TIFF nobody asked for', 'image/tiff'],
    ['no content type at all', ''],
  ])('stores nothing for %s', async (_label, contentType) => {
    pageAnswers({ contentType });
    await addLikeTheProductDoes();
    expect(await listIconNames()).toEqual([]);
  });

  it('stores nothing when the icon will not decode', async () => {
    const globals = globalThis as StubbedGlobals;
    const real = globals.createImageBitmap;
    globals.createImageBitmap = () => Promise.reject(new Error('not an image'));
    try {
      await addLikeTheProductDoes();
      expect(await listIconNames()).toEqual([]);
    } finally {
      globals.createImageBitmap = real;
    }
  });

  it('stores nothing for a decompression bomb', async () => {
    bitmapSize = { width: 20_000, height: 20_000 };
    await addLikeTheProductDoes();
    expect(await listIconNames()).toEqual([]);
  });

  it('leaves the bookmark alone when the icon is refused', async () => {
    pageAnswers({ contentType: 'image/svg+xml' });
    const { id } = await addLikeTheProductDoes();
    expect(repo.getItem(id)).toBeDefined();
  });

  it('makes no request from this origin — the page fetched, we did not (INV-4)', async () => {
    await addLikeTheProductDoes();
    // Everything `fetch` saw here is `_favicon/`, which is our own origin and a local cache read.
    expect(fetched.every((url) => url.includes('/_favicon/'))).toBe(true);
    expect(fetched.some((url) => url.includes('vault-only.example/favicon.ico'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ refresh */

describe('a refresh may not destroy a page-sourced icon (§10.1)', () => {
  it('keeps it when Chrome has never seen the host', async () => {
    // The regression this phase was written around. `_favicon/` answers with the globe for a
    // vault-only site for ever, so the old rule — "write down what Chrome holds, including that it
    // holds nothing" — would delete a perfectly good icon every single time it ran.
    await addLikeTheProductDoes();
    expect((await loadIcon(deps(), 'vault-only.example'))?.source).toBe('page');

    // Somewhere else entirely, so the page cannot be consulted and only Chrome can answer.
    openPage({ url: 'https://elsewhere.example/', favIconUrl: undefined });

    const response = await refreshIcon(repo, PAGE);

    expect(response.image).not.toBeNull();
    expect(await loadIcon(deps(), 'vault-only.example')).toMatchObject({ source: 'page' });
  });

  it('still clears a chrome-sourced icon Chrome has forgotten', async () => {
    // Unchanged behaviour, and the case the original rule was written for.
    cache.set(PAGE, CHROME_ICON);
    await addLikeTheProductDoes();
    expect((await loadIcon(deps(), 'vault-only.example'))?.source).toBe('chrome');

    cache.delete(PAGE);
    openPage({ url: 'https://elsewhere.example/', favIconUrl: undefined });

    const response = await refreshIcon(repo, PAGE);

    expect(response.image).toBeNull();
    expect(await listIconNames()).toEqual([]);
  });

  it('prefers the page when the user is looking at it', async () => {
    // The page is the authority on its own icon; `_favicon/` is a cache of what some earlier visit
    // happened to see.
    cache.set(PAGE, CHROME_ICON);
    await addLikeTheProductDoes();

    openPage({ favIconUrl: FAVICON });
    await refreshIcon(repo, PAGE);

    expect(await loadIcon(deps(), 'vault-only.example')).toMatchObject({ source: 'page' });
  });

  it('does not consult a page that is not this bookmark', async () => {
    // A refresh from the manager runs with the manager in front. Capturing there would put one
    // site's icon on another site's rows — and an icon is keyed by host, so on all of them.
    openPage({ url: 'https://elsewhere.example/', favIconUrl: 'https://elsewhere.example/f.ico' });
    await addBookmark();

    await refreshIcon(repo, PAGE);

    expect(mock.injections).toEqual([]);
  });
});

/* ------------------------------------------------------------ one visit, both halves */

/**
 * The popup's *Refresh preview and icon*, which is one button because it is one injection.
 *
 * There were two buttons and two messages here until the day this was written, and the second one's
 * whole answer — on the site it existed for — was a paragraph telling the user to press the first
 * one. Both halves now ride the same script into the same page on the same visit, and the answer
 * says what became of each.
 */
describe('the explicit refresh takes the preview and the icon together', () => {
  it('stores what the page declares, even over an icon Chrome supplied', async () => {
    cache.set(PAGE, CHROME_ICON);
    const { id } = await addLikeTheProductDoes();
    expect((await loadIcon(deps(), 'vault-only.example'))?.source).toBe('chrome');

    const response = await refresh(repo, id);

    expect(response.icon).toBe('stored');
    expect(await loadIcon(deps(), 'vault-only.example')).toMatchObject({ source: 'page' });
  });

  it('reaches the page once, for both halves', async () => {
    const { id } = await addLikeTheProductDoes();
    mock.injections.length = 0;

    await refresh(repo, id);

    // One file injection and one reader, carrying both halves — not one pair per half.
    expect(mock.injections).toHaveLength(2);
    expect(captureRequest()).toMatchObject({ icon: true });
    expect(captureRequest()?.image).toBeUndefined();
  });

  it('touches nothing stored when the page offers nothing usable', async () => {
    cache.set(PAGE, CHROME_ICON);
    const { id } = await addLikeTheProductDoes();
    pageOffersNoIcon();

    const response = await refresh(repo, id);

    expect(response.icon).toBe('none');
    expect((await loadIcon(deps(), 'vault-only.example'))?.source).toBe('chrome');
  });

  it('refuses to run against a tab that is not this bookmark', async () => {
    const id = await addBookmark();
    openPage({ url: 'https://elsewhere.example/', favIconUrl: 'https://elsewhere.example/f.ico' });

    const response = await refresh(repo, id);

    expect(response.icon).toBeUndefined();
    expect(mock.injections).toEqual([]);
  });

  it('answers something the UI can actually read', async () => {
    /*
     * The silent-failure mode this repository has been bitten by: a response type missing from
     * `RESPONSE_TYPES` turns into ERROR/UNKNOWN in `parseResponse`, and every screen says
     * "Something went wrong." while the worker answers perfectly. This answers with a `THUMB`,
     * which is already in the set, and now carries an extra field — this is what keeps that true.
     */
    const id = await addBookmark();
    expect(parseResponse(await refresh(repo, id))).not.toBeNull();
  });

  it('says the icon is unavailable on the Chrome tier, and injects nothing', async () => {
    provider = chromeTier();
    configureSync({ repository: () => Promise.resolve(repo), provider: () => provider });
    const id = await addBookmark();

    expect(await refresh(repo, id)).toMatchObject({ icon: 'unavailable' });
    expect(mock.injections).toEqual([]);
  });
});
