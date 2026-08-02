/**
 * Service-worker entry point.
 *
 * MV3 terminates this worker after roughly 30 seconds of inactivity and restarts it on the next
 * event, so this file obeys two rules absolutely:
 *
 * - **Every listener is registered during the initial evaluation**, synchronously. An event that
 *   wakes a dead worker is only delivered to listeners that existed before the first `await`;
 *   registering from a promise produces a handler that works in development and silently misses
 *   the first event in the field.
 * - **Top-level code does nothing else.** No key derivation, no decryption, no storage read. The
 *   cold-start budget to the first handled message is 50 ms (ARCHITECTURE §7.2), and everything
 *   expensive is reached lazily through `session.ts`.
 *
 * It holds no state of its own. The unlocked key lives in `chrome.storage.session` under
 * `session.ts`; this file only routes.
 */

import { CorruptVaultError, UnsupportedSchemaError, WrongPasswordError } from '../crypto/errors.js';
import {
  broadcast,
  onRequest,
  type ErrorCode,
  type Request,
  type Response,
} from '../shared/messages.js';
import {
  InvalidMutationError,
  ItemNotFoundError,
  UnsupportedUrlError,
  VaultLockedError,
  VaultStateError,
  WeakPasswordError,
} from '../vault/errors.js';
import { NoActiveTabError } from './add.js';
import { armHousekeeping, registerLifecycleListeners } from './autolock.js';
import { clearBadge, flashBadge, type BadgeKind } from './badge.js';
import { registerCommandListener } from './commands.js';
import { installContextMenus, registerContextMenuListener } from './contextmenu.js';
import * as items from './items.js';
import * as organize from './organize.js';
import * as session from './session.js';
import * as syncing from './syncing.js';
import { configureSync, scheduleSync, syncNow } from '../sync/engine.js';
import { CorruptRemote, PreconditionFailed, QuotaExceeded, RateLimited } from '../sync/provider.js';

/**
 * Map a thrown error onto its wire code.
 *
 * `chrome.runtime.sendMessage` structured-clones its payload, which flattens an `Error` subclass
 * into a shapeless object and loses the class the UI was going to branch on — so the taxonomy
 * crosses the boundary as a code and is reassembled into a localized message by the UI.
 */
export function toErrorCode(error: unknown): ErrorCode {
  if (error instanceof WrongPasswordError) return 'WRONG_PASSWORD';
  if (error instanceof WeakPasswordError) return 'PASSWORD_TOO_SHORT';
  if (error instanceof UnsupportedSchemaError) return 'UNSUPPORTED_SCHEMA';
  if (error instanceof CorruptVaultError) return 'CORRUPT_VAULT';
  if (error instanceof VaultLockedError) return 'VAULT_LOCKED';
  if (error instanceof VaultStateError) return 'VAULT_STATE';
  if (error instanceof ItemNotFoundError) return 'ITEM_NOT_FOUND';
  if (error instanceof InvalidMutationError) return 'INVALID_MUTATION';
  if (error instanceof NoActiveTabError) return 'NO_ACTIVE_TAB';
  if (error instanceof UnsupportedUrlError) return URL_ERROR_CODES[error.reason];
  // A sync failure that reached a request handler — "sync now", or resolving a conflict. The
  // detail is in the status the UI is already showing; this only has to not say "unknown".
  if (
    error instanceof QuotaExceeded ||
    error instanceof RateLimited ||
    error instanceof PreconditionFailed ||
    error instanceof CorruptRemote
  ) {
    return 'SYNC_FAILED';
  }
  return 'UNKNOWN';
}

const URL_ERROR_CODES = {
  'internal-page': 'URL_INTERNAL_PAGE',
  'local-file': 'URL_LOCAL_FILE',
  'unsupported-scheme': 'URL_UNSUPPORTED_SCHEME',
} as const satisfies Record<UnsupportedUrlError['reason'], ErrorCode>;

/** Route one validated request. Never throws: every failure becomes an `ERROR` response. */
export async function handleRequest(request: Request): Promise<Response> {
  try {
    switch (request.type) {
      case 'PING':
        // Deliberately answered without touching storage, so it measures nothing but the worker
        // being reachable — which is also what makes it usable as the cold-start probe.
        return { type: 'PONG', version: chrome.runtime.getManifest().version };
      case 'GET_STATE': {
        const current = await session.state();
        return {
          type: 'STATE',
          exists: current.exists,
          adoptable: current.adoptable,
          locked: current.locked,
          unlockedUntil: current.unlockedUntil,
          settings: await session.settings(),
        };
      }
      case 'CREATE_VAULT':
        await session.createVault(request.password);
        return { type: 'OK' };
      case 'UNLOCK':
        await session.unlock(request.password);
        return { type: 'OK' };
      case 'LOCK':
        await session.lock(
          request.panic === true ? { reason: 'panic', flush: false } : { reason: 'manual' },
        );
        return { type: 'OK' };
      case 'TOUCH':
        return { type: 'TOUCHED', unlockedUntil: await session.touch() };
      case 'GET_SETTINGS':
        return { type: 'SETTINGS', settings: await session.settings() };
      case 'SET_SETTINGS':
        return { type: 'SETTINGS', settings: await session.updateSettings(request.settings) };
      case 'ADD_ACTIVE_TAB': {
        const result = await items.addActiveTab();
        return { type: 'ADDED', status: result.status, item: result.item };
      }
      case 'ADD_URL': {
        const result = await items.addUrl(request.url, request.title);
        return { type: 'ADDED', status: result.status, item: result.item };
      }
      case 'LIST_ITEMS': {
        const result = await items.list({
          ...(request.query === undefined ? {} : { query: request.query }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        });
        return { type: 'ITEMS', items: result.items, total: result.total };
      }
      case 'OPEN_ITEM':
        return {
          type: 'OPENED',
          status: await items.open(request.id, {
            ...(request.force === undefined ? {} : { force: request.force }),
            ...(request.clearHistoryAfter === undefined
              ? {}
              : { clearHistoryAfter: request.clearHistoryAfter }),
          }),
        };
      case 'DELETE_ITEMS':
        await items.remove(request.ids);
        return { type: 'OK' };
      case 'RESTORE_ITEMS':
        await items.restore(request.ids);
        return { type: 'OK' };
      case 'INCOGNITO_ACCESS':
        return await items.incognitoAccess(request.recheck ?? false);

      /* ---- the manager (Phase 6) ---- */
      case 'GET_TREE':
        return await organize.tree();
      case 'LIST_VIEW':
        return await organize.listView({
          ...(request.folderId === undefined ? {} : { folderId: request.folderId }),
          ...(request.query === undefined ? {} : { query: request.query }),
          ...(request.sort === undefined ? {} : { sort: request.sort }),
          ...(request.untagged === undefined ? {} : { untagged: request.untagged }),
        });
      case 'GET_ITEM':
        return { type: 'ITEM', item: await organize.getItem(request.id) };
      case 'CREATE_FOLDER':
        return { type: 'CREATED', id: await organize.createFolder(request.title, request.parentId) };
      case 'UPDATE_ITEM':
        await organize.editItem(request.id, request.patch);
        return { type: 'OK' };
      case 'MOVE_ITEMS':
        return { type: 'COUNT', count: await organize.moveItems(request.ids, request.parentId) };
      case 'DELETE_FOLDER':
        await organize.deleteFolder(request.id, request.mode);
        return { type: 'OK' };
      case 'TAG_ITEMS':
        return {
          type: 'COUNT',
          count: await organize.tagItems(request.ids, {
            ...(request.add === undefined ? {} : { add: request.add }),
            ...(request.remove === undefined ? {} : { remove: request.remove }),
          }),
        };
      case 'RENAME_TAG':
        return { type: 'COUNT', count: await organize.renameTag(request.from, request.to) };
      case 'COUNT_TRACKING_PARAMS':
        return { type: 'COUNT', count: await organize.countTracked() };
      case 'STRIP_TRACKING_PARAMS':
        return { type: 'COUNT', count: await organize.stripTracked() };
      case 'CHANGE_PASSWORD':
        await session.changePassword(request.currentPassword, request.newPassword);
        return { type: 'OK' };
      case 'DESTROY_VAULT':
        await session.destroyVault();
        return { type: 'OK' };

      /* ---- sync (Phase 7) ---- */
      case 'GET_SYNC_STATUS':
        return await syncing.syncStatus();
      case 'SYNC_NOW':
        return await syncing.runSyncNow();
      case 'LIST_CONFLICTS':
        return { type: 'CONFLICTS', conflicts: await syncing.conflicts() };
      case 'RESOLVE_CONFLICTS':
        return {
          type: 'COUNT',
          count: await syncing.resolve(request.ids, request.resolution),
        };
    }
  } catch (error) {
    // Nothing here may reach a log: a request carries a master password, and the errors that come
    // back from an unlock are exactly the ones whose context is most sensitive.
    return { type: 'ERROR', code: toErrorCode(error) };
  }
}

/* ------------------------------------------------------------------ registration */

onRequest(handleRequest);

/**
 * The sync engine's window onto the rest of the extension.
 *
 * Injected rather than imported the other way round so `src/sync/**` never reaches for a session, a
 * broadcast or a `chrome` namespace — which is what keeps the merge engine and the provider
 * testable on their own.
 */
configureSync({
  repository: () => session.currentRepository(),
  onVaultChanged: () => broadcast({ type: 'VAULT_CHANGED' }),
  onStatus: (status) => broadcast({ type: 'SYNC_CHANGED', status: { type: 'SYNC_STATUS', ...status } }),
});

/**
 * Another device wrote to `chrome.storage.sync`.
 *
 * This is the whole of "zero-configuration sync": Chrome replicates the area between the profile's
 * devices and tells us it changed, so there is nothing to poll and nothing to configure. Filtered
 * to our own keys, because the area is shared with nothing but is still worth being explicit about,
 * and ignored while locked — there is no key to merge with, and the next unlock syncs anyway.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (!Object.keys(changes).some((key) => key.startsWith('vm.s.'))) return;
  void syncNow();
});

registerLifecycleListeners({
  enforceDeadline: () => session.enforceDeadline(),
  housekeep: () => session.housekeep(),
  lock: (reason) => session.lock({ reason }),
  settings: () => session.settings(),
});

/**
 * Add from an entry point that has no window to answer in.
 *
 * The keyboard shortcut and the context menu both land here. Their only channel back to the user is
 * the toolbar badge, so every outcome — including the failures — gets a glyph. Nothing is logged:
 * the failure paths carry the URL that failed, which is exactly the thing that must never reach a
 * console (INV-6's spirit, and the "never log a URL" rule).
 */
async function addFromGesture(add: () => Promise<{ status: 'added' | 'duplicate' }>): Promise<void> {
  let kind: BadgeKind;
  try {
    kind = (await add()).status === 'duplicate' ? 'duplicate' : 'added';
  } catch (error) {
    kind = toErrorCode(error) === 'VAULT_LOCKED' ? 'locked' : 'refused';
  }
  await flashBadge(kind);
}

registerCommandListener({
  lock: (reason) => session.lock({ reason, flush: reason !== 'panic' }),
  touch: () => session.touch(),
  addActiveTab: () => addFromGesture(() => items.addActiveTab()),
});

registerContextMenuListener({
  addActiveTab: () => addFromGesture(() => items.addActiveTab()),
  addUrl: (url, title) => addFromGesture(() => items.addUrl(url, title)),
});

/**
 * Once-per-browser-session setup.
 *
 * Both events, because `onInstalled` fires on install and update while `onStartup` fires on every
 * browser launch, and neither implies the other. Everything in here is idempotent — the context
 * menus in particular, which `installContextMenus` removes before it creates, because
 * `contextMenus.create` fails on a duplicate id rather than replacing it.
 */
function onStart(): void {
  void (async () => {
    await session.hardenSessionStorage();
    await armHousekeeping();
    await installContextMenus();
    await clearBadge();
    // A browser that was closed for a week is the most likely moment for the remote to be ahead.
    // Scheduled rather than immediate so it does not compete with the cold-start budget (§7.2).
    scheduleSync();
  })();
}

chrome.runtime.onInstalled.addListener(onStart);
chrome.runtime.onStartup.addListener(onStart);
