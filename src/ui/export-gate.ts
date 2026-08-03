/**
 * The gates in front of the two exports that can lose something.
 *
 * Both are here rather than in `src/manager/` for the reason `dialog.ts` is: these are the sentences
 * that decide whether someone understood what they were about to do, and a question asked one way in
 * one window and another way in another is two products. They are callback-free and return a plain
 * answer, so a call site reads `if (!(await confirmPlainExport(…))) return;`.
 *
 * **The plaintext export gate is a typed phrase, not a checkbox.** A checkbox beside a paragraph is
 * a reflex — the hand ticks it while the eye is already on the button. Typing `EXPORT UNENCRYPTED`
 * cannot be done without reading the phrase, and the phrase says what the file is. The same
 * reasoning gates vault creation ("there is no recovery") and vault destruction, and it is the only
 * gate in this project that has ever been asked for twice.
 */

import { PLAIN_EXPORT_PHRASE } from '../io/export-html.js';
import { dialogField, dialogText, openDialog } from './dialog.js';
import { h, matchesPhrase, msg } from './dom.js';

export interface PlainExportGateOptions {
  /** How many bookmarks the file would list. Named in the warning: a number is harder to skim past. */
  readonly bookmarks: number;
}

/**
 * "This file is not encrypted." Resolves `true` only when the phrase has been typed.
 *
 * Three statements, in the order that matters: what the file contains, who can read it, and what
 * importing it into a browser undoes. The last one is the one people have not thought about — it is
 * the whole premise of the product, running backwards.
 */
export async function confirmPlainExport(options: PlainExportGateOptions): Promise<boolean> {
  const typed = h('input', {
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'vm-plain-export-hint',
  });

  const answer = await openDialog<true>({
    heading: msg('exportPlainHeading'),
    body: [
      h('p', { class: 'vm-notice vm-notice--danger' }, msg('exportPlainWarningUnencrypted')),
      dialogText('exportPlainWarningReadable', [String(options.bookmarks)]),
      dialogText('exportPlainWarningOmnibox'),
      dialogField(
        'exportPlainConfirmLabel',
        typed,
        msg('exportPlainConfirmHint', [PLAIN_EXPORT_PHRASE]),
      ),
    ],
    confirmLabel: msg('exportPlainButton'),
    focus: typed,
    danger: true,
    invalidMessage: () => msg('exportPlainConfirmRefused', [PLAIN_EXPORT_PHRASE]),
    // `matchesPhrase` forgives case and spacing, deliberately: the gate exists to make someone read
    // the sentence, not to test their typing. Being fussy here only teaches people the box is broken.
    onConfirm: () => (matchesPhrase(typed.value, PLAIN_EXPORT_PHRASE) ? true : null),
  });
  return answer === true;
}

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
      h('p', { class: 'vm-notice vm-notice--danger' }, msg('importReplaceWarning', [
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
    body: [dialogText('importReplaceLastBody', [String(options.current)])],
    confirmLabel: msg('importReplaceLastButton'),
    danger: true,
    onConfirm: () => true,
  });
  return second === true;
}
