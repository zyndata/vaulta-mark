import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMMANDS,
  handleCommand,
  isCommandName,
  openManager,
  registerCommandListener,
  type CommandDeps,
} from '../../../src/background/commands.js';
import { buildManifest } from '../../../build/manifest.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

let mock: ChromeMock;

function deps(): CommandDeps {
  return {
    lock: vi.fn(() => Promise.resolve()),
    touch: vi.fn(() => Promise.resolve(null)),
    addActiveTab: vi.fn(() => Promise.resolve()),
    quickClose: vi.fn(() => Promise.resolve()),
  };
}

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('COMMANDS', () => {
  it('is exactly what the manifest declares', () => {
    expect(Object.keys(buildManifest('1.0.0').commands ?? {}).sort()).toEqual([...COMMANDS].sort());
  });

  it('recognises its own names and nothing else', () => {
    for (const name of COMMANDS) expect(isCommandName(name)).toBe(true);
    expect(isCommandName('add-current-tab ')).toBe(false);
    expect(isCommandName('_execute_action')).toBe(false);
  });
});

describe('handleCommand', () => {
  it('panic-locks without flushing', async () => {
    const d = deps();
    await handleCommand('panic-lock', d);
    expect(d.lock).toHaveBeenCalledWith('panic');
  });

  it('opens the manager in a tab of its own', async () => {
    await handleCommand('open-manager', deps());
    expect(mock.createdTabs).toEqual([
      { url: `chrome-extension://${mock.chrome.runtime.id}/manager.html` },
    ]);
  });

  it('vaults the active tab on add-current-tab', async () => {
    const d = deps();
    await handleCommand('add-current-tab', d);
    expect(d.addActiveTab).toHaveBeenCalledTimes(1);
    expect(d.lock).not.toHaveBeenCalled();
  });

  it('ignores a name it does not know — Chrome can deliver one after an update', async () => {
    const d = deps();
    await handleCommand('vaultamark-from-a-previous-version', d);
    expect(d.lock).not.toHaveBeenCalled();
    expect(d.touch).not.toHaveBeenCalled();
    expect(d.addActiveTab).not.toHaveBeenCalled();
    expect(mock.createdTabs).toEqual([]);
  });
});

describe('registerCommandListener', () => {
  it('dispatches a keypress', async () => {
    const d = deps();
    registerCommandListener(d);
    mock.triggerCommand('panic-lock');
    await vi.waitFor(() => {
      expect(d.lock).toHaveBeenCalledWith('panic');
    });
  });
});

describe('openManager', () => {
  it('uses an extension-origin URL, never an absolute one', async () => {
    await openManager();
    expect(mock.createdTabs[0]?.url).toMatch(/^chrome-extension:\/\//);
  });
});
