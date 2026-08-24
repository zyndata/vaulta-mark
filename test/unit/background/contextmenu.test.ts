/**
 * The right-click entry points.
 *
 * Two things are easy to get wrong here and expensive to discover in the field: `contextMenus.create`
 * throws on a duplicate id rather than replacing, so a service worker that restarts twice would
 * break its own menus; and a menu id from a previous version can still be delivered after an update,
 * so an unknown id has to be ignored rather than dispatched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MENU_IDS,
  handleMenuClick,
  installContextMenus,
  registerContextMenuListener,
  type ContextMenuDeps,
} from '../../../src/background/contextmenu.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

let mock: ChromeMock;

function deps(): ContextMenuDeps {
  return {
    addActiveTab: vi.fn(() => Promise.resolve()),
    addUrl: vi.fn(() => Promise.resolve()),
  };
}

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('installContextMenus', () => {
  it('creates one entry for the page and one for a link', async () => {
    await installContextMenus();

    expect([...mock.menus.keys()].sort()).toEqual([MENU_IDS.addLink, MENU_IDS.addPage].sort());
    expect(mock.menus.get(MENU_IDS.addPage)?.contexts).toEqual(['page', 'selection']);
    expect(mock.menus.get(MENU_IDS.addLink)?.contexts).toEqual(['link']);
  });

  it('is safe to run twice — the worker restarts constantly', async () => {
    await installContextMenus();
    await expect(installContextMenus()).resolves.toBeUndefined();
    expect(mock.menus.size).toBe(2);
  });

  it('is safe to run twice at once — `onInstalled` and `onStartup` both fire on a browser start', async () => {
    // Unqueued, these interleave as remove, remove, create, create, create: the second `removeAll`
    // is already in flight when the first run's items appear, so it clears nothing and its own
    // creates land on top of them. That is
    // `Unchecked runtime.lastError: Cannot create item with duplicate id vm.add-page`.
    await expect(
      Promise.all([installContextMenus(), installContextMenus(), installContextMenus()]),
    ).resolves.toEqual([undefined, undefined, undefined]);
    expect([...mock.menus.keys()].sort()).toEqual([MENU_IDS.addLink, MENU_IDS.addPage].sort());
  });

  it('keeps queueing after a rebuild that failed', async () => {
    const removeAll = vi
      .spyOn(chrome.contextMenus, 'removeAll')
      .mockRejectedValueOnce(new Error('no'));
    const first = installContextMenus();
    const second = installContextMenus();
    await expect(first).rejects.toThrow('no');
    await expect(second).resolves.toBeUndefined();
    expect(mock.menus.size).toBe(2);
    removeAll.mockRestore();
  });
});

describe('handleMenuClick', () => {
  it('vaults the active tab from the page entry', async () => {
    const d = deps();
    await handleMenuClick({ menuItemId: MENU_IDS.addPage } as chrome.contextMenus.OnClickData, d);
    expect(d.addActiveTab).toHaveBeenCalledTimes(1);
    expect(d.addUrl).not.toHaveBeenCalled();
  });

  it('vaults the link target from the link entry, without opening it', async () => {
    const d = deps();
    await handleMenuClick(
      {
        menuItemId: MENU_IDS.addLink,
        linkUrl: 'https://example.com/target',
        selectionText: 'the link text',
      } as chrome.contextMenus.OnClickData,
      d,
    );

    expect(d.addUrl).toHaveBeenCalledWith('https://example.com/target', 'the link text');
    expect(mock.createdTabs).toEqual([]);
    expect(mock.createdWindows).toEqual([]);
  });

  it('does nothing for a link click that carries no URL', async () => {
    const d = deps();
    await handleMenuClick({ menuItemId: MENU_IDS.addLink } as chrome.contextMenus.OnClickData, d);
    expect(d.addUrl).not.toHaveBeenCalled();
  });

  it('ignores an id from a previous version of the extension', async () => {
    const d = deps();
    await handleMenuClick({ menuItemId: 'vm.something-old' } as chrome.contextMenus.OnClickData, d);
    expect(d.addActiveTab).not.toHaveBeenCalled();
    expect(d.addUrl).not.toHaveBeenCalled();
  });
});

describe('registerContextMenuListener', () => {
  it('dispatches a click', async () => {
    const d = deps();
    registerContextMenuListener(d);
    mock.triggerMenuClick({ menuItemId: MENU_IDS.addPage });
    await vi.waitFor(() => {
      expect(d.addActiveTab).toHaveBeenCalledTimes(1);
    });
  });
});
