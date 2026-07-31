/**
 * Modal dialogs, on top of the platform's `<dialog>`.
 *
 * `showModal()` is doing real work here that a hand-rolled overlay would have to reimplement and
 * would get wrong: it traps focus, makes the rest of the page inert to assistive technology,
 * closes on Escape, and restores focus to whatever opened it. Chrome 116 is the floor (D-Chrome),
 * so it is available everywhere this ships.
 *
 * Every dialog in the manager resolves a promise: `null` for "the user backed out", a value for
 * "the user chose". That keeps the call sites linear — `const name = await promptText(…); if
 * (name === null) return;` — instead of scattering the follow-up across callbacks.
 */

import { append, h, msg, type Child } from '../ui/dom.js';

export interface DialogOptions<T> {
  readonly heading: string;
  /** The dialog's body. Built by the caller so each dialog owns its own fields. */
  readonly body: Child[];
  /** Label for the confirming button. Omit for a dialog that only reports something. */
  readonly confirmLabel?: string;
  /**
   * What the confirming button resolves with, or `null` to keep the dialog open — which is how a
   * field that has not been filled in yet refuses to close it.
   */
  readonly onConfirm?: () => T | null;
  /**
   * What to say when `onConfirm` refuses. Called at refusal time, so it can name the actual reason.
   *
   * Not optional in practice, only in the type: a dialog that quietly declines to close is one the
   * user reads as broken, and "nothing happened" is the least useful thing a form can tell anyone.
   */
  readonly invalidMessage?: () => string;
  /** Focus this element once the dialog is open. */
  readonly focus?: HTMLElement;
  /** Style the confirming button as destructive. */
  readonly danger?: boolean;
}

/**
 * Open a modal dialog and resolve with the caller's value, or `null` if it was dismissed.
 *
 * The `<dialog>` is removed from the document on close: a manager session opens a lot of these,
 * and leaving each one parked in the DOM would leave stale form fields behind that a screen reader
 * in browse mode can still walk into.
 */
export function openDialog<T>(options: DialogOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    let outcome: T | null = null;

    // `role="alert"` rather than a bare paragraph: the message appears in response to a keystroke
    // the user has already made, so it has to reach a screen reader without the focus moving to it.
    const complaint = h('p', { class: 'vm-dialog-invalid vm-danger vm-small', role: 'alert' });
    complaint.hidden = true;

    const form = h(
      'form',
      { method: 'dialog', class: 'vm-dialog-form' },
      h('h2', null, options.heading),
      h('div', { class: 'vm-dialog-body' }, ...options.body),
      complaint,
    );

    // The complaint is about a value that no longer exists once the user starts fixing it.
    form.addEventListener('input', () => {
      if (complaint.hidden) return;
      complaint.hidden = true;
      options.focus?.removeAttribute('aria-invalid');
    });

    const cancel = h(
      'button',
      { type: 'button', class: 'vm-button vm-button--quiet vm-button--inline' },
      msg(options.confirmLabel === undefined ? 'dialogClose' : 'dialogCancel'),
    );
    cancel.addEventListener('click', () => {
      dialog.close();
    });

    const buttons: Child[] = [cancel];
    if (options.confirmLabel !== undefined) {
      const confirm = h(
        'button',
        {
          type: 'submit',
          class: `vm-button vm-button--inline${options.danger === true ? ' vm-button--danger' : ''}`,
        },
        options.confirmLabel,
      );
      buttons.push(confirm);
    }
    append(form, h('div', { class: 'vm-dialog-actions' }, ...buttons));

    form.addEventListener('submit', (event) => {
      // The default `method="dialog"` submit closes the dialog before we can refuse: a field that
      // is still empty has to be able to keep it open.
      event.preventDefault();
      const value = options.onConfirm?.() ?? null;
      if (value === null) {
        complaint.textContent = options.invalidMessage?.() ?? msg('dialogInvalid');
        complaint.hidden = false;
        options.focus?.setAttribute('aria-invalid', 'true');
        options.focus?.focus();
        return;
      }
      outcome = value;
      dialog.close();
    });

    const dialog = h('dialog', { class: 'vm-dialog' }, form);
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(outcome);
    });

    document.body.append(dialog);
    dialog.showModal();
    options.focus?.focus();
  });
}

/** A labelled field, the shape every dialog in the manager uses. */
export function dialogField(labelKey: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    'label',
    { class: 'vm-field' },
    h('span', null, msg(labelKey)),
    control,
    hint === undefined ? null : h('p', { class: 'vm-hint vm-small vm-muted' }, hint),
  );
}

export interface Choice<T> {
  readonly label: string;
  readonly value: T;
  readonly danger?: boolean;
}

/**
 * Ask a question whose answers are buttons, with no default.
 *
 * For the questions where every answer is consequential and none of them is safe enough to be
 * preselected — "delete this folder's contents, or keep them?". A radio group with a confirm button
 * would give one of the answers the Enter key, and a dialog with a preselected destructive answer
 * is a dialog people dismiss without reading.
 */
export function chooseDialog<T>(options: {
  readonly heading: string;
  readonly body: Child[];
  readonly choices: readonly Choice<T>[];
}): Promise<T | null> {
  return new Promise((resolve) => {
    let outcome: T | null = null;

    const cancel = h(
      'button',
      { type: 'button', class: 'vm-button vm-button--quiet vm-button--inline' },
      msg('dialogCancel'),
    );
    cancel.addEventListener('click', () => {
      dialog.close();
    });

    const buttons = options.choices.map((choice) => {
      const button = h(
        'button',
        {
          type: 'button',
          class: `vm-button${choice.danger === true ? ' vm-button--danger' : ' vm-button--quiet'}`,
        },
        choice.label,
      );
      button.addEventListener('click', () => {
        outcome = choice.value;
        dialog.close();
      });
      return button;
    });

    const dialog = h(
      'dialog',
      { class: 'vm-dialog' },
      h(
        'div',
        { class: 'vm-dialog-form' },
        h('h2', null, options.heading),
        h('div', { class: 'vm-dialog-body' }, ...options.body),
        h('div', { class: 'vm-choice' }, ...buttons),
        h('div', { class: 'vm-dialog-actions' }, cancel),
      ),
    );
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(outcome);
    });

    document.body.append(dialog);
    dialog.showModal();
    buttons[0]?.focus();
  });
}

/**
 * Ask for one line of text. Resolves `null` when dismissed; a blank answer is refused in place.
 *
 * "Refused in place" rather than "resolves null": a name is required by everything that asks for
 * one, and a dialog that closed on an empty field would have to be reopened by the caller to say
 * so. Emptying the box and pressing Enter says what is wrong and leaves the cursor where it can be
 * fixed.
 */
export async function promptText(options: {
  readonly heading: string;
  readonly labelKey: string;
  readonly confirmLabel: string;
  readonly value?: string;
  readonly hint?: string;
  /** Extra validation beyond "not blank". Returns a message to show, or `null` to accept. */
  readonly validate?: (value: string) => string | null;
}): Promise<string | null> {
  const input = h('input', {
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    value: options.value ?? '',
  });
  let refusal = msg('dialogNameRequired');
  return await openDialog<string>({
    heading: options.heading,
    body: [dialogField(options.labelKey, input, options.hint)],
    confirmLabel: options.confirmLabel,
    focus: input,
    invalidMessage: () => refusal,
    onConfirm: () => {
      const typed = input.value.trim();
      if (typed === '') {
        refusal = msg('dialogNameRequired');
        return null;
      }
      const objection = options.validate?.(typed) ?? null;
      if (objection !== null) {
        refusal = objection;
        return null;
      }
      return typed;
    },
  });
}
