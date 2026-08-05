/**
 * @vitest-environment jsdom
 *
 * The copyable `chrome://` address (`src/ui/address.ts`).
 *
 * Small, and worth its own file because three screens depend on it and all three of them are
 * instructions the user has to carry out by hand. If the Copy button silently does nothing, the
 * instruction is still on screen and still followable — which is exactly the behaviour asserted
 * here, rather than an exception nobody sees.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTOCOMPLETE_SETTINGS_URL, copyableAddress } from '../../../src/ui/address.js';
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

describe('copyableAddress', () => {
  it('shows the address as text rather than as a link Chrome would refuse to follow', () => {
    const block = copyableAddress({ address: 'chrome://extensions/?id=abc' });
    expect(block.querySelector('code')?.textContent).toBe('chrome://extensions/?id=abc');
    expect(block.querySelector('a')).toBeNull();
  });

  it('copies the address and says it did', async () => {
    const copy = vi.fn(() => Promise.resolve());
    const block = copyableAddress({ address: 'chrome://settings/', copy });
    block.querySelector('button')?.click();
    await settle();

    expect(copy).toHaveBeenCalledWith('chrome://settings/');
    expect(block.querySelector('[role="status"]')?.textContent).toBe('incognitoCopied');
  });

  it('degrades to "select it yourself" when the clipboard refuses', async () => {
    const block = copyableAddress({
      address: 'chrome://settings/',
      copy: () => Promise.reject(new Error('not focused')),
    });
    block.querySelector('button')?.click();
    await settle();

    expect(block.querySelector('[role="status"]')?.textContent).toBe('incognitoCopyFailed');
    // The address is still there to read and select by hand.
    expect(block.querySelector('code')?.textContent).toBe('chrome://settings/');
  });
});

describe('AUTOCOMPLETE_SETTINGS_URL', () => {
  it('is the search-scoped settings page, spelled once', () => {
    // A typo here produces a settings page that opens and shows nothing, which reads to the user as
    // our instructions being wrong rather than the address being wrong.
    expect(AUTOCOMPLETE_SETTINGS_URL).toBe('chrome://settings/?search=autocomplete');
  });
});
