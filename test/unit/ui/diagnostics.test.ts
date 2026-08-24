/**
 * The diagnostics panel.
 *
 * `src/ui/**` carries a 90/85 gate, and this panel is worth the coverage for one behaviour in
 * particular: a refused clipboard leaves the report on screen and says to copy it by hand. That is
 * the failure mode a user in a locked-down profile actually hits, and the version of this feature
 * that only ever copies would tell them "failed" and leave them with nothing.
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Diagnostics } from '../../../src/shared/diagnostics.js';
import { diagnosticsPanel } from '../../../src/ui/diagnostics.js';

const RECORD: Diagnostics = {
  version: '1.4.2',
  chromeMajor: 128,
  platform: 'linux',
  oauthConfigured: false,
  developmentBuild: true,
  vaultExists: true,
  locked: false,
  schemaVersion: 2,
  bookmarks: 7,
  folders: 2,
  tags: 3,
  tombstones: 0,
  withNotes: 1,
  withThumbnails: 0,
  localBytes: 1234,
  buckets: 8,
  thumbnailCacheBytes: 0,
  storedIcons: 0,
  providerId: 'chrome',
  syncPhase: 'idle',
  syncError: null,
  conflicts: 0,
  sinceLastSyncMs: 500,
  syncUsedBytes: 100,
  syncQuotaBytes: 102_400,
  optionalPermissions: [],
  incognitoAllowed: false,
  theme: 'system',
  idleTimeoutMinutes: 10,
  lockOnBrowserBlur: false,
  stripTrackingParams: true,
  reuseIncognitoWindow: true,
  clearHistoryOnLock: false,
  quickClose: false,
  localThumbnails: false,
  sortBy: 'addedAt',
};

/** `chrome.i18n` is the whole of what this file needs from the browser. */
beforeEach(() => {
  vi.stubGlobal('chrome', { i18n: { getMessage: (key: string) => key } });
});

const press = async (root: HTMLElement, label: string): Promise<void> => {
  const button = [...root.querySelectorAll('button')].find((el) => el.textContent === label);
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  button.click();
  // Two turns: the click handler awaits `collect`, then renders.
  await Promise.resolve();
  await Promise.resolve();
};

const textarea = (root: HTMLElement): HTMLTextAreaElement | null =>
  root.querySelector('textarea');

describe('the panel', () => {
  it('shows the report before offering to copy it', async () => {
    const panel = diagnosticsPanel({
      collect: () => Promise.resolve(RECORD),
      copy: () => Promise.resolve(),
    });
    // Nothing at all until it is asked for: gathering the report touches the vault.
    expect(textarea(panel)).toBeNull();

    await press(panel, 'diagnosticsButton');

    // The promise on the button is "safe to paste", and a promise about text nobody can see is one
    // the reader has to take on trust from the program they are filing a bug against.
    expect(textarea(panel)?.value).toContain('VaultaMark diagnostics');
    expect(textarea(panel)?.value).toContain('bookmarks: 7');
    expect(textarea(panel)?.readOnly).toBe(true);
  });

  it('copies exactly what it showed', async () => {
    const copied: string[] = [];
    const panel = diagnosticsPanel({
      collect: () => Promise.resolve(RECORD),
      copy: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });

    await press(panel, 'diagnosticsButton');
    await press(panel, 'diagnosticsCopy');

    expect(copied).toHaveLength(1);
    expect(copied[0]).toBe(textarea(panel)?.value);
  });

  it('leaves the report on screen when the clipboard is refused', async () => {
    const panel = diagnosticsPanel({
      collect: () => Promise.resolve(RECORD),
      copy: () => Promise.reject(new Error('NotAllowedError')),
    });

    await press(panel, 'diagnosticsButton');
    await press(panel, 'diagnosticsCopy');

    expect(panel.textContent).toContain('diagnosticsCopyFailed');
    // The half that is actually useful: the text is still there to select by hand.
    expect(textarea(panel)?.value).toContain('VaultaMark diagnostics');
  });

  it('says so when the worker could not be reached, rather than doing nothing', async () => {
    const panel = diagnosticsPanel({
      collect: () => Promise.resolve(null),
      copy: () => Promise.resolve(),
    });

    await press(panel, 'diagnosticsButton');

    expect(panel.textContent).toContain('diagnosticsFailed');
    expect(textarea(panel)).toBeNull();
  });
});
