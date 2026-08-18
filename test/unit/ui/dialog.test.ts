/**
 * @vitest-environment jsdom
 *
 * The project's one way of asking a question (`src/ui/dialog.ts`).
 *
 * What is worth asserting here is not that a dialog renders — it is that every one of them has a
 * way *out*, and that the way out reports what the user actually chose. A dialog that resolves the
 * wrong value silently does the thing the user declined; a dialog that never resolves hangs the
 * call site forever, and the call sites are `await`ing it before a delete.
 *
 * jsdom implements `<dialog>` as an element but not as a modal — `showModal` and `close` do not
 * exist on it. Both are shimmed below rather than the module being written around them: the top-
 * level focus trap and the Escape handling are exactly the reasons this file uses the platform
 * dialog at all, and a module that avoided them to be testable would be testing something else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chooseDialog,
  confirmDialog,
  dialogField,
  dialogText,
  openDialog,
  promptText,
} from '../../../src/ui/dialog.js';
import { h } from '../../../src/ui/dom.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

/** jsdom's `<dialog>` is inert. Enough of one to drive open, close and the `close` event. */
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

function button(label: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll('button')].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`no button "${label}" — got ${dialog().innerHTML}`);
  return found;
}

/** Press the confirming button by submitting the form, which is what Enter does too. */
function submit(): void {
  dialog().querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
}

beforeEach(() => {
  installChromeMock();
  shimDialog();
  document.body.replaceChildren();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('openDialog', () => {
  it('resolves with the caller’s value and takes the dialog out of the document', async () => {
    const pending = openDialog<'yes'>({
      heading: 'Heading',
      body: [h('p', null, 'body')],
      confirmLabel: 'Do it',
      onConfirm: () => 'yes',
    });

    submit();
    expect(await pending).toBe('yes');
    // Left parked in the DOM it would keep its fields reachable to a screen reader in browse mode.
    expect(document.querySelector('dialog')).toBe(null);
  });

  it('resolves null when it is dismissed, whatever onConfirm would have said', async () => {
    const onConfirm = vi.fn(() => 'yes');
    const pending = openDialog<string>({
      heading: 'Heading',
      body: [],
      confirmLabel: 'Do it',
      onConfirm,
    });

    button('dialogCancel').click();
    expect(await pending).toBe(null);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('resolves null when the dialog is closed from outside — Escape, in a real browser', async () => {
    const pending = openDialog<string>({ heading: 'Heading', body: [] });
    dialog().close();
    expect(await pending).toBe(null);
  });

  it('labels its only button "close" when there is nothing to confirm', () => {
    void openDialog<string>({ heading: 'Heading', body: [] });
    expect(button('dialogClose')).toBeTruthy();
  });

  it('stays open and says why when onConfirm refuses', () => {
    void openDialog<string>({
      heading: 'Heading',
      body: [],
      confirmLabel: 'Do it',
      onConfirm: () => null,
      invalidMessage: () => 'that is not a name',
    });

    submit();
    const complaint = dialog().querySelector('.vm-dialog-invalid');
    expect(dialog().open).toBe(true);
    expect(complaint?.textContent).toBe('that is not a name');
    expect(complaint?.hasAttribute('hidden')).toBe(false);
  });

  it('falls back to a generic complaint rather than refusing in silence', () => {
    void openDialog<string>({
      heading: 'Heading',
      body: [],
      confirmLabel: 'Do it',
      onConfirm: () => null,
    });

    submit();
    expect(dialog().querySelector('.vm-dialog-invalid')?.textContent).toBe('dialogInvalid');
  });

  it('clears the complaint, and the invalid marking, as soon as the value is being fixed', () => {
    const input = h('input', { type: 'text' });
    void openDialog<string>({
      heading: 'Heading',
      body: [dialogField('label', input)],
      confirmLabel: 'Do it',
      focus: input,
      onConfirm: () => null,
    });

    submit();
    expect(input.getAttribute('aria-invalid')).toBe('true');

    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(dialog().querySelector('.vm-dialog-invalid')?.hasAttribute('hidden')).toBe(true);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('focuses what the caller asked it to', () => {
    const input = h('input', { type: 'text' });
    void openDialog<string>({ heading: 'Heading', body: [input], focus: input });
    expect(document.activeElement).toBe(input);
  });

  it('focuses the confirming button when there is no field, so Enter answers the question', () => {
    // Not Cancel, which is what `showModal` picks on its own for being first in the DOM — that left
    // Enter and Escape both meaning "no", and a question answerable only with the mouse.
    void openDialog<string>({
      heading: 'Heading',
      body: [],
      confirmLabel: 'Do it',
      onConfirm: () => 'x',
    });
    expect(document.activeElement).toBe(button('Do it'));
  });

  it('waits for an async onConfirm, and keeps the dialog open when it refuses', async () => {
    // The shape the import and backup dialogs use: the answer needs a round trip to the worker and a
    // 600,000-iteration derivation, so "wrong password" arrives long after the button was pressed.
    // Closing first and reporting behind would cost the user the file they picked as well.
    let settle: (value: 'ok' | null) => void = () => undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<'ok' | null>((resolve) => {
          settle = resolve;
        }),
    );
    const pending = openDialog<'ok'>({
      heading: 'Open the backup',
      body: [],
      confirmLabel: 'Open',
      onConfirm,
      invalidMessage: () => 'that password does not open this file',
    });

    submit();
    // The buttons go dead while it is outstanding, so Enter twice cannot start it twice — and
    // something says so, because greyed-out buttons do not read as "working".
    expect(button('Open').disabled).toBe(true);
    expect(button('dialogCancel').disabled).toBe(true);
    expect(dialog().querySelector('.vm-dialog-working')?.hasAttribute('hidden')).toBe(false);

    settle(null);
    await Promise.resolve();
    await Promise.resolve();

    expect(dialog().querySelector('.vm-dialog-working')?.hasAttribute('hidden')).toBe(true);
    expect(dialog().open).toBe(true);
    expect(dialog().querySelector('.vm-dialog-invalid')?.textContent).toBe(
      'that password does not open this file',
    );
    expect(button('Open').disabled).toBe(false);

    // And the second attempt, with the right answer, closes it with the value.
    submit();
    settle('ok');
    expect(await pending).toBe('ok');
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('ignores a second submit while an async onConfirm is still deciding', async () => {
    let settle: (value: 'ok') => void = () => undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<'ok'>((resolve) => {
          settle = resolve;
        }),
    );
    const pending = openDialog<'ok'>({
      heading: 'Back up the vault',
      body: [],
      confirmLabel: 'Save',
      onConfirm,
    });

    submit();
    submit();
    submit();
    expect(onConfirm).toHaveBeenCalledTimes(1);

    settle('ok');
    expect(await pending).toBe('ok');
  });

  it('marks the confirming button as destructive only when asked', () => {
    void openDialog<string>({
      heading: 'Heading',
      body: [],
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => 'x',
    });
    expect(button('Delete').className).toContain('vm-button--danger');
  });

  /*
   * `extraActions` is how one panel holds two answers about the same object — rename it, or delete
   * it. What matters is that the extra button closes the dialog with *its own* value without going
   * anywhere near `onConfirm`: the panels using it validate a name in there, and a delete that had
   * to satisfy the rename's validation would be a delete you could not reach from an empty field.
   */
  it('resolves an extra action’s value without consulting onConfirm', async () => {
    const onConfirm = vi.fn(() => 'renamed');
    const pending = openDialog<string | { kind: 'delete' }>({
      heading: 'Heading',
      body: [],
      confirmLabel: 'Rename',
      onConfirm,
      extraActions: [{ label: 'Delete the folder', value: { kind: 'delete' }, danger: true }],
    });

    expect(button('Delete the folder').className).toContain('vm-button--danger');
    button('Delete the folder').click();
    expect(await pending).toEqual({ kind: 'delete' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.querySelector('dialog')).toBe(null);
  });

  it('keeps the extra answer away from the pair at the end, and disables it while deciding', async () => {
    let settle: (value: string | null) => void = () => undefined;
    const pending = openDialog<string>({
      heading: 'Heading',
      body: [],
      confirmLabel: 'Rename',
      onConfirm: () => new Promise<string | null>((resolve) => (settle = resolve)),
      extraActions: [{ label: 'Delete', value: 'gone' }],
    });

    const actions = dialog().querySelector('.vm-dialog-actions');
    expect(actions?.className).toContain('vm-dialog-actions--split');
    // Leftmost: the answer that is neither what the panel is for nor the way out of it.
    expect(actions?.firstElementChild?.textContent).toBe('Delete');

    submit();
    // One answer at a time — an outstanding decision must not be overtaken by the other button.
    expect(button('Delete').disabled).toBe(true);
    settle('renamed');
    expect(await pending).toBe('renamed');
  });
});

describe('confirmDialog', () => {
  it('is true only when the confirming button was pressed', async () => {
    const pending = confirmDialog({
      heading: 'Delete “A”?',
      body: [dialogText('deleteConfirmBody')],
      confirmLabel: 'Delete',
      danger: true,
    });
    submit();
    expect(await pending).toBe(true);
  });

  it('puts Enter on the confirming button even when it is destructive', async () => {
    // The Delete key raised this dialog; Enter is the answer to it. Deliberate on a delete because
    // the delete is undoable for eight seconds afterwards — a choice with no safe default goes to
    // `chooseDialog` instead, which preselects nothing.
    const pending = confirmDialog({
      heading: 'Delete “A”?',
      body: [],
      confirmLabel: 'Delete',
      danger: true,
    });
    expect(document.activeElement).toBe(button('Delete'));
    button('Delete').click();
    expect(await pending).toBe(true);
  });

  it('is false for every other way out, so a cancelled delete cannot read as a confirmed one', async () => {
    const pending = confirmDialog({
      heading: 'Delete “A”?',
      body: [],
      confirmLabel: 'Delete',
    });
    button('dialogCancel').click();
    expect(await pending).toBe(false);
  });
});

describe('chooseDialog', () => {
  it('resolves the value of the button that was pressed', async () => {
    const pending = chooseDialog<'reparent' | 'recursive'>({
      heading: 'Delete folder?',
      body: [],
      choices: [
        { label: 'Keep contents', value: 'reparent' },
        { label: 'Delete everything', value: 'recursive', danger: true },
      ],
    });

    button('Delete everything').click();
    expect(await pending).toBe('recursive');
  });

  it('preselects nothing destructive: the first choice takes focus, and Cancel resolves null', async () => {
    const pending = chooseDialog<string>({
      heading: 'Delete folder?',
      body: [],
      choices: [
        { label: 'Keep contents', value: 'reparent' },
        { label: 'Delete everything', value: 'recursive', danger: true },
      ],
    });

    expect(document.activeElement).toBe(button('Keep contents'));
    button('dialogCancel').click();
    expect(await pending).toBe(null);
  });
});

describe('promptText', () => {
  it('trims what was typed and resolves it', async () => {
    const pending = promptText({
      heading: 'New folder',
      labelKey: 'folderNameLabel',
      confirmLabel: 'Create',
    });

    const input = dialog().querySelector('input');
    if (input === null) throw new Error('no input');
    input.value = '  Work  ';
    submit();
    expect(await pending).toBe('Work');
  });

  it('starts from the value it was given, for a rename', () => {
    void promptText({
      heading: 'Rename',
      labelKey: 'folderNameLabel',
      confirmLabel: 'Rename',
      value: 'Work',
    });
    expect(dialog().querySelector('input')?.value).toBe('Work');
  });

  it('refuses a blank answer in place rather than resolving null', () => {
    void promptText({
      heading: 'New folder',
      labelKey: 'folderNameLabel',
      confirmLabel: 'Create',
      value: '   ',
    });

    submit();
    expect(dialog().open).toBe(true);
    expect(dialog().querySelector('.vm-dialog-invalid')?.textContent).toBe('dialogNameRequired');
  });

  it('reports the caller’s own objection, and accepts once it is met', async () => {
    const pending = promptText({
      heading: 'Rename tag',
      labelKey: 'tagRenameLabel',
      confirmLabel: 'Rename',
      value: 'dev',
      validate: (value) => (value === 'dev' ? 'that is the same tag' : null),
    });

    submit();
    expect(dialog().querySelector('.vm-dialog-invalid')?.textContent).toBe('that is the same tag');

    const input = dialog().querySelector('input');
    if (input === null) throw new Error('no input');
    input.value = 'devops';
    submit();
    expect(await pending).toBe('devops');
  });

  it('carries an extra action through, and answers with it rather than with a string', async () => {
    const pending = promptText<{ kind: 'delete' }>({
      heading: 'Rename',
      labelKey: 'folderNameLabel',
      confirmLabel: 'Rename',
      value: 'Recipes',
      extraActions: [{ label: 'Delete the folder', value: { kind: 'delete' }, danger: true }],
    });

    button('Delete the folder').click();
    const answer = await pending;
    // The discriminator the call sites use. A sentinel string would have been indistinguishable
    // from a folder someone actually named "delete".
    expect(typeof answer === 'string').toBe(false);
    expect(answer).toEqual({ kind: 'delete' });
  });
});

describe('dialogField and dialogText', () => {
  it('labels the control, and carries the hint under it', () => {
    const input = h('input', { type: 'text' });
    const field = dialogField('folderNameLabel', input, 'a hint');
    expect(field.tagName).toBe('LABEL');
    expect(field.querySelector('span')?.textContent).toBe('folderNameLabel');
    expect(field.querySelector('.vm-hint')?.textContent).toBe('a hint');
    expect(field.contains(input)).toBe(true);
  });

  it('leaves out the hint paragraph entirely when there is no hint', () => {
    expect(dialogField('folderNameLabel', h('input')).querySelector('.vm-hint')).toBe(null);
  });

  it('substitutes into a localized paragraph', () => {
    expect(dialogText('deleteConfirmHeading', ['7']).textContent).toBe('deleteConfirmHeading');
  });
});
