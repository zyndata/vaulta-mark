/**
 * When an icon may be captured, and — the claim that actually needs a test — when it may not
 * (PLAN §9 Phase 17, ARCHITECTURE §10.1).
 *
 * **Every assertion about "no fetch" is made against the fetch seam itself**, never against stored
 * state. A build that read `_favicon/` on every render and then threw the answer away would pass a
 * "nothing was stored" test and would be a different product: reading Chrome's favicon database for
 * rows nobody is looking at is exactly what D27/§14 forbids for thumbnails. So `fetch` is replaced
 * here and every call it receives is recorded.
 *
 * The Drive tier is reached by injecting a provider into the sync engine rather than by
 * authenticating one: what these paths care about is `capabilities.heavyTier`, which is a static
 * property of a backend and not something `init()` discovers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';
import { chromeTier, fakeDrive, type FakeProvider } from '../../helpers/provider.js';
import { fromBase64Url, type Bytes } from '../../../src/crypto/codec.js';
import { VaultRepository } from '../../../src/storage/repo.js';
import { LOCAL_KEYS, listIconNames } from '../../../src/storage/local.js';
import { configureSync, resetSync } from '../../../src/sync/engine.js';
import { DEFAULT_FAVICON_SIZE } from '../../../src/ui/favicon.js';
import {
  ICON_SIZE,
  captureOnAdd,
  iconFor,
  refreshIcon,
  resetIconState,
  sweepOrphans,
} from '../../../src/background/favicons.js';
import { parseResponse } from '../../../src/shared/messages.js';

const PASSWORD = 'a reasonably long master password';
const PAGE = 'https://github.com/zyndata/vaulta-mark';
const OTHER_PAGE = 'https://github.com/zyndata/other';

let repo: VaultRepository;

/** Every URL `fetch` was called with, in order. The seam the "no fetch" claims are made against. */
let fetched: string[] = [];
/** What `_favicon/` answers, by the `pageUrl` it is asked about. Anything absent gets the globe. */
let cache: Map<string, Bytes>;

/** Chrome's generic globe: what a never-visited site answers with, byte for byte (measured). */
const PLACEHOLDER = icon(646, 1);
const REAL_ICON = icon(646, 9);

function icon(bytes: number, seed: number): Bytes {
  const out = new Uint8Array(bytes);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < bytes; i++) out[i] = (i * seed) % 251;
  return out;
}

/** The `pageUrl` a recorded `_favicon/` call was about. */
function pageUrlsAsked(): string[] {
  return fetched
    .filter((url) => url.includes('/_favicon/'))
    .map((url) => new URL(url).searchParams.get('pageUrl') ?? '');
}

function installFetch(): void {
  vi.stubGlobal('fetch', (input: string) => {
    fetched.push(input);
    const pageUrl = new URL(input).searchParams.get('pageUrl') ?? '';
    const body = cache.get(pageUrl) ?? PLACEHOLDER;
    return Promise.resolve(new Response(new Uint8Array(body), { status: 200 }));
  });
}

async function addBookmark(url: string): Promise<string> {
  const [item] = await repo.apply([
    { kind: 'add', input: { type: 'bookmark', title: 'A page', url } },
  ]);
  await repo.flush();
  return item!.id;
}

function useProvider(provider: FakeProvider): void {
  configureSync({ repository: () => Promise.resolve(repo), provider: () => provider });
}

beforeEach(async () => {
  uninstallChromeMock();
  installChromeMock();
  cache = new Map();
  fetched = [];
  resetIconState();
  resetSync();
  installFetch();
  repo = new VaultRepository({ coalesceMs: 0 });
  await repo.create(PASSWORD);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSync();
  uninstallChromeMock();
});

describe('the size asked for', () => {
  it('is the size the rows ask for', () => {
    // A row asking Chrome for 32 while the store keeps 16 would put a blurred icon on every
    // restored device — the exact failure this feature exists to prevent, and invisible in review.
    expect(ICON_SIZE).toBe(DEFAULT_FAVICON_SIZE);
  });
});

describe('on add', () => {
  it('stores the icon Chrome has for the page', async () => {
    useProvider(fakeDrive());
    cache.set(PAGE, REAL_ICON);
    await addBookmark(PAGE);

    expect(await captureOnAdd(repo, PAGE)).toBe('stored');
    expect(await listIconNames()).toHaveLength(1);
    expect(pageUrlsAsked()).toContain(PAGE);
  });

  it('stores nothing when Chrome answers with its placeholder', async () => {
    useProvider(fakeDrive());
    await addBookmark(PAGE);

    expect(await captureOnAdd(repo, PAGE)).toBe('placeholder');
    expect(await listIconNames()).toEqual([]);
  });

  it('costs one stored icon for two bookmarks on the same host', async () => {
    const drive = fakeDrive();
    useProvider(drive);
    cache.set(PAGE, REAL_ICON);
    cache.set(OTHER_PAGE, REAL_ICON);

    expect(await captureOnAdd(repo, PAGE)).toBe('stored');
    // The second add finds one already held and does not even read the cache for it.
    const before = fetched.length;
    expect(await captureOnAdd(repo, OTHER_PAGE)).toBe('held');
    expect(fetched).toHaveLength(before);
    expect(await listIconNames()).toHaveLength(1);
    expect(drive.icons.size).toBe(1);
  });

  it('does not try for a URL that has no host', async () => {
    useProvider(fakeDrive());
    expect(await captureOnAdd(repo, 'not a url')).toBe('unusable');
    expect(fetched).toEqual([]);
  });
});

describe('the Chrome sync tier', () => {
  it('reads nothing, stores nothing, and says so once', async () => {
    useProvider(chromeTier());
    await addBookmark(PAGE);
    cache.set(PAGE, REAL_ICON);

    expect(await captureOnAdd(repo, PAGE)).toBe('off');
    const answer = await iconFor(repo, PAGE);
    const refreshed = await refreshIcon(repo, PAGE);

    expect(answer).toEqual({ type: 'ICON', url: PAGE, image: null, available: false });
    expect(refreshed.available).toBe(false);
    // Not one `_favicon/` read: on this tier the behaviour is what it was before Phase 17.
    expect(fetched).toEqual([]);
    expect(await listIconNames()).toEqual([]);
    expect(await chrome.storage.sync.get(null)).toEqual({});
  });
});

describe('answering a row', () => {
  it('sends nothing when Chrome already has the icon', async () => {
    useProvider(fakeDrive());
    cache.set(PAGE, REAL_ICON);

    const answer = await iconFor(repo, PAGE);

    expect(answer).toMatchObject({ type: 'ICON', image: null, available: true });
  });

  it('upgrades opportunistically: what Chrome now has is what the vault stores', async () => {
    const drive = fakeDrive();
    useProvider(drive);

    // Nothing yet: the profile has never visited the site.
    expect(await iconFor(repo, PAGE)).toMatchObject({ image: null });
    expect(await listIconNames()).toEqual([]);

    // The user visits it, so Chrome's cache now answers with the real thing.
    cache.set(PAGE, REAL_ICON);
    expect(await iconFor(repo, PAGE)).toMatchObject({ image: null });
    expect(await listIconNames()).toHaveLength(1);
    expect(drive.icons.size).toBe(1);
  });

  it('never overwrites a stored icon on an upgrade', async () => {
    const drive = fakeDrive();
    useProvider(drive);
    cache.set(PAGE, REAL_ICON);
    await captureOnAdd(repo, PAGE);
    const [name] = await listIconNames();
    const stored = drive.icons.get(name!);

    // Chrome's cache has evicted, re-fetched and re-scaled it. That is not evidence the site's icon
    // changed, and a refresh is the only thing allowed to replace one.
    cache.set(PAGE, icon(700, 21));
    await iconFor(repo, PAGE);

    expect(drive.icons.get(name!)).toEqual(stored);
  });

  it('sends the stored icon when Chrome has only the globe', async () => {
    const drive = fakeDrive();
    useProvider(drive);
    cache.set(PAGE, REAL_ICON);
    await captureOnAdd(repo, PAGE);

    // A second computer: the vault arrived from Drive, this profile has browsed nothing.
    cache.delete(PAGE);
    const answer = await iconFor(repo, PAGE);

    expect(answer.image).not.toBeNull();
    expect(fromBase64Url(answer.image!)).toEqual(REAL_ICON);
  });

  it('reaches the backend once for a host it does not have, and not again', async () => {
    const drive = fakeDrive();
    useProvider(drive);

    await iconFor(repo, PAGE);
    const reads = drive.reads.length;
    expect(reads).toBe(1);

    // A list re-rendering, and re-rendering, and re-rendering: one negative answer is enough.
    await iconFor(repo, PAGE);
    await iconFor(repo, OTHER_PAGE);
    expect(drive.reads).toHaveLength(reads);
  });

  it('answers a response the UI will accept', async () => {
    useProvider(fakeDrive());
    // `RESPONSE_TYPES` is a hand-maintained runtime copy of the response union, and a type missing
    // from it turns a perfect answer into "Something went wrong." in every screen.
    expect(parseResponse(await iconFor(repo, PAGE))).not.toBeNull();
  });
});

describe('refreshing', () => {
  it('writes down what Chrome holds now', async () => {
    const drive = fakeDrive();
    useProvider(drive);

    cache.set(PAGE, REAL_ICON);
    const answer = await refreshIcon(repo, PAGE);

    expect(answer.image).not.toBeNull();
    expect(drive.icons.size).toBe(1);
  });

  it('replaces, including replacing an icon with nothing', async () => {
    const drive = fakeDrive();
    useProvider(drive);
    cache.set(PAGE, REAL_ICON);
    await captureOnAdd(repo, PAGE);
    const [name] = await listIconNames();

    cache.delete(PAGE);
    const answer = await refreshIcon(repo, PAGE);

    expect(answer.image).toBeNull();
    expect(await listIconNames()).toEqual([]);
    expect(drive.deletedIcons).toEqual([name]);
  });

  it('replaces an icon that changed', async () => {
    const drive = fakeDrive();
    useProvider(drive);
    cache.set(PAGE, REAL_ICON);
    await captureOnAdd(repo, PAGE);
    const [name] = await listIconNames();
    const before = drive.icons.get(name!);

    cache.set(PAGE, icon(900, 31));
    await refreshIcon(repo, PAGE);

    expect(drive.icons.get(name!)).not.toEqual(before);
  });
});

describe('the sweep', () => {
  it('drops the icons of hosts the vault no longer holds', async () => {
    const drive = fakeDrive();
    useProvider(drive);
    cache.set(PAGE, REAL_ICON);
    const id = await addBookmark(PAGE);
    await captureOnAdd(repo, PAGE);
    const [name] = await listIconNames();

    // A tombstone is not enough: an item comes back from one, and the picture with it (§14.6).
    await repo.apply([{ kind: 'delete', id }]);
    await repo.flush();
    expect(await sweepOrphans(repo)).toEqual([]);

    await repo.purge(0);
    expect(await sweepOrphans(repo)).toEqual([name]);
    expect(await listIconNames()).toEqual([]);
  });

  it('keeps an icon while any bookmark still points at that host', async () => {
    useProvider(fakeDrive());
    cache.set(PAGE, REAL_ICON);
    const first = await addBookmark(PAGE);
    await addBookmark(OTHER_PAGE);
    await captureOnAdd(repo, PAGE);

    await repo.apply([{ kind: 'delete', id: first }]);
    await repo.purge(0);

    expect(await sweepOrphans(repo)).toEqual([]);
    expect(await listIconNames()).toHaveLength(1);
  });

  it('reads no favicon while sweeping', async () => {
    useProvider(fakeDrive());
    cache.set(PAGE, REAL_ICON);
    await addBookmark(PAGE);
    await captureOnAdd(repo, PAGE);
    fetched = [];

    await sweepOrphans(repo);

    // Housekeeping runs on an alarm. An alarm that read the favicon database would be the timer
    // §10.1 refuses, arriving by another name.
    expect(fetched).toEqual([]);
  });
});

describe('what is never read', () => {
  it('asks about a page only at the three moments, and about nothing else', async () => {
    useProvider(fakeDrive());
    cache.set(PAGE, REAL_ICON);
    await addBookmark(PAGE);
    await addBookmark(OTHER_PAGE);

    await captureOnAdd(repo, PAGE);
    await iconFor(repo, PAGE);
    await refreshIcon(repo, PAGE);
    await sweepOrphans(repo);
    await repo.purge(0);

    // One calibration (`about:blank`, once per worker) plus one read per moment. Nothing was asked
    // about OTHER_PAGE, which nobody looked at and nobody added while this was watching.
    const asked = pageUrlsAsked();
    expect(asked.filter((url) => url === 'about:blank')).toHaveLength(1);
    expect(asked.filter((url) => url === PAGE)).toHaveLength(3);
    expect(asked.filter((url) => url === OTHER_PAGE)).toHaveLength(0);
  });

  it('stores nothing in chrome.storage.sync, whatever happens', async () => {
    useProvider(fakeDrive());
    cache.set(PAGE, REAL_ICON);
    await addBookmark(PAGE);
    await captureOnAdd(repo, PAGE);
    await iconFor(repo, PAGE);
    await refreshIcon(repo, PAGE);

    expect(await chrome.storage.sync.get(null)).toEqual({});
    expect(Object.keys(await chrome.storage.local.get(null)).some((k) => k.startsWith(LOCAL_KEYS.iconPrefix))).toBe(true);
  });
});
