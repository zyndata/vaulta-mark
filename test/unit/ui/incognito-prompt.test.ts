/**
 * @vitest-environment jsdom
 *
 * The guided prompt for "Allow in Incognito is off" (ARCHITECTURE §9).
 *
 * This screen is the only thing standing between a missing permission and a user concluding the
 * extension is broken, so what it is tested for is that it never dead-ends: the way to the page is
 * always there, Re-check always says what it found, and the fallback is only ever offered when there
 * is something to fall back to — and never taken by itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { incognitoPrompt } from '../../../src/ui/incognito-prompt.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

function noop(): void {
  // The prompt only reports the press; where the tab comes from is the caller's business.
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`no button labelled "${label}" — got ${root.innerHTML}`);
  return found;
}

beforeEach(() => {
  installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('incognitoPrompt', () => {
  it('offers to open the page, and opens nothing until it is pressed', () => {
    const onOpenSettings = vi.fn();
    const root = incognitoPrompt({ onRecheck: () => Promise.resolve(false), onOpenSettings });

    // Rendering must not navigate anywhere on its own — the user asked to open a bookmark, not to
    // be sent to a settings page.
    expect(onOpenSettings).not.toHaveBeenCalled();
    button(root, 'incognitoOpenSettings').click();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    // Deliberately not an <a href="chrome://…">: that one really is refused from an extension page,
    // and a dead link is a worse instruction than a button that works. `chrome.tabs.create` behind
    // the callback is what actually opens it — measured, see the note in the module.
    expect(root.querySelector('a')).toBe(null);
  });

  it('reports a re-check that found the setting still off', async () => {
    const root = incognitoPrompt({ onRecheck: () => Promise.resolve(false), onOpenSettings: noop });
    expect(root.textContent).not.toContain('incognitoStillOff');

    button(root, 'incognitoRecheck').click();
    await vi.waitFor(() => {
      expect(root.textContent).toContain('incognitoStillOff');
    });
    // Still re-checkable: the user is expected to go and flip the toggle and come back.
    expect(button(root, 'incognitoRecheck')).toBeDefined();
  });

  it('reports a re-check that found it on', async () => {
    const onRecheck = vi.fn(() => Promise.resolve(true));
    const root = incognitoPrompt({ onRecheck, onOpenSettings: noop });

    button(root, 'incognitoRecheck').click();
    await vi.waitFor(() => {
      expect(root.textContent).toContain('incognitoNowOn');
    });
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it('offers no fallback when there is no item to open', () => {
    const root = incognitoPrompt({ onRecheck: () => Promise.resolve(false), onOpenSettings: noop });
    expect(root.textContent).not.toContain('incognitoFallbackButton');
  });

  it('takes the fallback only when the button is pressed, and reports the checkbox', async () => {
    const onFallback = vi.fn(() => Promise.resolve());
    const root = incognitoPrompt({
      onRecheck: () => Promise.resolve(false),
      onOpenSettings: noop,
      onFallback,
    });
    document.body.append(root);

    // Rendering the prompt must not open anything on its own — that is the whole promise.
    expect(onFallback).not.toHaveBeenCalled();
    expect(root.textContent).toContain('incognitoFallbackWarning');

    const clearHistory = root.querySelector<HTMLInputElement>('#vm-clear-history')!;
    expect(clearHistory.checked).toBe(false);
    clearHistory.checked = true;

    button(root, 'incognitoFallbackButton').click();
    await vi.waitFor(() => {
      expect(onFallback).toHaveBeenCalledWith(true);
    });
  });
});
