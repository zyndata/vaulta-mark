/**
 * @vitest-environment jsdom
 *
 * The gate in front of the one destructive import.
 *
 * PLAN §9 Phase 8 asks for one property in particular and asks for it **at the UI layer**: a
 * replace-mode import must be unreachable without the typed confirmation. That is what this file is
 * for. Everything else — the wording, the ordering of the warnings — is checked because a gate that
 * has stopped saying what it is gating has stopped being a gate.
 *
 * jsdom implements `<dialog>` as an element but not as a modal, so `showModal`/`close` are shimmed,
 * exactly as in `dialog.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { confirmReplaceImport } from '../../../src/ui/export-gate.js';
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

function dialog(): HTMLDialogElement {
  const found = document.querySelector('dialog');
  if (found === null) throw new Error(`no dialog is open — body is ${document.body.innerHTML}`);
  return found;
}

function typeInto(value: string): void {
  const input = dialog().querySelector<HTMLInputElement>('input[type="text"]');
  if (input === null) throw new Error('the dialog has no text field');
  input.value = value;
}

function submit(): void {
  dialog().querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
}

function cancel(): void {
  const button = [...dialog().querySelectorAll('button')].find(
    (candidate) => candidate.textContent === 'dialogCancel',
  );
  button?.click();
}

/** The complaint the dialog shows when it refuses to close. */
function complaint(): string {
  return dialog().querySelector('.vm-dialog-invalid')?.textContent ?? '';
}

beforeEach(() => {
  installChromeMock();
  shimDialog();
  document.body.replaceChildren();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('confirmReplaceImport', () => {
  it('asks twice, in two different ways', async () => {
    const pending = confirmReplaceImport({ incoming: 412, current: 930, undoable: true });

    // First: a typed phrase.
    typeInto('importReplacePhrase');
    submit();
    await Promise.resolve();

    // Second: an ordinary confirmation, which is a different question rather than the same one
    // twice — two presses of one question only measure persistence.
    expect(dialog().textContent).toContain('importReplaceLastBody');
    submit();
    expect(await pending).toBe(true);
  });

  it('stops at the first gate when the phrase is wrong', async () => {
    const pending = confirmReplaceImport({ incoming: 1, current: 1, undoable: true });
    typeInto('yes');
    submit();
    expect(complaint()).toBe('importReplaceConfirmRefused');
    cancel();
    expect(await pending).toBe(false);
  });

  it('stops at the second gate when it is dismissed', async () => {
    const pending = confirmReplaceImport({ incoming: 1, current: 1, undoable: true });
    typeInto('importReplacePhrase');
    submit();
    await Promise.resolve();
    cancel();
    expect(await pending).toBe(false);
  });

  it('says whether there will be an undo', async () => {
    const undoable = confirmReplaceImport({ incoming: 1, current: 1, undoable: true });
    expect(dialog().textContent).toContain('importReplaceUndo');
    cancel();
    await undoable;

    const permanent = confirmReplaceImport({ incoming: 1, current: 1, undoable: false });
    expect(dialog().textContent).toContain('importReplaceNoUndo');
    cancel();
    await permanent;
  });
});
