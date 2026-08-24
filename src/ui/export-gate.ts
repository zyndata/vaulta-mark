/**
 * The gate in front of the one import that can lose something.
 *
 * It is here rather than in `src/manager/` for the reason `dialog.ts` is: these are the sentences
 * that decide whether someone understood what they were about to do, and a question asked one way in
 * one window and another way in another is two products. It is callback-free and returns a plain
 * answer, so a call site reads `if (!(await confirmReplaceImport(…))) return;`.
 *
 * **The gate is a typed phrase, not a checkbox.** A checkbox beside a paragraph is a reflex — the
 * hand ticks it while the eye is already on the button. Typing `REPLACE MY VAULT` cannot be done
 * without reading the phrase, and the phrase says what happens. The same reasoning gates vault
 * creation ("there is no recovery") and vault destruction.
 */

import { dialogField, dialogPlural, dialogText, openDialog } from './dialog.js';
import { h, matchesPhrase, msg } from './dom.js';
import { plural } from './plural.js';

export interface ReplaceImportGateOptions {
  /** Bookmarks in the file that would become the vault. */
  readonly incoming: number;
  /** Live bookmarks the vault holds now, and would stop holding. */
  readonly current: number;
  /** Whether a 24-hour undo will be kept. Always true today; stated rather than assumed. */
  readonly undoable: boolean;
}

/**
 * "Replace everything?" — the double confirmation §11 asks for, spelled as two different questions.
 *
 * The first is a typed phrase; the second is the ordinary confirm dialog. Two presses of the same
 * question would only measure persistence. Asking one question the hand cannot answer and one the
 * eye cannot miss measures whether the person meant it.
 */
export async function confirmReplaceImport(options: ReplaceImportGateOptions): Promise<boolean> {
  const phrase = msg('importReplacePhrase');
  const typed = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });

  const first = await openDialog<true>({
    heading: msg('importReplaceHeading'),
    body: [
      h('p', { class: 'vm-notice vm-notice--danger' }, plural('importReplaceWarning', options.current, [
        String(options.current),
        String(options.incoming),
      ])),
      dialogText(options.undoable ? 'importReplaceUndo' : 'importReplaceNoUndo'),
      dialogField('importReplaceConfirmLabel', typed, msg('importReplaceConfirmHint', [phrase])),
    ],
    confirmLabel: msg('importReplaceButton'),
    focus: typed,
    danger: true,
    invalidMessage: () => msg('importReplaceConfirmRefused', [phrase]),
    onConfirm: () => (matchesPhrase(typed.value, phrase) ? true : null),
  });
  if (first !== true) return false;

  const second = await openDialog<true>({
    heading: msg('importReplaceLastHeading'),
    body: [dialogPlural('importReplaceLastBody', options.current, [String(options.current)])],
    confirmLabel: msg('importReplaceLastButton'),
    danger: true,
    onConfirm: () => true,
  });
  return second === true;
}
