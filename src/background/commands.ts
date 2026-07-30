/**
 * Keyboard commands, declared in `build/manifest.ts` and dispatched here.
 *
 * The names are a closed set shared with the manifest; `handleCommand` ignores anything else,
 * because a user can rebind our shortcuts on `chrome://extensions/shortcuts` but Chrome can also
 * deliver a command name from an older installed version after an update.
 *
 * Handlers are injected rather than imported so this module does not depend on `session.ts`, and so
 * a test can assert what a keypress dispatches to without unlocking a vault.
 */

import type { LockReason } from '../shared/messages.js';

export const COMMANDS = ['add-current-tab', 'panic-lock', 'open-manager'] as const;

export type CommandName = (typeof COMMANDS)[number];

const COMMAND_NAMES: ReadonlySet<string> = new Set<string>(COMMANDS);

export function isCommandName(name: string): name is CommandName {
  return COMMAND_NAMES.has(name);
}

export interface CommandDeps {
  readonly lock: (reason: LockReason) => Promise<void>;
  /** Re-arms the idle window. */
  readonly touch: () => Promise<unknown>;
  /** Vault the active tab and report the outcome on the toolbar badge — there is no window here. */
  readonly addActiveTab: () => Promise<void>;
}

/** The manager page, in a tab of its own. */
export async function openManager(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
}

export async function handleCommand(name: string, deps: CommandDeps): Promise<void> {
  switch (name) {
    case 'panic-lock':
      // Panic-lock does not flush: someone reaching for this shortcut wants the key gone, and
      // waiting on a storage write to save a half-typed note defeats the point. The open UIs blank
      // themselves on the `SESSION_LOCKED` broadcast that `lock()` sends.
      await deps.lock('panic');
      return;
    case 'open-manager':
      await openManager();
      return;
    case 'add-current-tab':
      // The keystroke is the user gesture that grants `activeTab` for the tab in front of them,
      // which is the whole reason this entry point can read a URL without a host permission (D25).
      // `addActiveTab` touches the idle window itself, on the path where there is a vault to touch.
      await deps.addActiveTab();
      return;
    default:
      return;
  }
}

/**
 * Register the command listener.
 *
 * Called synchronously from the service-worker entry: a keyboard shortcut is one of the events that
 * *wakes* a dead worker, and MV3 only delivers it to listeners registered during the initial
 * evaluation.
 */
export function registerCommandListener(deps: CommandDeps): void {
  chrome.commands.onCommand.addListener((name) => {
    void handleCommand(name, deps);
  });
}
