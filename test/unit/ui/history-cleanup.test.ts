/**
 * @vitest-environment jsdom
 *
 * The history-cleanup panel (`src/ui/history-cleanup.ts`), the widget that appears in both
 * onboarding step 5 and Settings → Privacy.
 *
 * It deletes browsing history, so what is worth testing is the order it insists on: explain, ask for
 * the permission, show the dry run, take a confirmation, and only then delete. Every one of those
 * steps is something a later change could quietly drop, and a panel that went straight from the
 * button to the deletion would still look right in a screenshot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  historyCleanupPanel,
  type CleanupPreview,
  type HistoryCleanupDeps,
} from '../../../src/ui/history-cleanup.js';
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

/** Click the first button whose text is this `_locales` key — the mock returns keys verbatim. */
function press(root: ParentNode, key: string): void {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent === key);
  if (found === undefined) throw new Error(`no button "${key}" — got ${(root as Element).innerHTML}`);
  found.click();
}

/**
 * Click a button inside the modal.
 *
 * Scoped to the `<dialog>` on purpose: the confirmation's own button carries the same label as the
 * one on the panel behind it (they are the same action, so they are the same words), and an
 * unscoped search finds the panel's — which re-opens the dialog instead of confirming it.
 */
function pressInDialog(key: string): void {
  const dialog = document.querySelector('dialog');
  if (dialog === null) throw new Error('no dialog is open');
  press(dialog, key);
}

function has(root: ParentNode, key: string): boolean {
  return (root as Element).textContent.includes(key);
}

const PREVIEW: CleanupPreview = {
  granted: true,
  searched: 3,
  entries: 5,
  domains: [
    { domain: 'bbc.co.uk', entries: 2 },
    { domain: 'example.com', entries: 3 },
  ],
};

function deps(over: Partial<HistoryCleanupDeps> = {}): HistoryCleanupDeps {
  return {
    granted: true,
    request: vi.fn(() => Promise.resolve(true)),
    preview: vi.fn(() => Promise.resolve(PREVIEW)),
    clear: vi.fn(() => Promise.resolve(5)),
    ...over,
  };
}

/** Let the click handlers' promise chains settle. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  installChromeMock();
  shimDialog();
  document.body.replaceChildren();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('before the permission is granted', () => {
  it('explains first and offers to ask, rather than asking on mount', async () => {
    const d = deps({ granted: false });
    const panel = historyCleanupPanel(d);

    expect(has(panel, 'historyPermissionExplained')).toBe(true);
    expect(d.request).not.toHaveBeenCalled();

    press(panel, 'historyGrantButton');
    await settle();
    expect(d.request).toHaveBeenCalledTimes(1);
    expect(has(panel, 'historyCheckButton')).toBe(true);
  });

  it('says so and stops when the request is refused', async () => {
    const d = deps({ granted: false, request: vi.fn(() => Promise.resolve(false)) });
    const panel = historyCleanupPanel(d);

    press(panel, 'historyGrantButton');
    await settle();

    expect(has(panel, 'historyRefused')).toBe(true);
    expect(d.preview).not.toHaveBeenCalled();
  });
});

describe('the dry run', () => {
  it('shows a count and a reviewable list, and deletes nothing', async () => {
    const d = deps();
    const panel = historyCleanupPanel(d);

    press(panel, 'historyCheckButton');
    await settle();

    expect(has(panel, 'historyDryRun')).toBe(true);
    expect(panel.querySelectorAll('details li')).toHaveLength(2);
    expect(panel.textContent).toContain('bbc.co.uk');
    expect(d.clear).not.toHaveBeenCalled();
  });

  it('uses the singular line when only one site matched', async () => {
    const single: CleanupPreview = { ...PREVIEW, domains: [{ domain: 'a.test', entries: 5 }] };
    const panel = historyCleanupPanel(deps({ preview: vi.fn(() => Promise.resolve(single)) }));

    press(panel, 'historyCheckButton');
    await settle();
    expect(has(panel, 'historyDryRunOneDomain')).toBe(true);
  });

  it('offers no delete button when there is nothing to delete', async () => {
    const empty: CleanupPreview = { granted: true, searched: 3, entries: 0, domains: [] };
    const d = deps({ preview: vi.fn(() => Promise.resolve(empty)) });
    const panel = historyCleanupPanel(d);

    press(panel, 'historyCheckButton');
    await settle();

    expect(has(panel, 'historyDryRunNothing')).toBe(true);
    expect(has(panel, 'historyClearButton')).toBe(false);
  });

  it('goes back to asking for the permission if it was revoked since mount', async () => {
    // A permission can be taken back from chrome://extensions while this dialog is open, and the
    // worker's answer is the authority — not what the panel was told when it was built.
    const revoked: CleanupPreview = { granted: false, searched: 0, entries: 0, domains: [] };
    const panel = historyCleanupPanel(deps({ preview: vi.fn(() => Promise.resolve(revoked)) }));

    press(panel, 'historyCheckButton');
    await settle();
    expect(has(panel, 'historyPermissionExplained')).toBe(true);
  });

  it('reports a failure without claiming anything was deleted', async () => {
    const d = deps({ preview: vi.fn(() => Promise.resolve(null)) });
    const panel = historyCleanupPanel(d);

    press(panel, 'historyCheckButton');
    await settle();

    expect(has(panel, 'historyCheckFailed')).toBe(true);
    expect(d.clear).not.toHaveBeenCalled();
  });
});

describe('deleting', () => {
  async function toPreview(d: HistoryCleanupDeps): Promise<HTMLElement> {
    const panel = historyCleanupPanel(d);
    document.body.append(panel);
    press(panel, 'historyCheckButton');
    await settle();
    return panel;
  }

  it('asks once more before it deletes anything', async () => {
    const d = deps();
    const panel = await toPreview(d);

    press(panel, 'historyClearButton');
    await settle();

    expect(document.querySelector('dialog')).not.toBeNull();
    expect(d.clear).not.toHaveBeenCalled();
  });

  it('deletes on confirmation and reports what really went', async () => {
    // Three, not the five the preview promised: the panel reports the number that came back.
    const d = deps({ clear: vi.fn(() => Promise.resolve(3)) });
    const panel = await toPreview(d);

    press(panel, 'historyClearButton');
    await settle();
    pressInDialog('historyClearButton');
    await settle();

    expect(d.clear).toHaveBeenCalledTimes(1);
    expect(has(panel, 'historyCleared')).toBe(true);
  });

  it('uses the singular line for one entry', async () => {
    const d = deps({ clear: vi.fn(() => Promise.resolve(1)) });
    const panel = await toPreview(d);

    press(panel, 'historyClearButton');
    await settle();
    pressInDialog('historyClearButton');
    await settle();

    expect(has(panel, 'historyClearedOne')).toBe(true);
  });

  it('deletes nothing when the confirmation is dismissed', async () => {
    const d = deps();
    const panel = await toPreview(d);

    press(panel, 'historyClearButton');
    await settle();
    pressInDialog('dialogCancel');
    await settle();

    expect(d.clear).not.toHaveBeenCalled();
  });

  it('leaves the dry run alone when "leave it alone" is pressed', async () => {
    const d = deps();
    const panel = await toPreview(d);

    press(panel, 'historyCancelButton');
    await settle();

    expect(d.clear).not.toHaveBeenCalled();
    expect(has(panel, 'historyCheckButton')).toBe(true);
  });

  it('says so when the deletion itself fails', async () => {
    const d = deps({ clear: vi.fn(() => Promise.resolve(null)) });
    const panel = await toPreview(d);

    press(panel, 'historyClearButton');
    await settle();
    pressInDialog('historyClearButton');
    await settle();

    expect(has(panel, 'historyCheckFailed')).toBe(true);
  });
});
