/**
 * Where the toolbar icons live in the package, and what each one is called (PLAN §9 Phase 14).
 *
 * Here rather than in `background/` because two layers need it and they are on opposite sides of
 * the diagram: the service worker applies the choice with `chrome.action.setIcon`, and the
 * manager's settings screen has to *show* the four pictures before anyone can choose one. `shared/`
 * is the layer both may import.
 *
 * The ids themselves are in `vault/types.ts`, because `VaultSettings` needs the union — the same
 * split, for the same reason, as `SORT_KEYS` and `sort.ts`.
 */

import { type ToolbarIconId } from '../vault/types.js';

/**
 * The sizes `manifest.json` declares, and therefore the sizes every alternative must exist at.
 *
 * `chrome.action.setIcon` picks from what it is handed and scales if it has to. Handing it 16 and
 * 32 alone would work on this year's displays and blur on a 4× one, which is not a thing anybody
 * would think to test.
 */
export const ICON_SIZES = [16, 32, 48, 128] as const;

/**
 * The file-name stem for each icon.
 *
 * `default` is `icon`, because those four files are the ones the manifest already points at and
 * renaming them would change what an unconfigured install loads.
 */
const STEMS: Record<ToolbarIconId, string> = {
  default: 'icon',
  ribbon: 'ribbon',
  folder: 'folder',
  page: 'page',
};

/** The `_locales` key naming each icon in the settings screen. */
export const TOOLBAR_ICON_LABEL_KEYS: Record<ToolbarIconId, string> = {
  default: 'toolbarIconDefault',
  ribbon: 'toolbarIconRibbon',
  folder: 'toolbarIconFolder',
  page: 'toolbarIconPage',
};

/**
 * Package-relative paths for one icon, in the shape `chrome.action.setIcon` wants.
 *
 * Relative, not `chrome.runtime.getURL`: `setIcon` resolves against the extension root itself, and
 * the manager — the one caller that needs an absolute URL, to put the picture in an `<img>` — asks
 * for it there rather than making every caller carry one it does not want.
 */
export function toolbarIconPaths(id: ToolbarIconId): Record<number, string> {
  const stem = STEMS[id];
  return Object.fromEntries(ICON_SIZES.map((size) => [size, `icons/${stem}${size}.png`]));
}
