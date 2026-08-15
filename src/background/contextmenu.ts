/**
 * The right-click entries — two of the four add entry points (D25).
 *
 * "Add to VaultaMark" on a page or a selection vaults the page you are looking at; "Add link to
 * VaultaMark" vaults the link you right-clicked without opening it. Both are user gestures on the
 * active tab, which is what grants `activeTab` and is why neither needs a host permission.
 *
 * Menus are **recreated from scratch** on every install and browser start. `contextMenus.create`
 * fails with "duplicate id" rather than replacing, and an MV3 worker restarts constantly, so
 * `removeAll()` first is the only shape that is safe to run twice.
 *
 * Handlers are injected, as in `commands.ts`: this module has no idea what a vault is, and a test
 * can assert what a click dispatches to without unlocking one.
 */

import { msg } from '../ui/dom.js';

export const MENU_IDS = {
  /** Right-click on a page, or on a text selection. Vaults the page. */
  addPage: 'vm.add-page',
  /** Right-click on a link. Vaults the link's target. */
  addLink: 'vm.add-link',
} as const;

export interface ContextMenuDeps {
  readonly addActiveTab: () => Promise<unknown>;
  readonly addUrl: (url: string, title?: string) => Promise<unknown>;
}

/**
 * (Re)create the entries. Safe to call on every worker start.
 *
 * `documentUrlPatterns` is deliberately absent: the entries appear everywhere, including on the
 * pages we refuse to vault, and the refusal explains itself when clicked. Hiding the entry on a
 * `chrome://` page would be tidier and would also make the extension look broken exactly where a
 * new user first tries it.
 */
export async function installContextMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_IDS.addPage,
    title: msg('menuAddPage'),
    contexts: ['page', 'selection'],
  });
  chrome.contextMenus.create({
    id: MENU_IDS.addLink,
    title: msg('menuAddLink'),
    contexts: ['link'],
  });
}

/** Dispatch one click. Unknown ids are ignored — a menu from a previous version can still fire. */
export async function handleMenuClick(
  info: chrome.contextMenus.OnClickData,
  deps: ContextMenuDeps,
): Promise<void> {
  if (info.menuItemId === MENU_IDS.addLink) {
    const url = info.linkUrl;
    if (url === undefined || url === '') return;
    // `selectionText` is the link's own text when the user right-clicked a link inside a selection;
    // it is the closest thing to a title Chrome gives us here, and the page never sees it.
    await deps.addUrl(url, info.selectionText);
    return;
  }
  if (info.menuItemId === MENU_IDS.addPage) await deps.addActiveTab();
}

/**
 * Register the click listener.
 *
 * Called synchronously from the service-worker entry: a context-menu click is one of the events
 * that wakes a dead worker, and MV3 only delivers it to listeners registered during the initial
 * evaluation.
 */
export function registerContextMenuListener(deps: ContextMenuDeps): void {
  chrome.contextMenus.onClicked.addListener((info) => {
    void handleMenuClick(info, deps);
  });
}
