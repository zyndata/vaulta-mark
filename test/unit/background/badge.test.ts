/**
 * The toolbar badge — the only channel the keyboard shortcut and the context menu have back to the
 * user, since neither has a window and `chrome.notifications` would mean a permission we will not
 * add (INV-9).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BADGE_MS, clearBadge, flashBadge } from '../../../src/background/badge.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

let mock: ChromeMock;

beforeEach(() => {
  vi.useFakeTimers();
  mock = installChromeMock();
});

afterEach(async () => {
  await clearBadge();
  uninstallChromeMock();
  vi.useRealTimers();
});

describe('flashBadge', () => {
  it('shows a glyph and clears it again', async () => {
    await flashBadge('added');
    expect(mock.badgeText()).toBe('✓');

    await vi.advanceTimersByTimeAsync(BADGE_MS);
    expect(mock.badgeText()).toBe('');
  });

  it('gives every outcome its own glyph', async () => {
    const seen = new Set<string>();
    for (const kind of ['added', 'duplicate', 'locked', 'refused'] as const) {
      await flashBadge(kind);
      seen.add(mock.badgeText());
    }
    expect(seen.size).toBe(4);
  });

  it('never puts anything but a glyph on the toolbar', async () => {
    for (const kind of ['added', 'duplicate', 'locked', 'refused'] as const) {
      await flashBadge(kind);
      expect([...mock.badgeText()]).toHaveLength(1);
    }
  });

  it('restarts the timer rather than letting the first one clear the second glyph', async () => {
    await flashBadge('added');
    await vi.advanceTimersByTimeAsync(BADGE_MS - 100);
    await flashBadge('duplicate');

    await vi.advanceTimersByTimeAsync(200);
    expect(mock.badgeText()).toBe('=');

    await vi.advanceTimersByTimeAsync(BADGE_MS);
    expect(mock.badgeText()).toBe('');
  });
});

describe('clearBadge', () => {
  it('clears a glyph a torn-down worker left behind', async () => {
    await flashBadge('added');
    await clearBadge();
    expect(mock.badgeText()).toBe('');
  });
});
