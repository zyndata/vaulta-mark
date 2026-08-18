/**
 * Modal dialogs, on top of the platform's `<dialog>` — the project's one way of asking a question.
 *
 * `showModal()` is doing real work here that a hand-rolled overlay would have to reimplement and
 * would get wrong: it traps focus, makes the rest of the page inert to assistive technology,
 * closes on Escape, and restores focus to whatever opened it. Chrome 116 is the floor (D-Chrome),
 * so it is available everywhere this ships.
 *
 * Every dialog resolves a promise: `null` for "the user backed out", a value for "the user chose".
 * That keeps the call sites linear — `const name = await promptText(…); if (name === null) return;`
 * — instead of scattering the follow-up across callbacks.
 *
 * It lives in `src/ui/` rather than in the manager because the popup asks the same questions. A
 * delete confirmed with a modal in one window and with nothing at all in the other is two products,
 * and the one that asks for less is the one people learn the habit from.
 */

import { append, h, msg, type Child } from './dom.js';

export interface DialogOptions<T> {
  readonly heading: string;
  /** The dialog's body. Built by the caller so each dialog owns its own fields. */
  readonly body: Child[];
  /** Label for the confirming button. Omit for a dialog that only reports something. */
  readonly confirmLabel?: string;
  /**
   * What the confirming button resolves with, or `null` to keep the dialog open — which is how a
   * field that has not been filled in yet refuses to close it.
   *
   * It may be async, and that is not a convenience: a password is only known to be wrong once
   * something has tried it, and the answer takes a 600,000-iteration derivation to arrive. A dialog
   * that closed first and reported the failure on the page behind it would make the user reopen it,
   * re-pick the file and retype the password to correct a typo. While the promise is outstanding the
   * dialog stays up with its buttons disabled, so the work cannot be started twice.
   */
  readonly onConfirm?: () => T | null | Promise<T | null>;
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
  /**
   * Answers other than "confirm" and "back out" — each a button that closes the dialog with its own
   * value, without going through `onConfirm`.
   *
   * There for the panels that edit a name and can also throw the thing away. The alternative was a
   * pencil that opens a rename box and a second control somewhere else that deletes, which is two
   * places to learn for one object; the alternative to *that* was `chooseDialog`, which cannot hold
   * a text field. A dialog with one of these is still a dialog with a default answer — Enter renames
   * — and the extra button is a deliberate press, which is what a destructive one should be.
   */
  readonly extraActions?: readonly DialogAction<T>[];
}

export interface DialogAction<T> {
  readonly label: string;
  /** What `openDialog` resolves with when this button is pressed. */
  readonly value: T;
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

    // Shown while an async `onConfirm` is outstanding. Greyed-out buttons say "not now"; they do not
    // say "something is happening", and a 600,000-iteration derivation is a second and a half of a
    // dialog that otherwise looks like it swallowed the press.
    const working = h(
      'p',
      { class: 'vm-dialog-working vm-small vm-muted', role: 'status' },
      h('progress', { 'aria-hidden': 'true' }),
      h('span', null, msg('ioWorking')),
    );
    working.hidden = true;

    const form = h(
      'form',
      { method: 'dialog', class: 'vm-dialog-form' },
      h('h2', null, options.heading),
      h('div', { class: 'vm-dialog-body' }, ...options.body),
      complaint,
      working,
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

    // Leftmost, away from the confirming button at the other end: these are the answers that are
    // neither what the dialog is for nor a way out of it, and a destructive one must not sit under
    // the pointer on its way to Cancel.
    const extras = (options.extraActions ?? []).map((action) => {
      const button = h(
        'button',
        {
          type: 'button',
          class: `vm-button vm-button--inline${action.danger === true ? ' vm-button--danger' : ' vm-button--quiet'}`,
        },
        action.label,
      );
      button.addEventListener('click', () => {
        outcome = action.value;
        dialog.close();
      });
      return button;
    });

    const buttons: HTMLButtonElement[] = [...extras, cancel];
    let confirm: HTMLButtonElement | undefined;
    if (options.confirmLabel !== undefined) {
      confirm = h(
        'button',
        {
          type: 'submit',
          class: `vm-button vm-button--inline${options.danger === true ? ' vm-button--danger' : ''}`,
        },
        options.confirmLabel,
      );
      buttons.push(confirm);
    }
    append(
      form,
      h(
        'div',
        {
          // The split rule works on the pair at the end, so it only applies when there is a pair:
          // with no confirming button the row is one extra and Cancel, which reads fine as it is.
          class: `vm-dialog-actions${extras.length > 0 && confirm !== undefined ? ' vm-dialog-actions--split' : ''}`,
        },
        ...buttons,
      ),
    );

    /** True while an async `onConfirm` is outstanding. One answer at a time. */
    let deciding = false;

    function refuse(): void {
      complaint.textContent = options.invalidMessage?.() ?? msg('dialogInvalid');
      complaint.hidden = false;
      options.focus?.setAttribute('aria-invalid', 'true');
      options.focus?.focus();
    }

    form.addEventListener('submit', (event) => {
      // The default `method="dialog"` submit closes the dialog before we can refuse: a field that
      // is still empty has to be able to keep it open.
      event.preventDefault();
      if (deciding) return;

      const answer = options.onConfirm?.() ?? null;
      if (!(answer instanceof Promise)) {
        if (answer === null) refuse();
        else {
          outcome = answer;
          dialog.close();
        }
        return;
      }

      // The buttons go dead rather than the dialog going away: pressing Enter twice on a slow
      // derivation must not run it twice, and Escape must not close a dialog whose answer is still
      // in flight and about to try to reopen it.
      deciding = true;
      complaint.hidden = true;
      working.hidden = false;
      for (const button of buttons) button.disabled = true;
      void answer
        .then((value) => {
          if (value === null) refuse();
          else {
            outcome = value;
            dialog.close();
          }
        })
        .finally(() => {
          deciding = false;
          working.hidden = true;
          for (const button of buttons) button.disabled = false;
        });
    });

    const dialog = h('dialog', { class: 'vm-dialog' }, form);
    // Escape is the one way out that does not go through a button, so it needs the same guard.
    dialog.addEventListener('cancel', (event) => {
      if (deciding) event.preventDefault();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(outcome);
    });

    document.body.append(dialog);
    dialog.showModal();
    // The caller's field if it named one, and otherwise the confirming button — not Cancel, which is
    // what `showModal` picks on its own for being first in the DOM. With Cancel focused, Enter and
    // Escape both backed out and a question could only be answered with the mouse; Enter answering
    // it is the pairing every other dialog in the platform has. It stays true of a destructive
    // confirmation on purpose: this one is reached by a deliberate Delete, and a delete has eight
    // seconds of undo behind it. A choice with no safe default is not asked here — that is
    // `chooseDialog`, which preselects nothing.
    (options.focus ?? confirm)?.focus();
  });
}

/** A labelled field, the shape every dialog uses. */
export function dialogField(labelKey: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    'label',
    { class: 'vm-field' },
    h('span', null, msg(labelKey)),
    control,
    hint === undefined ? null : h('p', { class: 'vm-hint vm-small vm-muted' }, hint),
  );
}

/**
 * "Are you sure?" — the only spelling of that question in this extension.
 *
 * Resolves `true` when the user confirms and `false` for every other way out, so a call site reads
 * `if (!(await confirmDialog(…))) return;`.
 *
 * The confirming button carries a verb ("Delete"), never "OK": a dialog whose buttons are *Cancel*
 * and *OK* makes the reader reconstruct what OK meant from the sentence above it, and the readers
 * who do not reconstruct it are exactly the ones the dialog is there to stop.
 */
export async function confirmDialog(options: {
  readonly heading: string;
  /** Lines of body copy. Say what will happen, and what will not.  */
  readonly body: Child[];
  readonly confirmLabel: string;
  readonly danger?: boolean;
}): Promise<boolean> {
  const answer = await openDialog<true>({
    heading: options.heading,
    body: options.body,
    confirmLabel: options.confirmLabel,
    onConfirm: () => true,
    ...(options.danger === undefined ? {} : { danger: options.danger }),
  });
  return answer === true;
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
 *
 * `extraActions` widens the answer rather than the option list: with none, `T` infers as `never` and
 * this returns `string | null` exactly as it always has, and with one the caller gets a union it has
 * to discriminate — `typeof answer === 'string'` is the rename, anything else is the other button.
 * A sentinel *string* would have been ambiguous with a folder actually named "delete", which is the
 * kind of bug that surfaces once, in the field, on somebody's real vault.
 */
export async function promptText<T = never>(options: {
  readonly heading: string;
  readonly labelKey: string;
  readonly confirmLabel: string;
  readonly value?: string;
  readonly hint?: string;
  /** Extra validation beyond "not blank". Returns a message to show, or `null` to accept. */
  readonly validate?: (value: string) => string | null;
  /** Answers beside "rename" and "cancel" — see `DialogOptions.extraActions`. */
  readonly extraActions?: readonly DialogAction<T>[];
}): Promise<string | T | null> {
  const input = h('input', {
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    value: options.value ?? '',
  });
  let refusal = msg('dialogNameRequired');
  return await openDialog<string | T>({
    heading: options.heading,
    body: [dialogField(options.labelKey, input, options.hint)],
    confirmLabel: options.confirmLabel,
    focus: input,
    ...(options.extraActions === undefined ? {} : { extraActions: options.extraActions }),
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

/**
 * A paragraph in a dialog body, with `$1`-style substitution done by `_locales`.
 *
 * Here rather than at every call site because a dialog body is the one place in this UI where a
 * bare string is the common case, and `h('p', null, msg(key))` four times in a row reads as
 * structure that is not there.
 */
export function dialogText(key: string, substitutions?: readonly string[]): HTMLElement {
  return h('p', null, msg(key, substitutions));
}
