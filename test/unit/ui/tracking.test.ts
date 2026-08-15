/**
 * @vitest-environment jsdom
 *
 * The offer to clean tracking parameters out of a vault that already has them
 * (`src/ui/tracking.ts`).
 *
 * Everything here is about restraint. The feature rewrites addresses the user saved, which is the
 * kind of change that has to be asked for out loud — so what is tested is that it never asks when
 * there is nothing to ask about, and never rewrites anything it was not told to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { offerTrackingCleanup } from '../../../src/ui/tracking.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

function shimDialog(): void {
  const proto = window.HTMLDialogElement.prototype as unknown as {
    showModal: () => void;
    close: () => void;
  };
  proto.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  proto.close = function close(this: HTMLDialogElement): void {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}

function dialogIsOpen(): boolean {
  return document.querySelector('dialog') !== null;
}

/** Press the dialog's confirming button, or its cancel — whichever the caller names. */
function press(label: string): void {
  const found = [...document.querySelectorAll('dialog button')].find(
    (b) => b.textContent === label,
  );
  if (found === undefined) {
    throw new Error(`no button "${label}" — got ${document.body.innerHTML}`);
  }
  (found as HTMLButtonElement).click();
}

/** The confirming button submits the form, which is also what Enter does. */
function confirm(): void {
  document.querySelector('dialog form')?.dispatchEvent(new Event('submit', { cancelable: true }));
}

beforeEach(() => {
  installChromeMock();
  shimDialog();
  document.body.replaceChildren();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('offerTrackingCleanup', () => {
  it('says nothing at all when no saved bookmark would change', async () => {
    const strip = vi.fn(() => Promise.resolve(0));
    const say = vi.fn();

    await offerTrackingCleanup({ count: () => Promise.resolve(0), strip, say });

    // Not "a dialog that reports zero": that is the dialog which teaches people to dismiss the
    // next one unread.
    expect(dialogIsOpen()).toBe(false);
    expect(strip).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it('strips and reports when the offer is accepted', async () => {
    const strip = vi.fn(() => Promise.resolve(42));
    const say = vi.fn();

    const pending = offerTrackingCleanup({ count: () => Promise.resolve(42), strip, say });
    await vi.waitFor(() => {
      expect(dialogIsOpen()).toBe(true);
    });
    confirm();
    await pending;

    expect(strip).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith('trackingCleaned');
  });

  it('changes nothing when the offer is declined', async () => {
    const strip = vi.fn(() => Promise.resolve(42));
    const say = vi.fn();

    const pending = offerTrackingCleanup({ count: () => Promise.resolve(42), strip, say });
    await vi.waitFor(() => {
      expect(dialogIsOpen()).toBe(true);
    });
    press('dialogCancel');
    await pending;

    expect(strip).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it('uses the singular wording for a single bookmark', async () => {
    const say = vi.fn();
    const pending = offerTrackingCleanup({
      count: () => Promise.resolve(1),
      strip: () => Promise.resolve(1),
      say,
    });
    await vi.waitFor(() => {
      expect(dialogIsOpen()).toBe(true);
    });
    expect(document.querySelector('dialog')?.textContent).toContain('trackingCleanupBodyOne');
    confirm();
    await pending;

    expect(say).toHaveBeenCalledWith('trackingCleanedOne');
  });

  it('stays quiet when the strip itself changed nothing — the caller has already said why', async () => {
    const say = vi.fn();
    const pending = offerTrackingCleanup({
      count: () => Promise.resolve(3),
      strip: () => Promise.resolve(0),
      say,
    });
    await vi.waitFor(() => {
      expect(dialogIsOpen()).toBe(true);
    });
    confirm();
    await pending;

    expect(say).not.toHaveBeenCalled();
  });

  it('treats a negative count as nothing to do rather than as a question', async () => {
    const say = vi.fn();
    await offerTrackingCleanup({
      count: () => Promise.resolve(-1),
      strip: () => Promise.resolve(0),
      say,
    });
    expect(dialogIsOpen()).toBe(false);
    expect(say).not.toHaveBeenCalled();
  });
});
