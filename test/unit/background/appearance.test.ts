/**
 * The toolbar button's picture and tooltip (PLAN §9 Phase 14, ARCHITECTURE §16).
 *
 * Three properties, and the third is the one this feature would fail on in the field rather than in
 * a test: the default is the mark the extension ships with, a choice round-trips through
 * `vm.settings`, and **a choice is put back after a worker restart**. MV3 tears the worker down
 * every ~30 seconds and Chrome forgets a runtime action icon at every browser start, extension
 * reload and update — so an icon applied once by whatever screen set it is an icon that quietly
 * reverts, and only a restart test says so.
 *
 * The restart is the real one the rest of `test/unit/background/` uses: `terminateWorker()` to drop
 * the listeners, `vi.resetModules()` for a fresh module registry, and a re-import over the same
 * storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toolbarIconPaths } from '../../../src/shared/appearance.js';
import { LOCAL_KEYS, readSettings } from '../../../src/storage/local.js';
import { SYNCED_SETTING_KEYS } from '../../../src/vault/settings-sync.js';
import { DEFAULT_SETTINGS, TOOLBAR_ICONS, type VaultSettings } from '../../../src/vault/types.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

type AppearanceModule = typeof import('../../../src/background/appearance.js');
type SessionModule = typeof import('../../../src/background/session.js');

let mock: ChromeMock;
let appearance: AppearanceModule;

/** Re-import the module graph, which is what MV3 does when it restarts a dead worker. */
async function restartWorker(): Promise<AppearanceModule> {
  mock.terminateWorker();
  vi.resetModules();
  appearance = await import('../../../src/background/appearance.js');
  return appearance;
}

async function storeSettings(patch: Partial<VaultSettings>): Promise<void> {
  await mock.storage.local.set({ [LOCAL_KEYS.settings]: { ...DEFAULT_SETTINGS, ...patch } });
}

beforeEach(async () => {
  vi.useFakeTimers();
  mock = installChromeMock();
  vi.resetModules();
  appearance = await import('../../../src/background/appearance.js');
});

afterEach(() => {
  uninstallChromeMock();
  vi.useRealTimers();
});

describe('applyToolbarAppearance', () => {
  it('dresses a fresh profile in the icon the manifest already points at', async () => {
    await appearance.applyToolbarAppearance();

    // Not "some icon": the exact four files, because the property under test is that an untouched
    // install looks identical to one where this feature does not exist.
    expect(mock.actionIcon()).toEqual({
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    });
    // The mock's `i18n.getMessage` answers with the key, so this is "the manifest's own string",
    // spelled the way the rest of the suite spells it.
    expect(mock.actionTitle()).toBe('actionTitle');
  });

  it('gives every declared size a path, for every icon on offer', async () => {
    for (const id of TOOLBAR_ICONS) {
      await storeSettings({ toolbarIcon: id });
      await appearance.applyToolbarAppearance();
      expect(Object.keys(mock.actionIcon() ?? {})).toEqual(['16', '32', '48', '128']);
    }
  });

  it('puts a chosen tooltip on the button and an empty one back to the shipped string', async () => {
    await storeSettings({ toolbarTitle: 'Reading list' });
    await appearance.applyToolbarAppearance();
    expect(mock.actionTitle()).toBe('Reading list');

    await storeSettings({ toolbarTitle: '' });
    await appearance.applyToolbarAppearance();
    expect(mock.actionTitle()).toBe('actionTitle');
  });

  it('takes the settings it is handed rather than reading them again', async () => {
    await storeSettings({ toolbarIcon: 'page' });
    await appearance.applyToolbarAppearance({ ...DEFAULT_SETTINGS, toolbarIcon: 'folder' });
    expect(mock.actionIcon()).toEqual(toolbarIconPaths('folder'));
  });
});

describe('scheduleToolbarAppearance', () => {
  it('waits until after the cold-start window rather than racing the first message', async () => {
    appearance.scheduleToolbarAppearance();
    expect(mock.actionIcon()).toBeNull();

    await vi.advanceTimersByTimeAsync(appearance.APPEARANCE_DELAY_MS);
    expect(mock.actionIcon()).toEqual(toolbarIconPaths('default'));
  });

  it('applies once however many wakes coalesce into it', async () => {
    const calls = vi.spyOn(chrome.action, 'setIcon');
    appearance.scheduleToolbarAppearance();
    appearance.scheduleToolbarAppearance();
    appearance.scheduleToolbarAppearance();

    await vi.advanceTimersByTimeAsync(appearance.APPEARANCE_DELAY_MS);
    expect(calls).toHaveBeenCalledTimes(1);
    calls.mockRestore();
  });

  /**
   * The one that matters.
   *
   * Nothing carries over from the first worker to the second but `chrome.storage.local`, which is
   * exactly the situation in the field: the module variable holding the choice is gone, the timer
   * is gone, and Chrome has already forgotten the icon.
   */
  it('puts a chosen icon back after the worker has been torn down', async () => {
    await storeSettings({ toolbarIcon: 'folder', toolbarTitle: 'Notes' });
    await appearance.applyToolbarAppearance();
    expect(mock.actionIcon()).toEqual(toolbarIconPaths('folder'));

    const restarted = await restartWorker();
    restarted.scheduleToolbarAppearance();
    await vi.advanceTimersByTimeAsync(restarted.APPEARANCE_DELAY_MS);

    expect(mock.actionIcon()).toEqual(toolbarIconPaths('folder'));
    expect(mock.actionTitle()).toBe('Notes');
  });

  it('survives a wake into a world that is no longer there', async () => {
    vi.spyOn(chrome.action, 'setIcon').mockRejectedValue(new Error('worker gone'));
    appearance.scheduleToolbarAppearance();

    // An unhandled rejection out of a timer is what a torn-down worker produces, and it fails the
    // *next* test rather than this one — the same trap `attempt()` in `sync/engine.ts` guards.
    await vi.advanceTimersByTimeAsync(appearance.APPEARANCE_DELAY_MS);
    expect(mock.actionIcon()).toBeNull();
  });
});

/**
 * The whole path a click takes: `SET_SETTINGS` → `parseSettingsPatch` → `updateSettings` → the
 * toolbar.
 *
 * Applied inside `updateSettings` rather than left to the `SETTINGS_CHANGED` broadcast, because the
 * worker does not receive its own broadcasts — a version that listened for one would look right and
 * change nothing, which is the failure this test exists to catch.
 */
describe('a settings change', () => {
  let session: SessionModule;

  beforeEach(async () => {
    session = await import('../../../src/background/session.js');
  });

  it('reaches the toolbar without anyone asking it to', async () => {
    await session.updateSettings({ toolbarIcon: 'ribbon', toolbarTitle: 'Reading list' });

    expect(mock.actionIcon()).toEqual(toolbarIconPaths('ribbon'));
    expect(mock.actionTitle()).toBe('Reading list');
  });

  it('round-trips, and leaves every other preference alone', async () => {
    const before = await readSettings();
    const after = await session.updateSettings({ toolbarIcon: 'page' });

    expect(after.toolbarIcon).toBe('page');
    expect((await readSettings()).toolbarIcon).toBe('page');
    expect({ ...after, toolbarIcon: before.toolbarIcon }).toEqual(before);
  });

  it('stays out of the synced record, because it describes a screen', () => {
    // The same reasoning that keeps `sidebarWidth` and `providerId` local: one computer is at a desk
    // in a shared office and another is at home, and that difference is the whole reason anyone
    // reaches for this.
    expect(SYNCED_SETTING_KEYS).not.toContain('toolbarIcon');
    expect(SYNCED_SETTING_KEYS).not.toContain('toolbarTitle');
  });
});
