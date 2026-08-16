/**
 * The import and export screen.
 *
 * A screen rather than a dialog, for the same reason the conflict view is one: every operation here
 * is consequential, most of them need a paragraph of explanation before the button makes sense, and
 * the native-bookmark picker is a tree of several hundred checkboxes. A modal that has to be
 * dismissed to go and look at something is a modal people dismiss without deciding.
 *
 * Three things it does, in the order it presents them:
 *
 * 1. **Back up** — a `.vmv` under the vault password or one of its own.
 * 2. **Restore** — pick a file, see what is in it, then choose *merge* or *replace*.
 * 3. **Import from this browser** — the optional `bookmarks` permission, a tree with checkboxes,
 *    and then, separately and only if asked for, deleting the originals.
 *
 * The file is handed over with an object URL and a synthetic `<a download>` click. That is why
 * VaultaMark needs no `downloads` permission (INV-9) — and why the URL is revoked immediately
 * afterwards, since an object URL is a live handle to a decrypted copy of the vault.
 */

import {
  send,
  type ImportPreviewResponse,
  type NativeNodeView,
} from '../shared/messages.js';
import { confirmDialog, dialogField, dialogText, openDialog } from '../ui/dialog.js';
import { append, h, msg, render } from '../ui/dom.js';
import { confirmReplaceImport } from '../ui/export-gate.js';
import { errorText } from '../ui/strings.js';
import { MIN_PASSWORD_LENGTH, passwordLength } from '../crypto/password.js';
import { requestBookmarksPermission, topmostSelection } from '../import/native-bookmarks.js';

export interface IoScreenDeps {
  /** The page's live region — outcomes that outlive this screen are announced there. */
  readonly say: (text: string, kind?: 'info' | 'danger') => void;
  readonly onBack: () => void;
  /** Called after anything changed the vault, so the list behind reloads. */
  readonly onVaultChanged: () => void;
  /**
   * Go and settle the disagreements an import produced.
   *
   * A merge that finds the same bookmark changed on both sides leaves conflicts, and the screen that
   * settles them is somewhere else entirely. Announcing the number and leaving the reader on this
   * page makes them find that screen for themselves, having been told there is something wrong.
   */
  readonly onConflicts: () => void;
}

/** Everything the screen's own sections get: the caller's callbacks, plus its busy indicator. */
interface Io extends IoScreenDeps {
  /** Run something slow with the bar up. Nested calls keep one bar; see {@link busyRunner}. */
  readonly busy: <T>(run: () => Promise<T>) => Promise<T>;
}

/** Build the screen. Everything it needs it asks for; nothing is passed in but callbacks. */
export function ioScreen(deps: IoScreenDeps): HTMLElement {
  const progress = h('div', { class: 'vm-io-progress' });
  const root = h(
    'section',
    { class: 'vm-io', 'aria-label': msg('ioHeading') },
    h(
      'div',
      { class: 'vm-io-head' },
      h('h2', null, msg('ioHeading')),
      h(
        'button',
        { type: 'button', class: 'vm-button vm-button--inline', onclick: deps.onBack },
        msg('ioBack'),
      ),
    ),
    progress,
  );

  const io: Io = { ...deps, busy: busyRunner(progress) };
  append(root, backupSection(io), restoreSection(io), nativeSection(io));
  return root;
}

/**
 * Show how far a long job has got.
 *
 * Driven by the worker's `IO_PROGRESS` broadcast rather than by anything measured here: the work is
 * in the service worker, and a bar the page animates on its own is a lie about somebody's data.
 */
export function paintProgress(root: HTMLElement, done: number, total: number): void {
  const slot = root.querySelector<HTMLElement>('.vm-io-progress');
  if (slot === null) return;
  if (total <= 0 || done >= total) {
    idle(slot);
    return;
  }
  render(
    slot,
    h('progress', { max: String(total), value: String(done), 'aria-label': msg('ioWorking') }),
    h('span', { class: 'vm-small vm-muted' }, msg('ioWorking')),
  );
}

/**
 * Something is happening, and there is nothing to say about how far along it is.
 *
 * A merge import spends its first second and a half in a 600,000-iteration derivation, before there
 * is a single item to count — and `IO_PROGRESS` cannot report on work that has not started. Without
 * this the screen sat still through it: the dialog closed, nothing changed, and then some time later
 * the answer arrived. A bar with no value is the honest shape for that: it says *working*, and it
 * does not invent a number.
 *
 * Handed over to the real, counted bar the moment the worker has something to count.
 */
function busyRunner(slot: HTMLElement): <T>(run: () => Promise<T>) => Promise<T> {
  // Depth rather than a boolean: a restore is several requests deep and the bar must not blink out
  // between two of them.
  let depth = 0;
  return async <T,>(run: () => Promise<T>): Promise<T> => {
    depth += 1;
    slot.dataset['busy'] = 'true';
    idle(slot);
    try {
      return await run();
    } finally {
      depth -= 1;
      if (depth === 0) {
        delete slot.dataset['busy'];
        render(slot);
      }
    }
  };
}

/** What the slot shows when nothing is being counted: the indeterminate bar, or nothing at all. */
function idle(slot: HTMLElement): void {
  if (slot.dataset['busy'] !== 'true') {
    render(slot);
    return;
  }
  render(
    slot,
    h('progress', { 'aria-label': msg('ioWorking') }),
    h('span', { class: 'vm-small vm-muted' }, msg('ioWorking')),
  );
}

function section(headingKey: string, hintKey: string, ...children: HTMLElement[]): HTMLElement {
  return h(
    'section',
    { class: 'vm-io-section' },
    h('h3', null, msg(headingKey)),
    h('p', { class: 'vm-small vm-muted' }, msg(hintKey)),
    ...children,
  );
}

function button(labelKey: string, onClick: () => void, danger = false): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: `vm-button vm-button--inline${danger ? ' vm-button--danger' : ''}`,
      onclick: onClick,
    },
    msg(labelKey),
  );
}

/* ------------------------------------------------------------------ 1. backup */

function backupSection(deps: Io): HTMLElement {
  return section(
    'ioBackupHeading',
    'ioBackupHint',
    button('ioBackupButton', () => {
      void runBackup(deps);
    }),
  );
}

/**
 * Ask which password the backup should use, and produce it **without closing the question**.
 *
 * "My vault password" is the default because a second password is a second thing to lose, and a
 * backup nobody can open is not a backup. It still has to be **typed**: the worker holds the data
 * key, not the password, so there is nothing it could check a silent choice against — which means
 * the one answer that can be wrong is only found to be wrong after the worker has tried it. So the
 * sealing happens *inside* `onConfirm`: a mistyped password is a complaint under the field that is
 * still on screen with the cursor in it, not a red line on the page behind a dialog that has gone.
 */
async function runBackup(deps: Io): Promise<void> {
  const file = await askExportPassword();
  if (file === null) return;
  downloadFile(file.filename, file.mime, file.text);
  deps.say(msg('ioBackupDone', [file.filename]));
}

/** What a completed backup hands back: exactly the fields `downloadFile` needs. */
interface BackupFile {
  readonly filename: string;
  readonly mime: string;
  readonly text: string;
}

async function askExportPassword(): Promise<BackupFile | null> {
  const useVault = h('input', { type: 'radio', name: 'vm-export-pw', id: 'vm-export-pw-vault', checked: true });
  const useOther = h('input', { type: 'radio', name: 'vm-export-pw', id: 'vm-export-pw-other' });
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password' });
  const confirmField = dialogField('ioBackupConfirmLabel', confirm, msg('ioBackupConfirmHint'));

  // Hidden rather than disabled while the vault's own password is being used. A disabled box is
  // still a box, and a form that shows a field nobody may fill in is asking a question it has
  // already answered — the field belongs to "use a different password" and appears with it.
  const sync = (): void => {
    confirmField.hidden = !useOther.checked;
    if (!useOther.checked) confirm.value = '';
    password.setAttribute('autocomplete', useOther.checked ? 'new-password' : 'current-password');
  };
  useVault.addEventListener('change', sync);
  useOther.addEventListener('change', sync);
  sync();

  let refusal = msg('ioBackupPasswordRequired');
  return await openDialog<BackupFile>({
    heading: msg('ioBackupHeading'),
    body: [
      dialogText('ioBackupPasswordIntro'),
      h(
        'div',
        { class: 'vm-checkbox' },
        useVault,
        h('label', { for: 'vm-export-pw-vault' }, msg('ioBackupUseVaultPassword')),
      ),
      h(
        'div',
        { class: 'vm-checkbox' },
        useOther,
        h('label', { for: 'vm-export-pw-other' }, msg('ioBackupUseOtherPassword')),
      ),
      dialogField('ioBackupPasswordLabel', password),
      confirmField,
      h('p', { class: 'vm-hint vm-small vm-muted' }, msg('ioBackupNoRecovery')),
    ],
    confirmLabel: msg('ioBackupButton'),
    focus: password,
    invalidMessage: () => refusal,
    onConfirm: async () => {
      if (password.value === '') {
        refusal = msg('ioBackupPasswordRequired');
        return null;
      }
      // A custom password is new, so it gets the same floor and the same confirmation field as a
      // new master password. A typo'd backup password is discovered on the day the backup is needed.
      if (useOther.checked) {
        if (passwordLength(password.value) < MIN_PASSWORD_LENGTH) {
          refusal = errorText('PASSWORD_TOO_SHORT');
          return null;
        }
        if (password.value !== confirm.value) {
          refusal = msg('createPasswordsDiffer');
          return null;
        }
      }

      const response = await send({
        type: 'EXPORT_VAULT',
        password: password.value,
        mode: useOther.checked ? 'custom' : 'vault',
      });
      if (response.type === 'ERROR') {
        refusal = errorText(response.code);
        return null;
      }
      return { filename: response.filename, mime: response.mime, text: response.text };
    },
  });
}

/* ------------------------------------------------------------------ 2. restore */

function restoreSection(deps: Io): HTMLElement {
  const picker = h('input', { type: 'file', accept: '.vmv,application/json', class: 'vm-file' });
  const undoSlot = h('div', { class: 'vm-io-undo' });

  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (file === undefined) return;
    void runRestore(deps, file, undoSlot);
  });

  void paintUndo(deps, undoSlot);
  return section(
    'ioRestoreHeading',
    'ioRestoreHint',
    h('label', { class: 'vm-field' }, h('span', null, msg('ioRestoreFileLabel')), picker),
    undoSlot,
  );
}

/**
 * The whole restore flow: read, ask for the password, preview, choose a mode, apply.
 *
 * The preview is not optional and not skippable. An import is the one operation whose input came
 * from outside the extension entirely, and "N bookmarks, M folders, from this date" is the only
 * chance anyone gets to notice they picked last year's backup.
 */
async function runRestore(deps: Io, file: File, undoSlot: HTMLElement): Promise<void> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    deps.say(msg('ioRestoreUnreadable'), 'danger');
    return;
  }

  const opened = await promptImportPassword(file.name, text);
  if (opened === null) return;
  const { password, preview } = opened;

  const mode = await chooseImportMode(preview);
  if (mode === null) return;

  if (mode === 'replace') {
    const confirmed = await confirmReplaceImport({
      incoming: preview.bookmarks,
      current: await liveBookmarkCount(),
      undoable: true,
    });
    if (!confirmed) return;
  }

  const result = await deps.busy(async () =>
    await send({ type: 'IMPORT_VAULT', file: text, password, mode }),
  );
  if (result.type === 'ERROR') {
    deps.say(errorText(result.code), 'danger');
    return;
  }

  deps.onVaultChanged();
  await paintUndo(deps, undoSlot);

  // Straight to the screen that settles them, rather than a number on a page that cannot act on it.
  // The announcement still happens, because the live region is what a screen reader hears and the
  // navigation is not something it would otherwise be told about.
  if (result.conflicts > 0) {
    deps.say(msg('ioImportDoneConflicts', [String(result.added), String(result.conflicts)]));
    deps.onConflicts();
    return;
  }
  deps.say(msg('ioImportDone', [String(result.added), String(result.total)]));
}

/**
 * Ask for the file's password and open it, in one dialog.
 *
 * The decryption is done **inside** `onConfirm` rather than after it, so a wrong password is a
 * complaint under the field it was typed into. Closing first and reporting on the page behind would
 * cost the user the file they picked as well as the password they mistyped: the `<input type=file>`
 * is cleared on change, so correcting a typo would mean choosing the backup again.
 *
 * The password comes back alongside the preview because the apply step needs it: `IMPORT_VAULT`
 * re-reads and re-decrypts the file rather than trusting anything the worker remembered, since an
 * MV3 worker may have been torn down between the two messages.
 */
async function promptImportPassword(
  filename: string,
  text: string,
): Promise<{ password: string; preview: ImportPreviewResponse } | null> {
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  let refusal = msg('ioBackupPasswordRequired');
  return await openDialog<{ password: string; preview: ImportPreviewResponse }>({
    heading: msg('ioRestorePasswordHeading'),
    body: [
      dialogText('ioRestorePasswordIntro', [filename]),
      dialogField('ioRestorePasswordLabel', password),
    ],
    confirmLabel: msg('ioRestoreOpenButton'),
    focus: password,
    invalidMessage: () => refusal,
    onConfirm: async () => {
      if (password.value === '') {
        refusal = msg('ioBackupPasswordRequired');
        return null;
      }
      const preview = await send({ type: 'PREVIEW_IMPORT', file: text, password: password.value });
      if (preview.type === 'ERROR') {
        refusal = errorText(preview.code);
        return null;
      }
      return { password: password.value, preview };
    },
  });
}

/**
 * What is in the file, and what to do with it.
 *
 * Two buttons with no default, like the folder-delete question: one of the answers replaces the
 * vault, and a dialog with a preselected destructive answer is one people dismiss with Enter.
 */
async function chooseImportMode(
  preview: ImportPreviewResponse,
): Promise<'merge' | 'replace' | null> {
  // A sync file is the live vault as Drive holds it, not a snapshot somebody chose to take: it has a
  // "last changed" and no author, so it gets its own sentence rather than being squeezed into the
  // backup's. Calling it a backup would be describing an object the user never made.
  const dated =
    preview.origin === 'sync'
      ? preview.createdAt > 0
        ? msg('ioPreviewSynced', [new Date(preview.createdAt).toLocaleString()])
        : msg('ioPreviewSyncedUnknown')
      : preview.createdAt > 0
        ? msg('ioPreviewCreated', [new Date(preview.createdAt).toLocaleString(), preview.createdBy])
        : msg('ioPreviewCreatedUnknown');

  return await openDialog<'merge' | 'replace'>({
    heading: msg(preview.origin === 'sync' ? 'ioPreviewSyncHeading' : 'ioPreviewHeading'),
    body: [
      h(
        'ul',
        { class: 'vm-io-preview' },
        h('li', null, countsLine(preview.bookmarks, preview.folders)),
        h('li', null, dated),
        h('li', null, knownLine(preview.known)),
      ),
      dialogText('ioPreviewMergeExplained'),
      dialogText('ioPreviewReplaceExplained'),
      modeChoice(),
    ],
    confirmLabel: msg('ioPreviewApply'),
    invalidMessage: () => msg('ioPreviewPickMode'),
    onConfirm: () => {
      const picked = document.querySelector<HTMLInputElement>('input[name="vm-import-mode"]:checked');
      const value = picked?.value;
      return value === 'merge' || value === 'replace' ? value : null;
    },
  });
}

/**
 * "412 bookmarks in 19 folders", agreeing with both of its own numbers.
 *
 * Six whole sentences rather than a stem and a pluralized suffix, which is the shape the rest of
 * this project already uses (`listCountOneBookmark`, `movedOne`, `conflictResolvedOne`). A sentence
 * assembled at runtime out of fragments is one no translator can reorder, and the languages this
 * will eventually be read in do not all put the numbers where English does — or agree on how many
 * plural forms there are. Two counts in one sentence means enumerating the combinations; there are
 * only six, and each is legible on its own in the file.
 *
 * "No folders" is its own pair rather than `$FOLDERS$ folders` with a zero in it: "2 bookmarks in
 * 0 folders" is grammatical and reads like a machine wrote it, which is not what someone about to
 * replace their vault wants to be reading.
 *
 * Exported for the sake of the test that pins which key each combination picks. A wrong key here
 * renders as an empty string, which reads as a preview line that simply is not there.
 */
export function countsLine(bookmarks: number, folders: number): string {
  const counts = [String(bookmarks), String(folders)];
  if (folders === 0) {
    const key = bookmarks === 1 ? 'ioPreviewCountsOneNoFolders' : 'ioPreviewCountsNoFolders';
    return msg(key, [String(bookmarks)]);
  }
  if (bookmarks === 1 && folders === 1) return msg('ioPreviewCountsOneEach', counts);
  if (bookmarks === 1) return msg('ioPreviewCountsOneBookmark', counts);
  if (folders === 1) return msg('ioPreviewCountsOneFolder', counts);
  return msg('ioPreviewCounts', counts);
}

/** How much of the file this vault already holds — "none", "one", or a number. */
export function knownLine(known: number): string {
  if (known === 0) return msg('ioPreviewAllNew');
  if (known === 1) return msg('ioPreviewKnownOne');
  return msg('ioPreviewKnown', [String(known)]);
}

/** The two modes as radios with **neither** preselected — the choice has no safe default. */
function modeChoice(): HTMLElement {
  const option = (value: 'merge' | 'replace', labelKey: string): HTMLElement => {
    const id = `vm-import-mode-${value}`;
    return h(
      'div',
      { class: 'vm-checkbox' },
      h('input', { type: 'radio', name: 'vm-import-mode', id, value }),
      h('label', { for: id }, msg(labelKey)),
    );
  };
  return h('div', null, option('merge', 'ioModeMerge'), option('replace', 'ioModeReplace'));
}

/** How many bookmarks a replace would displace. Read from the tree rather than guessed. */
async function liveBookmarkCount(): Promise<number> {
  const tree = await send({ type: 'GET_TREE' });
  return tree.type === 'ERROR' ? 0 : tree.total;
}

/** The 24-hour undo, shown only while there is one. */
async function paintUndo(deps: Io, slot: HTMLElement): Promise<void> {
  const state = await send({ type: 'GET_ROLLBACK' });
  if (state.type === 'ERROR' || !state.available) {
    render(slot);
    return;
  }
  render(
    slot,
    h(
      'div',
      { class: 'vm-notice' },
      h(
        'span',
        null,
        msg('ioUndoAvailable', [
          state.expiresAt === null ? '' : new Date(state.expiresAt).toLocaleString(),
        ]),
      ),
      button('ioUndoButton', () => {
        void (async () => {
          const confirmed = await confirmDialog({
            heading: msg('ioUndoHeading'),
            body: [dialogText('ioUndoBody')],
            confirmLabel: msg('ioUndoButton'),
            danger: true,
          });
          if (!confirmed) return;
          const response = await deps.busy(async () => await send({ type: 'ROLLBACK_IMPORT' }));
          if (response.type === 'ERROR') {
            deps.say(errorText(response.code), 'danger');
            return;
          }
          deps.onVaultChanged();
          await paintUndo(deps, slot);
          deps.say(msg('ioUndoDone'));
        })();
      }),
    ),
  );
}

/* ------------------------------------------------------------------ 3. this browser's bookmarks */

function nativeSection(deps: Io): HTMLElement {
  const slot = h('div', { class: 'vm-io-native' });
  void paintNative(deps, slot);
  return section('ioNativeHeading', 'ioNativeHint', slot);
}

async function paintNative(deps: Io, slot: HTMLElement): Promise<void> {
  const response = await send({ type: 'NATIVE_TREE' });
  if (response.type === 'ERROR') {
    render(slot, h('p', { class: 'vm-small vm-danger' }, errorText(response.code)));
    return;
  }
  if (!response.granted) {
    render(
      slot,
      h('p', { class: 'vm-small vm-muted' }, msg('ioNativePermissionExplained')),
      button('ioNativeGrantButton', () => {
        void (async () => {
          // Requested here, in the page, during the click: `chrome.permissions.request` needs a
          // user gesture and refuses to run in a service worker at all.
          const granted = await requestBookmarksPermission();
          if (granted) await paintNative(deps, slot);
          else deps.say(msg('ioNativePermissionRefused'), 'danger');
        })();
      }),
    );
    return;
  }

  const checked = new Set<string>();
  const list = nativeTree(response.nodes, checked);

  render(
    slot,
    list,
    h(
      'div',
      { class: 'vm-io-actions' },
      button('ioNativeImportButton', () => {
        void runNativeImport(deps, slot, checked);
      }),
      button('ioNativeDeleteButton', () => {
        void runNativeDelete(deps, slot, response.nodes, checked);
      }, true),
    ),
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg('ioNativeDeleteHint')),
  );
}

/**
 * The tree of checkboxes, with a folder's box speaking for the folder's contents.
 *
 * Ticking a folder has always imported everything inside it — `expandSelection` in
 * `import/native-bookmarks.ts` closes the selection downward, and has since Phase 8. What it did not
 * do was *say* so: the children's boxes stayed empty, so the only way to find out whether a folder
 * meant "this folder" or "this folder and its 40 bookmarks" was to import it and count. The boxes now
 * show what the import will do, which is all that changed — no selection means anything different
 * than it did before.
 *
 * A folder with some of its contents ticked is **indeterminate and not itself checked**, and the two
 * halves of that matter separately. Indeterminate is the honest picture; not-checked is load-bearing,
 * because a folder in the set is a folder whose whole subtree comes along, and a half-ticked one
 * would quietly bring back the rows the user had just unticked. Its ancestors are imported anyway —
 * `expandSelection` closes upward too, so a bookmark never lands flattened at the top level.
 *
 * Still a plain nested `<div role="group">` of checkboxes rather than an ARIA tree widget: a tree
 * brings a keyboard model of its own (arrow-key navigation, expand and collapse) that would have to
 * be implemented and got right, and what this actually is — a list of things with boxes beside them —
 * is already navigable by Tab and readable by every screen reader. A half-ticked folder is announced
 * as "mixed" by the checkbox itself, which is the whole reason `indeterminate` exists.
 *
 * Exported for the test that drives the tri-state bookkeeping. The alternative was an E2E, and there
 * cannot be one: the picker only exists once the optional `bookmarks` permission is granted, and
 * `chrome.permissions.request` answers with a browser-level prompt no automated context can accept
 * (DEVELOPMENT §5.2).
 */
export function nativeTree(nodes: readonly NativeNodeView[], checked: Set<string>): HTMLElement {
  const boxes = new Map<string, HTMLInputElement>();
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, readonly string[]>();

  /** Tick or untick this node and everything under it. */
  const cascade = (id: string, on: boolean): void => {
    const box = boxes.get(id);
    if (box !== undefined) {
      box.checked = on;
      box.indeterminate = false;
    }
    if (on) checked.add(id);
    else checked.delete(id);
    for (const child of childrenOf.get(id) ?? []) cascade(child, on);
  };

  /** Re-read this node's children and say what its own box should look like, then its parent's. */
  const reconcile = (id: string): void => {
    const box = boxes.get(id);
    const children = childrenOf.get(id) ?? [];
    if (box === undefined || children.length === 0) return;
    const all = children.every((child) => boxes.get(child)?.checked === true);
    const some = children.some(
      (child) => boxes.get(child)?.checked === true || boxes.get(child)?.indeterminate === true,
    );
    box.checked = all;
    box.indeterminate = !all && some;
    if (all) checked.add(id);
    else checked.delete(id);
    const parent = parentOf.get(id);
    if (parent !== undefined) reconcile(parent);
  };

  const rowsOf = (list: readonly NativeNodeView[], parentId: string | null, depth: number): HTMLElement[] =>
    list.map((node) => {
      if (parentId !== null) parentOf.set(node.id, parentId);
      childrenOf.set(node.id, (node.children ?? []).map((child) => child.id));

      const id = `vm-native-${node.id}`;
      const box = h('input', {
        type: 'checkbox',
        id,
        onchange: (event: Event) => {
          cascade(node.id, (event.currentTarget as HTMLInputElement).checked);
          const parent = parentOf.get(node.id);
          if (parent !== undefined) reconcile(parent);
        },
      });
      boxes.set(node.id, box);

      const row = h(
        'div',
        { class: 'vm-native-row', style: `--vm-native-depth: ${String(depth)}` },
        h(
          'div',
          { class: 'vm-checkbox' },
          box,
          h(
            'label',
            { for: id },
            // Text, never markup: a bookmark title came from a web page and is hostile by default.
            node.title === '' ? msg('ioNativeUntitled') : node.title,
          ),
        ),
        node.url === undefined
          ? null
          : h('span', { class: 'vm-native-url vm-small vm-muted' }, node.url),
      );

      if (node.children === undefined || node.children.length === 0) return row;
      return h('div', null, row, ...rowsOf(node.children, node.id, depth + 1));
    });

  const tree = h('div', {
    class: 'vm-native-tree',
    role: 'group',
    'aria-label': msg('ioNativeHeading'),
  });
  render(tree, ...rowsOf(nodes, null, 0));
  return tree;
}

async function runNativeImport(
  deps: Io,
  slot: HTMLElement,
  checked: ReadonlySet<string>,
): Promise<void> {
  if (checked.size === 0) {
    deps.say(msg('ioNativeNothingSelected'), 'danger');
    return;
  }
  const response = await deps.busy(async () =>
    await send({ type: 'IMPORT_NATIVE', ids: [...checked] }),
  );
  if (response.type === 'ERROR') {
    deps.say(errorText(response.code), 'danger');
    return;
  }
  deps.onVaultChanged();
  deps.say(
    msg('ioNativeImported', [
      String(response.bookmarks),
      String(response.folders),
      String(response.duplicates + response.skipped),
    ]),
  );
  // Repainted so the *next* thing offered — deleting the originals — is asked for against a tree the
  // user is looking at rather than one they have already acted on.
  await paintNative(deps, slot);
}

/**
 * Delete the native copies. The second step, and the one that actually empties the omnibox.
 *
 * Its own button, its own confirmation, and a summary of exactly what goes. Nothing here is reached
 * as a side effect of an import: copying a bookmark into the vault and removing it from Chrome are
 * two separate decisions, and only the second one is irreversible.
 */
async function runNativeDelete(
  deps: Io,
  slot: HTMLElement,
  nodes: readonly NativeNodeView[],
  checked: ReadonlySet<string>,
): Promise<void> {
  if (checked.size === 0) {
    deps.say(msg('ioNativeNothingSelected'), 'danger');
    return;
  }
  // Whole subtrees, named once each: `deleteNative` calls `removeTree`, so asking it for a folder
  // *and* the children that folder took with it is asking it to delete things that are already gone
  // — and it counts every one of those as a failure it could not explain.
  const ids = topmostSelection(nodes, checked);
  const confirmed = await confirmDialog({
    heading: msg('ioNativeDeleteHeading', [String(checked.size)]),
    body: [
      dialogText('ioNativeDeleteBody', [String(checked.size)]),
      dialogText('ioNativeDeleteWhy'),
      dialogText('ioNativeDeleteNoUndo'),
    ],
    confirmLabel: msg('ioNativeDeleteConfirm'),
    danger: true,
  });
  if (!confirmed) return;

  const response = await deps.busy(async () => await send({ type: 'DELETE_NATIVE', ids }));
  if (response.type === 'ERROR') {
    deps.say(errorText(response.code), 'danger');
    return;
  }
  deps.say(
    response.failed === 0
      ? msg('ioNativeDeleted', [String(response.removed)])
      : msg('ioNativeDeletedPartial', [String(response.removed), String(response.failed)]),
  );
  await paintNative(deps, slot);
}

/* ------------------------------------------------------------------ delivery */

/**
 * Hand a file to the user without the `downloads` permission (§11).
 *
 * The object URL is revoked in the same turn the click happens. It is a live handle to a decrypted
 * copy of the vault held in this page's memory, and leaving one alive for the lifetime of the
 * document means the vault is readable from the address bar long after the download finished.
 */
export function downloadFile(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = h('a', { href: url, download: filename });
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
