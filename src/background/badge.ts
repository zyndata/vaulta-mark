/**
 * The toolbar badge — the only way a keyboard shortcut or a context-menu click can say what it did.
 *
 * Neither of those entry points has a window to render into, and the obvious answer,
 * `chrome.notifications`, needs a permission we do not have and will not add for a confirmation
 * message (INV-9, D25). `chrome.action.setBadgeText` needs nothing at all, is visible exactly where
 * the user just clicked, and cannot leak: the text is a single glyph and never contains a title, a
 * URL or a host.
 *
 * The badge clears itself after a moment. If the service worker is torn down first the glyph stays
 * up until the next event, which is untidy and harmless — and preferable to an alarm, whose minimum
 * granularity is thirty seconds and which would still lose the race.
 */

/** How long a confirmation stays on the toolbar button. */
export const BADGE_MS = 2_000;

export type BadgeKind = 'added' | 'duplicate' | 'locked' | 'refused';

/** One glyph each. Chrome truncates a badge to about four characters at this font size. */
const GLYPHS: Record<BadgeKind, string> = {
  added: '✓',
  duplicate: '=',
  locked: '🔒',
  refused: '!',
};

const COLORS: Record<BadgeKind, string> = {
  added: '#1c6b3c',
  duplicate: '#2f4bc4',
  locked: '#5c6370',
  refused: '#b3261e',
};

let clearTimer: ReturnType<typeof setTimeout> | null = null;

/** Show a confirmation glyph on the toolbar button, then clear it. */
export async function flashBadge(kind: BadgeKind): Promise<void> {
  if (clearTimer !== null) clearTimeout(clearTimer);
  await chrome.action.setBadgeBackgroundColor({ color: COLORS[kind] });
  await chrome.action.setBadgeText({ text: GLYPHS[kind] });
  clearTimer = setTimeout(() => {
    clearTimer = null;
    void chrome.action.setBadgeText({ text: '' });
  }, BADGE_MS);
}

/** Clear the badge now. Called at worker start, in case one was left behind by a teardown. */
export async function clearBadge(): Promise<void> {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  await chrome.action.setBadgeText({ text: '' });
}
