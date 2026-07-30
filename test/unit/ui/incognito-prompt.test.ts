/**
 * @vitest-environment jsdom
 *
 * The guided prompt for "Allow in Incognito is off" (ARCHITECTURE §9).
 *
 * This screen is the only thing standing between a missing permission and a user concluding the
 * extension is broken, so what it is tested for is that it never dead-ends: the address is always
 * present and copyable, Re-check always says what it found, and the fallback is only ever offered
 * when there is something to fall back to — and never taken by itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { incognitoPrompt } from '../../../src/ui/incognito-prompt.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

const SETTINGS_URL = 'chrome://extensions/?id=vaultamarktestextensionidaaaaaaaa';

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
  it('shows the address to paste, because we cannot navigate there ourselves', () => {
    const root = incognitoPrompt({
      settingsUrl: SETTINGS_URL,
      onRecheck: () => Promise.resolve(false),
    });

    expect(root.querySelector('code')?.textContent).toBe(SETTINGS_URL);
    // Deliberately not an <a href="chrome://…">: Chrome refuses to follow one from an extension
    // page, and a dead link is a worse instruction than a string the user can copy.
    expect(root.querySelector('a')).toBe(null);
  });

  it('copies the address and says so', async () => {
    const copy = vi.fn(() => Promise.resolve());
    const root = incognitoPrompt({
      settingsUrl: SETTINGS_URL,
      onRecheck: () => Promise.resolve(false),
      copy,
    });

    button(root, 'incognitoCopyButton').click();
    await vi.waitFor(() => {
      expect(root.textContent).toContain('incognitoCopied');
    });
    expect(copy).toHaveBeenCalledWith(SETTINGS_URL);
  });

  it('says so when the clipboard refuses, rather than looking like nothing happened', async () => {
    const root = incognitoPrompt({
      settingsUrl: SETTINGS_URL,
      onRecheck: () => Promise.resolve(false),
      copy: () => Promise.reject(new Error('not focused')),
    });

    button(root, 'incognitoCopyButton').click();
    await vi.waitFor(() => {
      expect(root.textContent).toContain('incognitoCopyFailed');
    });
  });

  it('reports a re-check that found the setting still off', async () => {
    const root = incognitoPrompt({
      settingsUrl: SETTINGS_URL,
      onRecheck: () => Promise.resolve(false),
    });
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
    const root = incognitoPrompt({ settingsUrl: SETTINGS_URL, onRecheck });

    button(root, 'incognitoRecheck').click();
    await vi.waitFor(() => {
      expect(root.textContent).toContain('incognitoNowOn');
    });
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it('offers no fallback when there is no item to open', () => {
    const root = incognitoPrompt({
      settingsUrl: SETTINGS_URL,
      onRecheck: () => Promise.resolve(false),
    });
    expect(root.textContent).not.toContain('incognitoFallbackButton');
  });

  it('takes the fallback only when the button is pressed, and reports the checkbox', async () => {
    const onFallback = vi.fn(() => Promise.resolve());
    const root = incognitoPrompt({
      settingsUrl: SETTINGS_URL,
      onRecheck: () => Promise.resolve(false),
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
