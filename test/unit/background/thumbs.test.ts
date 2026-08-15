/**
 * Capture where it meets the vault (PLAN §9 Phase 11), driven through the real router.
 *
 * The claim this file exists to hold down is the tier gate: **with `ChromeSyncProvider` and the
 * opt-in off, nothing is injected at all.** Asserting only that no thumbnail was stored would pass
 * against a build that injected into every page the user vaults and then threw the answer away —
 * which is a different product, and a worse one. So the assertion is on
 * `chrome.scripting.executeScript` itself.
 *
 * `createImageBitmap` and `OffscreenCanvas` do not exist in Node, so a minimal stand-in for both is
 * installed here. That keeps `thumbs/process.ts` real — the ladder, the never-upscale rule and the
 * byte cap all run — while the two platform calls answer with fixed sizes. The genuine article, on
 * genuine photographs, is `test/e2e/thumbs.spec.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';
import { toBase64Url } from '../../../src/crypto/codec.js';
import { LOCAL_KEYS } from '../../../src/storage/local.js';
import { CAPTURE_FILE } from '../../../src/background/thumbs.js';

const PASSWORD = 'a reasonably long master password';
const PAGE = 'https://example.com/articles/one';

let mock: ChromeMock;

async function startWorker(): Promise<void> {
  mock.terminateWorker();
  vi.resetModules();
  await import('../../../src/background/index.js');
}

async function send(message: unknown): Promise<Record<string, unknown>> {
  return (await mock.sendMessage(message)) as Record<string, unknown>;
}

/** The active tab, as `activeTab` makes it readable. */
function openPage(url = PAGE): void {
  mock.openTabs.length = 0;
  mock.openTabs.push({ id: 7, url, title: 'One', active: true });
}

/** A `CaptureResult`, as the page hands one back through `executeScript`. */
function captured(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ogTitle: 'An article',
    ogDescription: 'About something',
    imageUrl: 'https://cdn.example.com/card.png',
    src: 'og',
    contentType: 'image/png',
    image: toBase64Url(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])),
    ...overrides,
  };
}

/** Every row in the manager's view, by id. */
async function rows(): Promise<Record<string, Record<string, unknown>>> {
  const view = await send({ type: 'LIST_VIEW' });
  const out: Record<string, Record<string, unknown>> = {};
  for (const row of view['items'] as Record<string, unknown>[]) out[row['id'] as string] = row;
  return out;
}

/** The one bookmark in the vault. */
async function onlyRow(): Promise<Record<string, unknown>> {
  const all = Object.values(await rows());
  expect(all).toHaveLength(1);
  return all[0]!;
}

/**
 * Whether a *picture* was stored for the only item, asked of the worker rather than of the row.
 *
 * The row's `hasPreview` stopped answering this question when the card grew text: a page whose
 * image was refused still publishes `og:title`, so the row correctly offers a card and the picture
 * is still absent. These are two different facts and the refusal tests are about the second.
 */
async function storedPicture(): Promise<boolean> {
  const id = (await onlyRow())['id'] as string;
  const thumb = await send({ type: 'GET_THUMB', id });
  return thumb['state'] === 'ready' && thumb['image'] !== null;
}

/* ------------------------------------------------------------------ the platform stand-in */

interface StubbedGlobals {
  createImageBitmap?: unknown;
  OffscreenCanvas?: unknown;
}

/** What the fake decoder reports, so a test can drive the never-upscale and bomb paths. */
let bitmapSize = { width: 1200, height: 630 };
/** How many bytes the fake encoder produces, so a test can drive the byte cap. */
let encodedBytes = 3_000;

beforeAll(() => {
  const globals = globalThis as StubbedGlobals;
  globals.createImageBitmap = () =>
    Promise.resolve({ ...bitmapSize, close: () => undefined });
  globals.OffscreenCanvas = class {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext(): { drawImage: () => void } {
      return { drawImage: () => undefined };
    }
    convertToBlob(options: { type: string }): Promise<Blob> {
      return Promise.resolve(new Blob([new Uint8Array(encodedBytes)], { type: options.type }));
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
  bitmapSize = { width: 1200, height: 630 };
  encodedBytes = 3_000;
  uninstallChromeMock();
  mock = installChromeMock();
  await startWorker();
  await send({ type: 'CREATE_VAULT', password: PASSWORD });
  openPage();
});

afterEach(() => {
  uninstallChromeMock();
});

/* ------------------------------------------------------------------ the tier gate */

describe('tier gating (ARCHITECTURE §14.4)', () => {
  it('injects nothing on the Chrome tier with the opt-in off', async () => {
    mock.captureResult = captured();
    const response = await send({ type: 'ADD_ACTIVE_TAB' });

    expect(response['status']).toBe('added');
    expect(mock.injections).toEqual([]);
    expect((await onlyRow())['hasPreview']).toBe(false);
  });

  it('offers the opt-in on the first add, and only then', async () => {
    const first = await send({ type: 'ADD_ACTIVE_TAB' });
    expect(first['offerThumbnails']).toBe(true);

    await send({ type: 'SET_SETTINGS', settings: { thumbnailsOffered: true } });
    openPage('https://example.com/articles/two');
    const second = await send({ type: 'ADD_ACTIVE_TAB' });
    expect(second['offerThumbnails']).toBeUndefined();
  });

  it('does not offer when the answer was already yes', async () => {
    await send({
      type: 'SET_SETTINGS',
      settings: { thumbnailsOffered: true, localThumbnails: true },
    });
    const response = await send({ type: 'ADD_ACTIVE_TAB' });
    expect(response['offerThumbnails']).toBeUndefined();
  });

  it('never offers on an add that had no window to ask in', async () => {
    // The context menu and the keyboard shortcut report on the badge, which cannot carry a question.
    const response = await send({ type: 'ADD_URL', url: 'https://example.com/three' });
    expect(response['offerThumbnails']).toBeUndefined();
    expect(mock.injections).toEqual([]);
  });

  it('captures once the opt-in is on', async () => {
    await send({ type: 'SET_SETTINGS', settings: { localThumbnails: true } });
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });

    expect(mock.injections).toEqual([
      { tabId: 7, files: [CAPTURE_FILE], hasFunc: false },
      { tabId: 7, hasFunc: true },
    ]);
    expect((await onlyRow())['hasPreview']).toBe(true);
  });
});

/* ------------------------------------------------------------------ the pipeline */

describe('capturing', () => {
  beforeEach(async () => {
    await send({ type: 'SET_SETTINGS', settings: { localThumbnails: true } });
  });

  it('stores the picture encrypted, under the item id', async () => {
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;

    const stored = await chrome.storage.local.get(`${LOCAL_KEYS.thumbPrefix}${id}`);
    const value = stored[`${LOCAL_KEYS.thumbPrefix}${id}`];
    expect(typeof value).toBe('string');
    // The envelope's version byte in base64url; a stored PNG would begin `iVBOR`.
    expect(value as string).not.toMatch(/^iVBOR/u);
  });

  it('records the dimensions the processor produced, not the ones the page had', async () => {
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;

    const thumb = await send({ type: 'GET_THUMB', id });
    expect(thumb).toMatchObject({ type: 'THUMB', state: 'ready' });
    // 1200 × 630 fitted into a 320 px box.
    expect(thumb['width']).toBe(320);
    expect(thumb['height']).toBe(168);
    expect(typeof thumb['image']).toBe('string');
  });

  it('keeps the card’s text even when there is no picture, and offers it', async () => {
    /*
     * The case the text was captured for, and the one this test used to assert the *opposite* of:
     * `og` was stored and nothing read it, so the row reported no preview and the words were
     * unreachable. Most of the web has no `og:image`; a great deal of it has a title and a summary.
     */
    mock.captureResult = captured({ image: undefined, imageUrl: undefined, reason: 'no-image' });
    await send({ type: 'ADD_ACTIVE_TAB' });

    const row = await onlyRow();
    expect(row['hasPreview']).toBe(true);
    expect(await storedPicture()).toBe(false);

    const thumb = await send({ type: 'GET_THUMB', id: row['id'] as string });
    expect(thumb).toMatchObject({
      state: 'none',
      image: null,
      ogTitle: 'An article',
      ogDescription: 'About something',
    });
  });

  it('refuses a picture on a private address, and stores nothing', async () => {
    mock.captureResult = captured({ imageUrl: 'https://169.254.169.254/latest/meta-data' });
    await send({ type: 'ADD_ACTIVE_TAB' });
    expect(await storedPicture()).toBe(false);
  });

  it('refuses an SVG', async () => {
    mock.captureResult = captured({ contentType: 'image/svg+xml' });
    await send({ type: 'ADD_ACTIVE_TAB' });
    expect(await storedPicture()).toBe(false);
  });

  it('refuses a decompression bomb', async () => {
    bitmapSize = { width: 20_000, height: 20_000 };
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    expect(await storedPicture()).toBe(false);
  });

  it('gives up rather than storing something past the byte cap', async () => {
    encodedBytes = 500_000;
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    expect(await storedPicture()).toBe(false);
  });

  it('survives a page that will not let us inject at all', async () => {
    mock.injectionFails = true;
    const response = await send({ type: 'ADD_ACTIVE_TAB' });
    expect(response['status']).toBe('added');
    // Nothing was read from the page at all, so there is no picture *and* no words — the one case
    // where the row genuinely has no card to offer.
    expect((await onlyRow())['hasPreview']).toBe(false);
  });

  it('survives a page whose hook answered with nonsense', async () => {
    mock.captureResult = 42;
    const response = await send({ type: 'ADD_ACTIVE_TAB' });
    expect(response['status']).toBe('added');
    expect((await onlyRow())['hasPreview']).toBe(false);
  });

  it('does not re-capture when the same page is added again', async () => {
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    mock.injections.length = 0;

    const again = await send({ type: 'ADD_ACTIVE_TAB' });
    expect(again['status']).toBe('duplicate');
    expect(mock.injections).toEqual([]);
  });
});

/* ------------------------------------------------------------------ reading and refreshing */

describe('reading a preview', () => {
  it('answers `none` for an item that never had one', async () => {
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;
    expect(await send({ type: 'GET_THUMB', id })).toMatchObject({
      type: 'THUMB',
      state: 'none',
      image: null,
    });
  });

  it('answers `remote` when the item claims one and the bytes are gone', async () => {
    await send({ type: 'SET_SETTINGS', settings: { localThumbnails: true } });
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;

    // Evicted, or authored on a machine this one cannot reach.
    await chrome.storage.local.remove(`${LOCAL_KEYS.thumbPrefix}${id}`);
    const thumb = await send({ type: 'GET_THUMB', id });
    expect(thumb).toMatchObject({ state: 'remote', image: null });
    // The shape survives, so the row reserves the right box and does not jump.
    expect(thumb['width']).toBe(320);
  });

  it('refuses to read a preview while the vault is locked', async () => {
    await send({ type: 'SET_SETTINGS', settings: { localThumbnails: true } });
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;

    await send({ type: 'LOCK' });
    expect(await send({ type: 'GET_THUMB', id })).toEqual({
      type: 'ERROR',
      code: 'VAULT_LOCKED',
    });
  });
});

describe('refreshing a preview', () => {
  beforeEach(async () => {
    await send({ type: 'SET_SETTINGS', settings: { localThumbnails: true } });
  });

  it('re-captures when the active tab is the item’s own page', async () => {
    mock.captureResult = captured({ image: undefined, imageUrl: undefined, reason: 'no-image' });
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;
    // No picture to begin with — the row already offers a card, because the words arrived.
    expect(await storedPicture()).toBe(false);
    expect((await onlyRow())['hasPreview']).toBe(true);

    mock.captureResult = captured();
    const refreshed = await send({ type: 'REFRESH_THUMB', id });
    expect(refreshed).toMatchObject({ type: 'THUMB', state: 'ready' });
    expect(await storedPicture()).toBe(true);
  });

  it('refuses to capture from whatever page happens to be in front', async () => {
    mock.captureResult = captured({ image: undefined, imageUrl: undefined, reason: 'no-image' });
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;

    openPage('https://somewhere-else.example/');
    mock.injections.length = 0;
    mock.captureResult = captured();

    const refreshed = await send({ type: 'REFRESH_THUMB', id });
    expect(refreshed).toMatchObject({ state: 'none' });
    expect(mock.injections).toEqual([]);
  });

  it('ignores a fragment when it compares the two addresses', async () => {
    mock.captureResult = captured({ image: undefined, imageUrl: undefined, reason: 'no-image' });
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;

    openPage(`${PAGE}#section-3`);
    mock.captureResult = captured();
    expect(await send({ type: 'REFRESH_THUMB', id })).toMatchObject({ state: 'ready' });
  });

  /*
   * A refresh replaces. Reported as "Refresh preview does nothing": the page behind the bookmark
   * had changed, the new one published no card, and the old card stayed on screen underneath a
   * notice saying the page offered no picture — which reads as the button being broken.
   */
  it('clears a picture the page no longer offers', async () => {
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;
    expect(await storedPicture()).toBe(true);

    mock.captureResult = captured({ image: undefined, imageUrl: undefined, reason: 'no-image' });
    expect(await send({ type: 'REFRESH_THUMB', id })).toMatchObject({
      state: 'none',
      image: null,
    });
    // The bytes go with the record, or the cache keeps a picture nothing can still ask for.
    expect(await chrome.storage.local.get(`${LOCAL_KEYS.thumbPrefix}${id}`)).toEqual({});
  });

  it('clears the words when the page has stopped publishing them', async () => {
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;

    mock.captureResult = captured({
      ogTitle: undefined,
      ogDescription: undefined,
      image: undefined,
      imageUrl: undefined,
      reason: 'no-image',
    });
    expect(await send({ type: 'REFRESH_THUMB', id })).toMatchObject({
      state: 'none',
      ogTitle: null,
      ogDescription: null,
    });
    // Nothing is left to expand, so the row stops offering an eye.
    expect((await onlyRow())['hasPreview']).toBe(false);
  });

  it('keeps the preview when the injection never ran', async () => {
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;

    // A restricted page, or an `activeTab` grant that was not there. Nothing was read, so nothing
    // is known — and a refresh that could not look must not throw away what it could not check.
    mock.injectionFails = true;
    expect(await send({ type: 'REFRESH_THUMB', id })).toMatchObject({ state: 'ready' });
    expect(await storedPicture()).toBe(true);
  });
});

/* ------------------------------------------------------------------ what the popup is looking at */

/*
 * The popup offers *Refresh preview* on open rather than only after an add reports a duplicate.
 * Reported twice as "refresh preview does nothing": the manager opens the page and can do no more
 * (§14.5), and the instruction it left behind began with "press Add this page" — which is not what
 * anyone reads when they are trying to refresh something.
 */
describe('recognising the page in front of the popup', () => {
  it('answers with the item when this page is already vaulted', async () => {
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;

    const looked = await send({ type: 'LOOKUP_ACTIVE_TAB' });
    expect(looked).toMatchObject({ type: 'ACTIVE_TAB' });
    expect((looked['item'] as Record<string, unknown>)['id']).toBe(id);
    // A lookup is a read: nothing is vaulted and nothing is injected by opening a popup.
    expect(Object.keys(await rows())).toHaveLength(1);
    expect(mock.injections).toEqual([]);
  });

  it('answers `null` for a page that is not vaulted, and for one that cannot be', async () => {
    await send({ type: 'ADD_ACTIVE_TAB' });
    mock.injections.length = 0;

    openPage('https://example.com/somewhere-else');
    expect(await send({ type: 'LOOKUP_ACTIVE_TAB' })).toMatchObject({ item: null });

    // A refusal is not an error here: opening the popup on the settings page asked nothing.
    openPage('chrome://settings/');
    expect(await send({ type: 'LOOKUP_ACTIVE_TAB' })).toMatchObject({ type: 'ACTIVE_TAB', item: null });

    mock.openTabs.length = 0;
    expect(await send({ type: 'LOOKUP_ACTIVE_TAB' })).toMatchObject({ type: 'ACTIVE_TAB', item: null });
    expect(mock.injections).toEqual([]);
  });

  it('refuses the lookup while the vault is locked', async () => {
    await send({ type: 'ADD_ACTIVE_TAB' });
    await send({ type: 'LOCK' });
    expect(await send({ type: 'LOOKUP_ACTIVE_TAB' })).toMatchObject({
      type: 'ERROR',
      code: 'VAULT_LOCKED',
    });
  });
});

/* ------------------------------------------------------------------ a bookmark that moves */

describe('editing the address', () => {
  beforeEach(async () => {
    await send({ type: 'SET_SETTINGS', settings: { localThumbnails: true } });
  });

  it('drops the preview that described the page that used to be there', async () => {
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;
    expect(await storedPicture()).toBe(true);

    await send({
      type: 'UPDATE_ITEM',
      id,
      patch: { title: 'One', url: 'https://example.com/articles/two' },
    });

    expect(await send({ type: 'GET_THUMB', id })).toMatchObject({
      state: 'none',
      image: null,
      ogTitle: null,
      ogDescription: null,
    });
    expect(await chrome.storage.local.get(`${LOCAL_KEYS.thumbPrefix}${id}`)).toEqual({});
    expect((await onlyRow())['hasPreview']).toBe(false);
  });

  it('keeps the preview when the address did not actually change', async () => {
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;

    // A retitle, saved through the same form, which sends the URL back unchanged.
    await send({ type: 'UPDATE_ITEM', id, patch: { title: 'Another title', url: PAGE } });
    expect(await storedPicture()).toBe(true);
  });
});

/* ------------------------------------------------------------------ housekeeping */

describe('housekeeping', () => {
  it('drops the thumbnails of items the vault no longer holds', async () => {
    // The 12-hour alarm is armed by `onInstalled`/`onStartup`, not by the first message.
    mock.triggerInstalled();
    await send({ type: 'SET_SETTINGS', settings: { localThumbnails: true } });
    mock.captureResult = captured();
    await send({ type: 'ADD_ACTIVE_TAB' });
    const id = (await onlyRow())['id'] as string;
    expect(await chrome.storage.local.get(`${LOCAL_KEYS.thumbPrefix}${id}`)).not.toEqual({});

    // A picture whose item was never in this vault at all — what a merge or a rollback leaves.
    await chrome.storage.local.set({ [`${LOCAL_KEYS.thumbPrefix}orphan`]: 'AgAAAA' });

    mock.triggerAlarm('vm.housekeeping');
    await vi.waitFor(async () => {
      expect(await chrome.storage.local.get(`${LOCAL_KEYS.thumbPrefix}orphan`)).toEqual({});
    });
    // The live item keeps its picture.
    expect(await chrome.storage.local.get(`${LOCAL_KEYS.thumbPrefix}${id}`)).not.toEqual({});
  });
});
