/**
 * The import and export screen.
 *
 * A screen rather than a dialog, for the same reason the conflict view is one: every operation here
 * is consequential, most of them need a paragraph of explanation before the button makes sense, and
 * the native-bookmark picker is a tree of several hundred checkboxes. A modal that has to be
 * dismissed to go and look at something is a modal people dismiss without deciding.
 *
 * Four things it does, in the order it presents them:
 *
 * 1. **Back up** — a `.vmv` under the vault password or one of its own.
 * 2. **Restore** — pick a file, see what is in it, then choose *merge* or *replace*.
 * 3. **Import from this browser** — the optional `bookmarks` permission, a tree with checkboxes,
 *    and then, separately and only if asked for, deleting the originals.
 * 4. **Export as plain HTML** — last, under its own heading, behind the typed gate, because it is
 *    the one thing on this page that undoes the product.
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
import { confirmPlainExport, confirmReplaceImport } from '../ui/export-gate.js';
import { errorText } from '../ui/strings.js';
import { MIN_PASSWORD_LENGTH, passwordLength } from '../crypto/password.js';
import { requestBookmarksPermission } from '../import/native-bookmarks.js';

export interface IoScreenDeps {
  /** The page's live region — outcomes that outlive this screen are announced there. */
  readonly say: (text: string, kind?: 'info' | 'danger') => void;
  readonly onBack: () => void;
  /** Called after anything changed the vault, so the list behind reloads. */
  readonly onVaultChanged: () => void;
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

  append(
    root,
    backupSection(deps),
    restoreSection(deps),
    nativeSection(deps),
    plainSection(deps),
  );
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
    render(slot);
    return;
  }
  render(
    slot,
    h('progress', { max: String(total), value: String(done), 'aria-label': msg('ioWorking') }),
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

function backupSection(deps: IoScreenDeps): HTMLElement {
  return section(
    'ioBackupHeading',
    'ioBackupHint',
    button('ioBackupButton', () => {
      void runBackup(deps);
    }),
  );
}

/**
 * Ask which password the backup should use, then produce it.
 *
 * "My vault password" is the default because a second password is a second thing to lose, and a
 * backup nobody can open is not a backup. It still has to be **typed**: the worker holds the data
 * key, not the password, so there is nothing it could check a silent choice against.
 */
async function runBackup(deps: IoScreenDeps): Promise<void> {
  const chosen = await askExportPassword();
  if (chosen === null) return;

  const response = await send({
    type: 'EXPORT_VAULT',
    password: chosen.password,
    mode: chosen.mode,
  });
  if (response.type === 'ERROR') {
    deps.say(errorText(response.code), 'danger');
    return;
  }
  downloadFile(response.filename, response.mime, response.text);
  deps.say(msg('ioBackupDone', [response.filename]));
}

async function askExportPassword(): Promise<{ password: string; mode: 'vault' | 'custom' } | null> {
  const useVault = h('input', { type: 'radio', name: 'vm-export-pw', id: 'vm-export-pw-vault', checked: true });
  const useOther = h('input', { type: 'radio', name: 'vm-export-pw', id: 'vm-export-pw-other' });
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password', disabled: true });

  const sync = (): void => {
    confirm.disabled = !useOther.checked;
    password.setAttribute(
      'autocomplete',
      useOther.checked ? 'new-password' : 'current-password',
    );
  };
  useVault.addEventListener('change', sync);
  useOther.addEventListener('change', sync);

  let refusal = msg('ioBackupPasswordRequired');
  return await openDialog<{ password: string; mode: 'vault' | 'custom' }>({
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
      dialogField('ioBackupConfirmLabel', confirm, msg('ioBackupConfirmHint')),
      h('p', { class: 'vm-hint vm-small vm-muted' }, msg('ioBackupNoRecovery')),
    ],
    confirmLabel: msg('ioBackupButton'),
    focus: password,
    invalidMessage: () => refusal,
    onConfirm: () => {
      if (password.value === '') {
        refusal = msg('ioBackupPasswordRequired');
        return null;
      }
      if (!useOther.checked) return { password: password.value, mode: 'vault' as const };
      // A custom password is new, so it gets the same floor and the same confirmation field as a
      // new master password. A typo'd backup password is discovered on the day the backup is needed.
      if (passwordLength(password.value) < MIN_PASSWORD_LENGTH) {
        refusal = errorText('PASSWORD_TOO_SHORT');
        return null;
      }
      if (password.value !== confirm.value) {
        refusal = msg('createPasswordsDiffer');
        return null;
      }
      return { password: password.value, mode: 'custom' as const };
    },
  });
}

/* ------------------------------------------------------------------ 2. restore */

function restoreSection(deps: IoScreenDeps): HTMLElement {
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
async function runRestore(deps: IoScreenDeps, file: File, undoSlot: HTMLElement): Promise<void> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    deps.say(msg('ioRestoreUnreadable'), 'danger');
    return;
  }

  const password = await promptImportPassword(file.name);
  if (password === null) return;

  const preview = await send({ type: 'PREVIEW_IMPORT', file: text, password });
  if (preview.type === 'ERROR') {
    deps.say(errorText(preview.code), 'danger');
    return;
  }

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

  const result = await send({ type: 'IMPORT_VAULT', file: text, password, mode });
  if (result.type === 'ERROR') {
    deps.say(errorText(result.code), 'danger');
    return;
  }

  deps.onVaultChanged();
  await paintUndo(deps, undoSlot);
  deps.say(
    result.conflicts > 0
      ? msg('ioImportDoneConflicts', [String(result.added), String(result.conflicts)])
      : msg('ioImportDone', [String(result.added), String(result.total)]),
  );
}

async function promptImportPassword(filename: string): Promise<string | null> {
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  return await openDialog<string>({
    heading: msg('ioRestorePasswordHeading'),
    body: [
      dialogText('ioRestorePasswordIntro', [filename]),
      dialogField('ioRestorePasswordLabel', password),
    ],
    confirmLabel: msg('ioRestoreOpenButton'),
    focus: password,
    invalidMessage: () => msg('ioBackupPasswordRequired'),
    onConfirm: () => (password.value === '' ? null : password.value),
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
  const dated =
    preview.createdAt > 0
      ? msg('ioPreviewCreated', [new Date(preview.createdAt).toLocaleString(), preview.createdBy])
      : msg('ioPreviewCreatedUnknown');

  return await openDialog<'merge' | 'replace'>({
    heading: msg('ioPreviewHeading'),
    body: [
      h(
        'ul',
        { class: 'vm-io-preview' },
        h('li', null, msg('ioPreviewCounts', [String(preview.bookmarks), String(preview.folders)])),
        h('li', null, dated),
        preview.known > 0
          ? h('li', null, msg('ioPreviewKnown', [String(preview.known)]))
          : h('li', null, msg('ioPreviewAllNew')),
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
async function paintUndo(deps: IoScreenDeps, slot: HTMLElement): Promise<void> {
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
          const response = await send({ type: 'ROLLBACK_IMPORT' });
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

function nativeSection(deps: IoScreenDeps): HTMLElement {
  const slot = h('div', { class: 'vm-io-native' });
  void paintNative(deps, slot);
  return section('ioNativeHeading', 'ioNativeHint', slot);
}

async function paintNative(deps: IoScreenDeps, slot: HTMLElement): Promise<void> {
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
  const list = h('div', { class: 'vm-native-tree', role: 'group', 'aria-label': msg('ioNativeHeading') });
  render(list, ...response.nodes.map((node) => nativeRow(node, checked, 0)));

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
        void runNativeDelete(deps, slot, checked);
      }, true),
    ),
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg('ioNativeDeleteHint')),
  );
}

/**
 * One node of the tree, as a checkbox and its children.
 *
 * A plain nested `<div role="group">` of checkboxes rather than an ARIA tree widget: a tree grid
 * brings a keyboard model of its own (arrow-key navigation, expand/collapse semantics) that would
 * have to be implemented and got right, and what this actually is — a list of things with boxes
 * beside them — is already navigable by Tab and readable by every screen reader.
 */
function nativeRow(node: NativeNodeView, checked: Set<string>, depth: number): HTMLElement {
  const id = `vm-native-${node.id}`;
  const box = h('input', {
    type: 'checkbox',
    id,
    onchange: (event: Event) => {
      const on = (event.currentTarget as HTMLInputElement).checked;
      if (on) checked.add(node.id);
      else checked.delete(node.id);
    },
  });

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
  return h(
    'div',
    null,
    row,
    ...node.children.map((child) => nativeRow(child, checked, depth + 1)),
  );
}

async function runNativeImport(
  deps: IoScreenDeps,
  slot: HTMLElement,
  checked: ReadonlySet<string>,
): Promise<void> {
  if (checked.size === 0) {
    deps.say(msg('ioNativeNothingSelected'), 'danger');
    return;
  }
  const response = await send({ type: 'IMPORT_NATIVE', ids: [...checked] });
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
  deps: IoScreenDeps,
  slot: HTMLElement,
  checked: ReadonlySet<string>,
): Promise<void> {
  if (checked.size === 0) {
    deps.say(msg('ioNativeNothingSelected'), 'danger');
    return;
  }
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

  const response = await send({ type: 'DELETE_NATIVE', ids: [...checked] });
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

/* ------------------------------------------------------------------ 4. plain HTML */

function plainSection(deps: IoScreenDeps): HTMLElement {
  return section(
    'ioPlainHeading',
    'ioPlainHint',
    button('ioPlainButton', () => {
      void runPlainExport(deps);
    }, true),
  );
}

async function runPlainExport(deps: IoScreenDeps): Promise<void> {
  const bookmarks = await liveBookmarkCount();
  // The gate first, and the vault is not read until it has been passed.
  if (!(await confirmPlainExport({ bookmarks }))) return;

  const response = await send({ type: 'EXPORT_HTML' });
  if (response.type === 'ERROR') {
    deps.say(errorText(response.code), 'danger');
    return;
  }
  downloadFile(response.filename, response.mime, response.text);
  deps.say(msg('ioPlainDone', [response.filename]), 'danger');
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
