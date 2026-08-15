/**
 * @vitest-environment jsdom
 *
 * The copyable `chrome://` address (`src/ui/address.ts`).
 *
 * Small, and worth its own file because two screens depend on it and both of them are instructions
 * the user has to carry out by hand. If the Copy button silently does nothing, the instruction is
 * still on screen and still followable — which is exactly the behaviour asserted here, rather than
 * an exception nobody sees.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyableValue } from '../../../src/ui/address.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  installChromeMock();
  document.body.replaceChildren();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('copyableValue', () => {
  it('shows the address as text rather than as a link Chrome would refuse to follow', () => {
    const block = copyableValue({ value: 'chrome://extensions/?id=abc' });
    expect(block.querySelector('code')?.textContent).toBe('chrome://extensions/?id=abc');
    expect(block.querySelector('a')).toBeNull();
  });

  it('copies the address and says it did', async () => {
    const copy = vi.fn(() => Promise.resolve());
    const block = copyableValue({ value: 'chrome://settings/', copy });
    block.querySelector('button')?.click();
    await settle();

    expect(copy).toHaveBeenCalledWith('chrome://settings/');
    expect(block.querySelector('[role="status"]')?.textContent).toBe('copied');
  });

  it('degrades to "select it yourself" when the clipboard refuses', async () => {
    const block = copyableValue({
      value: 'chrome://settings/',
      copy: () => Promise.reject(new Error('not focused')),
    });
    block.querySelector('button')?.click();
    await settle();

    expect(block.querySelector('[role="status"]')?.textContent).toBe('copyFailed');
    // The address is still there to read and select by hand.
    expect(block.querySelector('code')?.textContent).toBe('chrome://settings/');
  });
});
