/**
 * Opening a vaulted link (ARCHITECTURE §9).
 *
 * The assertion that carries the product is the negative one: with "Allow in Incognito" off, and
 * without the user explicitly choosing the fallback, **no window opens at all**. A regression there
 * would not fail loudly — it would quietly start putting vaulted URLs into the user's history,
 * which is the one thing this extension exists to prevent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HISTORY_QUEUE_KEY,
  extensionSettingsUrl,
  forgetIncognitoAccess,
  isAllowedIncognitoAccess,
  openVaulted,
  queueHistoryCleanup,
  readHistoryQueue,
} from '../../../src/background/incognito.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

const URL = 'https://example.com/private';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
  forgetIncognitoAccess();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('openVaulted, with incognito access', () => {
  beforeEach(() => {
    mock.incognitoAccess = true;
  });

  it('opens an incognito window', async () => {
    expect(await openVaulted(URL)).toBe('incognito');
    expect(mock.createdWindows).toEqual([{ incognito: true, url: URL, focused: true }]);
  });

  it('reuses an open incognito window when the setting is on', async () => {
    mock.openWindows.push({ id: 7, incognito: true, type: 'normal' });

    expect(await openVaulted(URL, { reuseWindow: true })).toBe('incognito');
    expect(mock.createdWindows).toEqual([]);
    expect(mock.createdTabs).toEqual([{ windowId: 7, url: URL, active: true }]);
  });

  it('opens a window when reuse is on but there is no incognito window to reuse', async () => {
    mock.openWindows.push({ id: 7, incognito: false, type: 'normal' });

    expect(await openVaulted(URL, { reuseWindow: true })).toBe('incognito');
    expect(mock.createdWindows).toEqual([{ incognito: true, url: URL, focused: true }]);
    expect(mock.createdTabs).toEqual([]);
  });

  it('opens a window of its own when reuse is off, even with one already open', async () => {
    mock.openWindows.push({ id: 7, incognito: true, type: 'normal' });

    expect(await openVaulted(URL, { reuseWindow: false })).toBe('incognito');
    expect(mock.createdWindows).toHaveLength(1);
    expect(mock.createdTabs).toEqual([]);
  });

  it('survives the reused window vanishing between the lookup and the focus call', async () => {
    mock.openWindows.push({ id: 7, incognito: true, type: 'normal' });
    vi.spyOn(mock.chrome.windows, 'update').mockRejectedValue(new Error('No window with id 7'));

    expect(await openVaulted(URL, { reuseWindow: true })).toBe('incognito');
    expect(mock.createdTabs).toHaveLength(1);
  });
});

describe('openVaulted, without incognito access', () => {
  it('opens nothing and asks for the guided prompt', async () => {
    expect(await openVaulted(URL)).toBe('needs-incognito-access');
    expect(mock.createdWindows).toEqual([]);
    expect(mock.createdTabs).toEqual([]);
  });

  it('opens a normal window only when the caller passes force', async () => {
    expect(await openVaulted(URL, { force: true })).toBe('normal');
    expect(mock.createdWindows).toEqual([{ url: URL, focused: true }]);
    expect(mock.createdWindows[0]?.incognito).toBe(undefined);
  });

  it('does not fall back just because reuse is on', async () => {
    mock.openWindows.push({ id: 7, incognito: false, type: 'normal' });
    expect(await openVaulted(URL, { reuseWindow: true })).toBe('needs-incognito-access');
    expect(mock.createdTabs).toEqual([]);
  });
});

describe('isAllowedIncognitoAccess', () => {
  it('caches the answer for the worker\'s lifetime', async () => {
    const probe = vi.spyOn(mock.chrome.extension, 'isAllowedIncognitoAccess');

    expect(await isAllowedIncognitoAccess()).toBe(false);
    expect(await isAllowedIncognitoAccess()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-reads on an explicit re-check — the Re-check button\'s path', async () => {
    expect(await isAllowedIncognitoAccess()).toBe(false);
    mock.incognitoAccess = true;

    expect(await isAllowedIncognitoAccess()).toBe(false);
    expect(await isAllowedIncognitoAccess(true)).toBe(true);
    // The re-check replaces the cached answer rather than bypassing it once.
    expect(await isAllowedIncognitoAccess()).toBe(true);
  });

  it('forgets the answer on request, so a lock does not hand it to the next session', async () => {
    expect(await isAllowedIncognitoAccess()).toBe(false);
    mock.incognitoAccess = true;
    forgetIncognitoAccess();
    expect(await isAllowedIncognitoAccess()).toBe(true);
  });
});

describe('extensionSettingsUrl', () => {
  it('names this extension, and is never something we could navigate to ourselves', () => {
    expect(extensionSettingsUrl()).toBe(`chrome://extensions/?id=${mock.chrome.runtime.id}`);
  });
});

describe('the history-cleanup queue', () => {
  it('lives in storage.session, never in storage.local (INV-6)', async () => {
    await queueHistoryCleanup('https://private.example/page?a=1');

    expect(await readHistoryQueue()).toEqual(['private.example']);
    expect(mock.storage.session.snapshot()[HISTORY_QUEUE_KEY]).toEqual(['private.example']);
    expect(JSON.stringify(mock.storage.local.snapshot())).not.toContain('private.example');
  });

  it('collapses duplicates', async () => {
    await queueHistoryCleanup('https://a.example/one');
    await queueHistoryCleanup('https://a.example/two');
    await queueHistoryCleanup('https://b.example/');
    expect(await readHistoryQueue()).toEqual(['a.example', 'b.example']);
  });

  it('ignores a URL with no host to clean up', async () => {
    await queueHistoryCleanup('not a url');
    expect(await readHistoryQueue()).toEqual([]);
  });

  it('reads a corrupted queue as an empty one', async () => {
    await mock.chrome.storage.session.set({ [HISTORY_QUEUE_KEY]: { nonsense: true } });
    expect(await readHistoryQueue()).toEqual([]);

    await mock.chrome.storage.session.set({ [HISTORY_QUEUE_KEY]: ['ok.example', 42] });
    expect(await readHistoryQueue()).toEqual(['ok.example']);
  });
});
