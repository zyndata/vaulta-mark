/**
 * Import and export, met with an unlocked vault (Phase 8).
 *
 * `src/io/**` and `src/import/**` take their inputs as arguments and can be tested without a
 * service worker; this is where they meet the session, the settings and the clock — the same
 * relationship `items.ts` has to `add.ts`, and `organize.ts` to the vault model.
 *
 * Three rules it exists to keep in one place:
 *
 * - **Every operation goes through `requireVault()`.** There is no export path that works on a
 *   locked vault, and no import path that writes to one.
 * - **Nothing is logged.** A file's contents are the vault, and the failure paths are exactly where
 *   they would end up in a console.
 * - **Progress is broadcast, not returned.** The answer to a five-thousand-bookmark import arrives
 *   seconds after the request; the bar in between is `IO_PROGRESS`.
 */

import {
  broadcast,
  type FileResponse,
  type ImportPreviewResponse,
  type ImportResultResponse,
  type NativeDeleteResponse,
  type NativeImportResponse,
  type NativeNodeView,
  type NativeTreeResponse,
  type RollbackResponse,
} from '../shared/messages.js';
import { scheduleSync } from '../sync/engine.js';
import {
  deleteNative,
  hasBookmarksPermission,
  importNative,
  readNativeTree,
  type NativeNode,
} from '../import/native-bookmarks.js';
import { exportFilename, exportVault, serializeVmv } from '../io/export-encrypted.js';
import {
  applyImport,
  openVmv,
  parseVmv,
  previewOf,
  type ImportMode,
} from '../io/import-encrypted.js';
import { restoreRollback, rollbackOffer } from '../io/rollback.js';
import { requireVault } from './items.js';
import * as session from './session.js';

/** The MIME type the backup is handed to the page with. */
const VMV_MIME = 'application/octet-stream';

/* ------------------------------------------------------------------ exporting */

/**
 * Seal the whole vault into a `.vmv` file.
 *
 * The password is verified against the vault first when the user chose "my vault password". The
 * service worker holds the data key and not the password, so it has no way to know what the vault
 * password is — and a backup sealed under a typo is a backup that fails on the one day it matters.
 * A custom password is confirmed in the UI instead, by being typed twice.
 *
 * Tombstones go in the file (§11): an export that dropped them would resurrect every deleted
 * bookmark the moment it was merge-imported anywhere.
 */
export async function exportEncrypted(
  password: string,
  mode: 'vault' | 'custom',
): Promise<FileResponse> {
  const repo = await requireVault();
  if (mode === 'vault') await repo.verifyPassword(password);
  await session.touch();

  const now = Date.now();
  const file = await exportVault(repo.getAll({ includeDeleted: true }), password, {
    version: chrome.runtime.getManifest().version,
    now: () => now,
    onProgress: (done, total) => {
      void broadcast({ type: 'IO_PROGRESS', job: 'export', done, total });
    },
  });
  return {
    type: 'FILE',
    filename: exportFilename(now),
    mime: VMV_MIME,
    text: serializeVmv(file),
  };
}

/* ------------------------------------------------------------------ importing */

export async function previewImport(
  file: string,
  password: string,
): Promise<ImportPreviewResponse> {
  const repo = await requireVault();
  await session.touch();
  const parsed = parseVmv(file);
  const items = await openVmv(parsed, password);
  return { type: 'IMPORT_PREVIEW', ...previewOf(parsed, items, repo.items()) };
}

/**
 * Apply an import.
 *
 * The file is parsed and decrypted again rather than carried over from the preview. That costs a
 * second 600,000-iteration derivation, and it buys the only correctness property that matters here:
 * an MV3 worker may have been torn down and restarted between the two messages, so anything it
 * remembered is a coin flip. What is applied is what the page holds, every time.
 */
export async function runImport(
  file: string,
  password: string,
  mode: ImportMode,
): Promise<ImportResultResponse> {
  const repo = await requireVault();
  const parsed = parseVmv(file);
  const items = await openVmv(parsed, password);

  const result = await applyImport(repo, items, mode, {
    onProgress: (done, total) => {
      void broadcast({ type: 'IO_PROGRESS', job: 'import', done, total });
    },
  });

  await session.touch();
  await broadcast({ type: 'VAULT_CHANGED' });
  scheduleSync();
  return { type: 'IMPORT_RESULT', ...result };
}

export async function rollbackState(): Promise<RollbackResponse> {
  await requireVault();
  return { type: 'ROLLBACK', ...(await rollbackOffer(Date.now())) };
}

/** Undo the last replace-mode import. Returns how many items the vault holds afterwards. */
export async function undoImport(): Promise<number> {
  const repo = await requireVault();
  const restored = await restoreRollback(repo, Date.now());
  await session.touch();
  await broadcast({ type: 'VAULT_CHANGED' });
  scheduleSync();
  return restored;
}

/* ------------------------------------------------------------------ native bookmarks */

/**
 * Chrome's bookmark tree, or an honest "not granted".
 *
 * Absence of the permission is a state the picker renders — with the button that asks for it — not
 * an error. The page is what can ask: `chrome.permissions.request` needs a user gesture and refuses
 * to run in a service worker at all.
 */
export async function nativeTree(): Promise<NativeTreeResponse> {
  await requireVault();
  await session.touch();
  if (!(await hasBookmarksPermission())) {
    return { type: 'NATIVE_TREE_STATE', granted: false, nodes: [] };
  }
  return { type: 'NATIVE_TREE_STATE', granted: true, nodes: (await readNativeTree()).map(toView) };
}

/** The wire projection: id, title, url, children. `dateAdded` is not rendered, so it does not travel. */
function toView(node: NativeNode): NativeNodeView {
  return {
    id: node.id,
    title: node.title,
    ...(node.url === undefined ? {} : { url: node.url }),
    ...(node.children === undefined ? {} : { children: node.children.map(toView) }),
  };
}

export async function importFromNative(
  ids: readonly string[],
  parentId?: string,
): Promise<NativeImportResponse> {
  const repo = await requireVault();
  const settings = await session.settings();
  const nodes = await readNativeTree();

  const result = await importNative(repo, nodes, ids, {
    stripTrackingParams: settings.stripTrackingParams,
    ...(parentId === undefined ? {} : { parentId }),
    onProgress: (done, total) => {
      void broadcast({ type: 'IO_PROGRESS', job: 'native', done, total });
    },
  });

  await session.touch();
  if (result.bookmarks > 0 || result.folders > 0) {
    await broadcast({ type: 'VAULT_CHANGED' });
    scheduleSync();
  }
  return { type: 'NATIVE_IMPORT', ...result };
}

/**
 * Delete native bookmarks — the separate, explicitly confirmed second step (INV-5).
 *
 * It requires an unlocked vault even though it touches no vault data. That is not a technical
 * requirement; it is the same one the rest of the manager has, and "delete four hundred of this
 * profile's bookmarks" should not be reachable from a locked window.
 */
export async function deleteFromNative(ids: readonly string[]): Promise<NativeDeleteResponse> {
  await requireVault();
  await session.touch();
  return { type: 'NATIVE_DELETE', ...(await deleteNative(ids)) };
}
