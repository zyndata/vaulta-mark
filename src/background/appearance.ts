/**
 * The toolbar button's picture and tooltip (PLAN §9 Phase 14, ARCHITECTURE §16).
 *
 * **This is appearance, not concealment**, and the distinction is the whole design. `manifest.name`
 * is fixed at build time and cannot be rewritten by anything at runtime, so `chrome://extensions`,
 * the extension id, `chrome://apps` and the Store listing all still say VaultaMark whatever is
 * chosen here. What a person can change is the picture on the button and the tooltip on it. Nothing
 * in this module, in the settings screen or in the docs may promise more than that — THREAT_MODEL §4
 * records both halves.
 *
 * **It is re-applied on every worker start, and that is not belt-and-braces.** Chrome keeps an
 * action's runtime icon for the browser session, but "the browser session" ends at a browser
 * restart, an extension reload and an update — three events after which a chosen icon would
 * silently revert to the manifest's, which is precisely the moment the user is least expecting the
 * mark back. Re-applying costs one `storage.local` read and one idempotent API call, and it makes
 * the property "the icon I chose is the icon I see" true rather than probable.
 */

import { toolbarIconPaths } from '../shared/appearance.js';
import { readSettings } from '../storage/local.js';
import { type VaultSettings } from '../vault/types.js';

/**
 * How long after the worker wakes the appearance is applied.
 *
 * Not zero, and not at module scope: the cold-start budget is measured to the *first handled
 * message* (ARCHITECTURE §7.2), and a storage read plus two `chrome.action` calls in front of it
 * would be spending that budget on a picture. A quarter of a second is long after the first message
 * and far shorter than anyone can notice a toolbar button changing.
 */
export const APPEARANCE_DELAY_MS = 250;

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Put the chosen icon and tooltip on the toolbar button.
 *
 * Takes the settings when the caller already has them — `updateSettings` does, and re-reading them
 * there would be a second round trip to answer a question it just answered.
 */
export async function applyToolbarAppearance(settings?: VaultSettings): Promise<void> {
  const current = settings ?? (await readSettings());
  await chrome.action.setIcon({ path: toolbarIconPaths(current.toolbarIcon) });
  // The empty string means "whatever the manifest says", and the manifest says `__MSG_actionTitle__`
  // — so the way back is the same string out of the same `_locales` file, not a copy of it kept
  // here. `setTitle('')` would leave the button with no tooltip at all.
  await chrome.action.setTitle({
    title:
      current.toolbarTitle === '' ? chrome.i18n.getMessage('actionTitle') : current.toolbarTitle,
  });
}

/**
 * Apply it shortly, and only once however many times this is called.
 *
 * Called from the worker's top-level evaluation, which happens on every wake — see the note on
 * {@link APPEARANCE_DELAY_MS} for why it is a timer rather than an await.
 */
export function scheduleToolbarAppearance(delayMs: number = APPEARANCE_DELAY_MS): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    // A worker torn down between the schedule and the fire takes `chrome` with it; the same guard,
    // and the same reason, as `probe()` in `sync/engine.ts`.
    void applyToolbarAppearance().catch(() => undefined);
  }, delayMs);
}
