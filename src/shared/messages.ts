/**
 * The message contract between the extension's contexts.
 *
 * Every request, response and broadcast is declared here as part of a discriminated union — there
 * are no ad-hoc string message types anywhere else in the codebase, and `send()` is typed so that
 * asking for `UNLOCK` and reading a `STATE` off the answer does not compile.
 *
 * Three rules this file exists to enforce:
 *
 * - **Anything arriving over `chrome.runtime.onMessage` is untrusted.** Another extension can send
 *   us anything at all, so `parseRequest` validates shape *and* payload rather than casting.
 * - **Errors cross the boundary as codes, not as objects.** `chrome.runtime.sendMessage`
 *   structured-clones its payload, which turns an `Error` subclass into a shapeless `{}` and loses
 *   the class the caller was going to branch on. {@link ErrorCode} is the wire form of the
 *   taxonomy in `crypto/errors.ts` and `vault/errors.ts`.
 * - **No message ever carries a key.** The unlocked DEK never leaves the service worker, and no
 *   message here has a field it could travel in. Decrypted *content* does travel — a popup that
 *   lists bookmarks has to receive them — but only as the {@link ItemSummary} projection, only to
 *   extension pages, only while the vault is unlocked, and never onto disk. INV-6 is about what
 *   reaches storage; `chrome.runtime` is not storage and is not reachable from a web page.
 */

import type { FolderDeleteMode } from '../vault/model.js';
import { isSortKey, type SortKey } from '../vault/sort.js';
import {
  DETAIL_WIDTH,
  SIDEBAR_WIDTH,
  clampPaneWidth,
  type VaultSettings,
} from '../vault/types.js';

/* ------------------------------------------------------------------ requests */

/** Liveness probe. Answered without touching storage, so it also measures cold-start latency. */
export interface PingRequest {
  readonly type: 'PING';
}

/** Everything a UI needs to decide which screen to show, in one round trip. */
export interface GetStateRequest {
  readonly type: 'GET_STATE';
}

export interface CreateVaultRequest {
  readonly type: 'CREATE_VAULT';
  readonly password: string;
}

export interface UnlockRequest {
  readonly type: 'UNLOCK';
  readonly password: string;
}

export interface LockRequest {
  readonly type: 'LOCK';
  /** Panic-lock: drop the key immediately instead of flushing pending writes first. */
  readonly panic?: boolean;
}

/** "The user did something." Re-arms the idle window; does nothing when the vault is locked. */
export interface TouchRequest {
  readonly type: 'TOUCH';
}

export interface GetSettingsRequest {
  readonly type: 'GET_SETTINGS';
}

export interface SetSettingsRequest {
  readonly type: 'SET_SETTINGS';
  readonly settings: SettingsPatch;
}

/**
 * Vault the active tab. Carries no URL: the worker reads the tab itself, under the `activeTab`
 * grant the click that produced this message just created (D25).
 */
export interface AddActiveTabRequest {
  readonly type: 'ADD_ACTIVE_TAB';
}

/** Vault a URL the user pointed at — the "Add link to VaultaMark" context-menu entry. */
export interface AddUrlRequest {
  readonly type: 'ADD_URL';
  readonly url: string;
  readonly title?: string;
}

/** Recent items, or the ones matching `query`. Ordered newest first. */
export interface ListItemsRequest {
  readonly type: 'LIST_ITEMS';
  readonly query?: string;
  readonly limit?: number;
}

export interface OpenItemRequest {
  readonly type: 'OPEN_ITEM';
  readonly id: string;
  /** Open in a *normal* window despite missing incognito access. Only ever an explicit choice. */
  readonly force?: boolean;
  /** Queue the item's domain for the history cleanup that Phase 9 performs. */
  readonly clearHistoryAfter?: boolean;
}

/**
 * Delete one or many items, as one revision.
 *
 * Plural because the manager deletes a selection and the popup deletes a row, and one batch means
 * one `vaultRev`, one write, and one thing for {@link RestoreItemsRequest} to undo — a bulk delete
 * that undid itself one bookmark at a time would be a worse product and a worse merge.
 */
export interface DeleteItemsRequest {
  readonly type: 'DELETE_ITEMS';
  readonly ids: readonly string[];
}

/** Undo a delete. The tombstone still holds the items, so this restores them under their own ids. */
export interface RestoreItemsRequest {
  readonly type: 'RESTORE_ITEMS';
  readonly ids: readonly string[];
}

/* --- the manager (Phase 6) ------------------------------------------------- */

/** The sidebar: every folder with its counts, and every tag with its use count. */
export interface GetTreeRequest {
  readonly type: 'GET_TREE';
}

/**
 * The manager's main list: a folder's contents, or the results of a search, sorted.
 *
 * `folderId` and `query` are not alternatives — a query is scoped to the folder when both are
 * given, which is what makes "search inside this folder" work without a second request type.
 */
export interface ListViewRequest {
  readonly type: 'LIST_VIEW';
  readonly folderId?: string;
  readonly query?: string;
  readonly sort?: SortKey;
  /** Only bookmarks carrying no tags. The sidebar's one built-in filter that needs the vault. */
  readonly untagged?: boolean;
}

/** One item in full, for the detail pane. The only message that carries a note. */
export interface GetItemRequest {
  readonly type: 'GET_ITEM';
  readonly id: string;
}

export interface CreateFolderRequest {
  readonly type: 'CREATE_FOLDER';
  readonly title: string;
  readonly parentId?: string;
}

export interface UpdateItemRequest {
  readonly type: 'UPDATE_ITEM';
  readonly id: string;
  readonly patch: ItemEdit;
}

/**
 * What a UI may change about an item.
 *
 * A deliberate subset of the model's `ItemPatch`: `og`, `thumb`, `openedAt` and `openCount` are
 * written by the extension in response to what happened, never by a person typing, and the cheapest
 * way to keep a UI from writing them is for the wire not to carry them.
 *
 * `null` clears an optional field, matching `ItemPatch` — `exactOptionalPropertyTypes` means the
 * absence of a key cannot express "remove this".
 */
export interface ItemEdit {
  readonly title?: string;
  readonly url?: string;
  readonly note?: string | null;
  readonly tags?: readonly string[] | null;
}

export interface MoveItemsRequest {
  readonly type: 'MOVE_ITEMS';
  readonly ids: readonly string[];
  readonly parentId: string;
}

/** Delete a folder. The caller must say what happens to what is inside it; there is no default. */
export interface DeleteFolderRequest {
  readonly type: 'DELETE_FOLDER';
  readonly id: string;
  readonly mode: FolderDeleteMode;
}

export interface TagItemsRequest {
  readonly type: 'TAG_ITEMS';
  readonly ids: readonly string[];
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

/** Rename a tag everywhere it appears. */
export interface RenameTagRequest {
  readonly type: 'RENAME_TAG';
  readonly from: string;
  readonly to: string;
}

/**
 * Re-wrap the data key under a new password.
 *
 * The current password is required even though the vault is open: an unlocked session must not be
 * a way to change the password without knowing it (`repo.changePassword`).
 */
export interface ChangePasswordRequest {
  readonly type: 'CHANGE_PASSWORD';
  readonly currentPassword: string;
  readonly newPassword: string;
}

/**
 * Erase the vault from this profile, irreversibly.
 *
 * The typed confirmation that gates this is in the UI, not on the wire. There is nothing a
 * confirmation field could add: `chrome.runtime` is reachable only from this extension's own pages
 * (there is no `externally_connectable`), so a message that arrives here was sent by our own code.
 */
export interface DestroyVaultRequest {
  readonly type: 'DESTROY_VAULT';
}

/** Is "Allow in Incognito" on? `recheck` bypasses the per-worker cache for the Re-check button. */
export interface IncognitoAccessRequest {
  readonly type: 'INCOGNITO_ACCESS';
  readonly recheck?: boolean;
}

/* --- sync (Phase 7) -------------------------------------------------------- */

/** Where sync got to. Cheap, and answered while locked — the lock screen shows it too. */
export interface GetSyncStatusRequest {
  readonly type: 'GET_SYNC_STATUS';
}

/** "Sync now": run the whole state machine immediately rather than on the next trigger. */
export interface SyncNowRequest {
  readonly type: 'SYNC_NOW';
}

/** The unresolved disagreements, both versions of each. */
export interface ListConflictsRequest {
  readonly type: 'LIST_CONFLICTS';
}

/**
 * Settle conflicts, one way for the whole batch.
 *
 * Plural because the conflict view offers "keep all mine" beside the per-item buttons, and because
 * a batch is one `vaultRev` and one thing for the other device to merge — the same reasoning as
 * {@link DeleteItemsRequest}.
 */
export interface ResolveConflictsRequest {
  readonly type: 'RESOLVE_CONFLICTS';
  readonly ids: readonly string[];
  readonly resolution: ConflictResolution;
}

export type ConflictResolution = 'mine' | 'theirs' | 'both';

export type Request =
  | PingRequest
  | GetStateRequest
  | CreateVaultRequest
  | UnlockRequest
  | LockRequest
  | TouchRequest
  | GetSettingsRequest
  | SetSettingsRequest
  | AddActiveTabRequest
  | AddUrlRequest
  | ListItemsRequest
  | OpenItemRequest
  | DeleteItemsRequest
  | RestoreItemsRequest
  | IncognitoAccessRequest
  | GetTreeRequest
  | ListViewRequest
  | GetItemRequest
  | CreateFolderRequest
  | UpdateItemRequest
  | MoveItemsRequest
  | DeleteFolderRequest
  | TagItemsRequest
  | RenameTagRequest
  | ChangePasswordRequest
  | DestroyVaultRequest
  | GetSyncStatusRequest
  | SyncNowRequest
  | ListConflictsRequest
  | ResolveConflictsRequest;

/** A partial settings update. Absent fields keep their stored value. */
export type SettingsPatch = Partial<VaultSettings>;

/* ------------------------------------------------------------------ responses */

export interface PongResponse {
  readonly type: 'PONG';
  readonly version: string;
}

export interface StateResponse {
  readonly type: 'STATE';
  /** Whether this profile holds a vault at all — the difference between "create" and "unlock". */
  readonly exists: boolean;
  /**
   * There is no vault on this device, but one is waiting in the sync area.
   *
   * What makes a second computer a *second computer* rather than a second vault: the popup offers
   * the password prompt instead of the create flow. Only ever true when {@link exists} is false.
   */
  readonly adoptable: boolean;
  readonly locked: boolean;
  /** Epoch ms at which the idle window expires, or `null` while locked. */
  readonly unlockedUntil: number | null;
  readonly settings: VaultSettings;
}

export interface OkResponse {
  readonly type: 'OK';
}

export interface SettingsResponse {
  readonly type: 'SETTINGS';
  readonly settings: VaultSettings;
}

/** The idle window after a {@link TouchRequest}. `null` means the vault is locked. */
export interface TouchedResponse {
  readonly type: 'TOUCHED';
  readonly unlockedUntil: number | null;
}

/**
 * One bookmark, as much of it as a list row needs.
 *
 * A projection rather than the stored `Bookmark`: notes, tags, OG metadata and thumbnail records
 * are not on this wire because nothing in the popup renders them, and the cheapest way to keep a
 * field out of a message is for the message not to have it.
 */
export interface ItemSummary {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly createdAt: number;
  readonly openedAt?: number;
}

export interface AddedResponse {
  readonly type: 'ADDED';
  /** `duplicate` means this URL was already vaulted; `item` is the one that was already there. */
  readonly status: 'added' | 'duplicate';
  readonly item: ItemSummary;
}

export interface ItemsResponse {
  readonly type: 'ITEMS';
  readonly items: readonly ItemSummary[];
  /** How many matched before `limit` was applied, so the list can say "showing 20 of 143". */
  readonly total: number;
}

export interface OpenedResponse {
  readonly type: 'OPENED';
  readonly status: OpenStatus;
}

/* --- the manager (Phase 6) ------------------------------------------------- */

/**
 * One row of the manager's list.
 *
 * Richer than {@link ItemSummary} — the manager shows folders, tags and a sort key the popup does
 * not — and still deliberately **without the note**. A note is capped at 4 KB, and a five-thousand
 * row view would put twenty megabytes of it on the wire to render a boolean. `hasNote` is that
 * boolean; the detail pane asks for the rest with {@link GetItemRequest}.
 */
export interface ListRow {
  readonly id: string;
  readonly type: 'bookmark' | 'folder';
  readonly parentId: string;
  readonly title: string;
  readonly url?: string;
  readonly tags: readonly string[];
  readonly hasNote: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly openedAt?: number;
  readonly openCount?: number;
  /** Live bookmarks in this folder's subtree. Present on folders only. */
  readonly descendants?: number;
}

/** One item in full. The note travels here and nowhere else. */
export interface ItemDetail extends ListRow {
  readonly note: string;
  /** Ancestors from the top level down to the item's parent. */
  readonly path: readonly Crumb[];
}

export interface Crumb {
  readonly id: string;
  readonly title: string;
}

export interface FolderNode {
  readonly id: string;
  readonly parentId: string;
  readonly title: string;
  /** Items of either kind directly inside. */
  readonly direct: number;
  /** Live bookmarks anywhere in the subtree — the number a folder row shows. */
  readonly descendants: number;
}

export interface TagCount {
  readonly tag: string;
  readonly count: number;
}

export interface TreeResponse {
  readonly type: 'TREE';
  readonly folders: readonly FolderNode[];
  readonly tags: readonly TagCount[];
  /** Live bookmarks in the whole vault, and how many of them carry no tag. */
  readonly total: number;
  readonly untagged: number;
}

export interface ViewResponse {
  readonly type: 'VIEW';
  readonly items: readonly ListRow[];
  /** Breadcrumbs for the folder being shown. Empty at the top level and for a search. */
  readonly path: readonly Crumb[];
  /**
   * The folded free-text terms the query came down to, so the list can highlight them without
   * re-implementing the query grammar. Empty when nothing was searched for.
   */
  readonly terms: readonly string[];
  /**
   * Whether the order is relevance rather than the requested sort key.
   *
   * A search with terms in it is ranked — a result that is third because it happens to be older is
   * a search that failed — so the sort control has nothing to do and the UI says so instead of
   * offering a menu that changes nothing.
   */
  readonly ranked: boolean;
}

export interface ItemResponse {
  readonly type: 'ITEM';
  /** `null` when the id is unknown — a stale list, or something another window just deleted. */
  readonly item: ItemDetail | null;
}

export interface CreatedResponse {
  readonly type: 'CREATED';
  readonly id: string;
}

/** How many items an operation actually changed. */
export interface CountResponse {
  readonly type: 'COUNT';
  readonly count: number;
}

export type OpenStatus =
  | 'incognito'
  /** Opened in a normal window, because the user explicitly chose the fallback. */
  | 'normal'
  /** Nothing was opened: "Allow in Incognito" is off and the UI must show the guided prompt. */
  | 'needs-incognito-access';

export interface IncognitoAccessResponse {
  readonly type: 'INCOGNITO_ACCESS_STATE';
  readonly allowed: boolean;
  /** `chrome://extensions/?id=…`. Built here because only the worker knows the extension id. */
  readonly settingsUrl: string;
}

/* --- sync (Phase 7) -------------------------------------------------------- */

/**
 * One side of a disagreement, flattened.
 *
 * A projection rather than the stored `VaultItem`, for the same reason {@link ItemSummary} is one:
 * the conflict view renders a field-by-field comparison, and everything it does not render — the
 * order key, the revision, the thumbnail record — is weight on the wire and one more shape for the
 * UI to know about.
 */
export interface ConflictSide {
  readonly title: string;
  readonly url?: string;
  readonly note: string;
  readonly tags: readonly string[];
  /** Title of the containing folder, or an empty string at the top level. */
  readonly folder: string;
  /** This side deleted the item. The other side, by definition, did not. */
  readonly deleted: boolean;
  readonly updatedAt: number;
}

export interface ConflictView {
  readonly id: string;
  readonly kind: 'field' | 'edit-delete' | 'add-add';
  /** Which fields disagree, so the view can mark them rather than showing everything as changed. */
  readonly fields: readonly string[];
  readonly mine: ConflictSide;
  readonly theirs: ConflictSide;
  /** False when one side is a deletion: "keep both" would mean keeping a deletion. */
  readonly canKeepBoth: boolean;
  readonly detectedAt: number;
}

export interface ConflictsResponse {
  readonly type: 'CONFLICTS';
  readonly conflicts: readonly ConflictView[];
}

/**
 * The sync status line.
 *
 * Deliberately answerable while the vault is locked — `phase: 'locked'`, the last sync time from
 * plaintext `vm.baseMeta`, and nothing else — because "when did this last sync?" is a question
 * worth answering on a lock screen, and none of it describes a bookmark.
 */
export interface SyncStatusResponse {
  readonly type: 'SYNC_STATUS';
  readonly phase: 'idle' | 'peeking' | 'pulling' | 'merging' | 'pushing' | 'conflict' | 'error' | 'locked';
  readonly providerId: 'chrome' | 'drive';
  readonly lastSyncedAt: number | null;
  readonly conflicts: number;
  readonly error: SyncErrorCode | null;
  readonly retryAfterMs: number | null;
  readonly usedBytes: number;
  readonly quotaBytes: number;
}

/** Why a sync failed, as a code. Same reasoning as {@link ErrorCode}. */
export type SyncErrorCode =
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'OFFLINE'
  | 'AUTH_REQUIRED'
  | 'CORRUPT_REMOTE'
  | 'PRECONDITION_FAILED'
  | 'VAULT_LOCKED'
  | 'VAULT_MISMATCH'
  | 'UNKNOWN';

/**
 * The wire form of a thrown error.
 *
 * No message string: user-facing text lives in `_locales` and is chosen by the UI from the code.
 * A developer message would either be untranslated English in the UI or dead weight on the wire.
 */
export interface ErrorResponse {
  readonly type: 'ERROR';
  readonly code: ErrorCode;
}

export type ErrorCode =
  /** The master password is wrong. A normal, expected user event. */
  | 'WRONG_PASSWORD'
  /** Below `MIN_PASSWORD_LENGTH`, refused at vault creation and at password change. */
  | 'PASSWORD_TOO_SHORT'
  /** Authenticated data did not authenticate. A restore-from-backup situation. */
  | 'CORRUPT_VAULT'
  /** The vault was written by a newer VaultaMark. Update, do not downgrade. */
  | 'UNSUPPORTED_SCHEMA'
  /** The operation needs an unlocked vault and the vault is locked. */
  | 'VAULT_LOCKED'
  /** `CREATE_VAULT` on a profile that already has one, or `UNLOCK` on one that has none. */
  | 'VAULT_STATE'
  /** The vault has no item with that id — a stale list, or an undo of an already-purged delete. */
  | 'ITEM_NOT_FOUND'
  /** The tree refused the change: a folder moved inside itself, a bookmark used as a parent. */
  | 'INVALID_MUTATION'
  /** There was no active tab to read, or `activeTab` did not grant us its URL. */
  | 'NO_ACTIVE_TAB'
  /** A Chrome page, our own pages, `about:` — nothing we could reopen in incognito later. */
  | 'URL_INTERNAL_PAGE'
  /** A `file://` URL. Incognito windows will not open it, so vaulting it would be a dead entry. */
  | 'URL_LOCAL_FILE'
  /** Any other scheme we refuse to store: `javascript:`, `data:`, `blob:`, and the long tail. */
  | 'URL_UNSUPPORTED_SCHEME'
  /** A sync operation failed. What went wrong is in the sync status, not in this code. */
  | 'SYNC_FAILED'
  /** The service worker did not answer at all. Only ever produced on the sender's side. */
  | 'UNREACHABLE'
  | 'UNKNOWN';

/** Which response type each request is answered with. `ERROR` is always also possible. */
export interface ResponseMap {
  readonly PING: PongResponse;
  readonly GET_STATE: StateResponse;
  readonly CREATE_VAULT: OkResponse;
  readonly UNLOCK: OkResponse;
  readonly LOCK: OkResponse;
  readonly TOUCH: TouchedResponse;
  readonly GET_SETTINGS: SettingsResponse;
  readonly SET_SETTINGS: SettingsResponse;
  readonly ADD_ACTIVE_TAB: AddedResponse;
  readonly ADD_URL: AddedResponse;
  readonly LIST_ITEMS: ItemsResponse;
  readonly OPEN_ITEM: OpenedResponse;
  readonly DELETE_ITEMS: OkResponse;
  readonly RESTORE_ITEMS: OkResponse;
  readonly INCOGNITO_ACCESS: IncognitoAccessResponse;
  readonly GET_TREE: TreeResponse;
  readonly LIST_VIEW: ViewResponse;
  readonly GET_ITEM: ItemResponse;
  readonly CREATE_FOLDER: CreatedResponse;
  readonly UPDATE_ITEM: OkResponse;
  readonly MOVE_ITEMS: CountResponse;
  readonly DELETE_FOLDER: OkResponse;
  readonly TAG_ITEMS: CountResponse;
  readonly RENAME_TAG: CountResponse;
  readonly CHANGE_PASSWORD: OkResponse;
  readonly DESTROY_VAULT: OkResponse;
  readonly GET_SYNC_STATUS: SyncStatusResponse;
  readonly SYNC_NOW: SyncStatusResponse;
  readonly LIST_CONFLICTS: ConflictsResponse;
  readonly RESOLVE_CONFLICTS: CountResponse;
}

export type ResponseFor<R extends Request> = ResponseMap[R['type']] | ErrorResponse;

export type Response = ResponseMap[Request['type']] | ErrorResponse;

/* ------------------------------------------------------------------ broadcasts */

/** Why the vault locked. The UI says so; `panic` additionally closes extension pages. */
export type LockReason = 'manual' | 'panic' | 'expired' | 'idle' | 'blur';

export interface SessionLockedBroadcast {
  readonly type: 'SESSION_LOCKED';
  readonly reason: LockReason;
}

export interface SessionUnlockedBroadcast {
  readonly type: 'SESSION_UNLOCKED';
  readonly unlockedUntil: number;
}

export interface SettingsChangedBroadcast {
  readonly type: 'SETTINGS_CHANGED';
  readonly settings: VaultSettings;
}

/**
 * The item set changed under an open UI.
 *
 * Carries no items: a page that cares re-reads with `LIST_ITEMS`, filtered the way *it* is
 * filtered. Broadcasting the items instead would mean shipping the vault to every open page on
 * every add, including the ones showing something else entirely.
 */
export interface VaultChangedBroadcast {
  readonly type: 'VAULT_CHANGED';
}

/**
 * Sync moved. Carries the whole status, because it is small and every listener wants all of it.
 *
 * Unlike {@link VaultChangedBroadcast}, which deliberately carries nothing: a status is four
 * numbers and two enums, while the item set is the vault.
 */
export interface SyncChangedBroadcast {
  readonly type: 'SYNC_CHANGED';
  readonly status: SyncStatusResponse;
}

/** Service worker → open UIs. Never answered; `broadcast()` ignores the absence of a listener. */
export type Broadcast =
  | SessionLockedBroadcast
  | SessionUnlockedBroadcast
  | SettingsChangedBroadcast
  | VaultChangedBroadcast
  | SyncChangedBroadcast;

/* ------------------------------------------------------------------ parsing */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Narrow an unvalidated message to a known request, or `null` if it is not one of ours.
 *
 * Payloads are checked field by field. A `CREATE_VAULT` whose password is an object would
 * otherwise reach PBKDF2 as a non-string and fail somewhere far less legible.
 */
export function parseRequest(raw: unknown): Request | null {
  if (!isRecord(raw)) return null;
  const type = raw['type'];
  switch (type) {
    case 'PING':
    case 'GET_STATE':
    case 'TOUCH':
    case 'GET_SETTINGS':
      return { type };
    case 'CREATE_VAULT':
    case 'UNLOCK': {
      const password = raw['password'];
      return typeof password === 'string' ? { type, password } : null;
    }
    case 'LOCK': {
      const panic = raw['panic'];
      if (panic === undefined) return { type };
      return typeof panic === 'boolean' ? { type, panic } : null;
    }
    case 'SET_SETTINGS': {
      const settings = parseSettingsPatch(raw['settings']);
      return settings === null ? null : { type, settings };
    }
    case 'ADD_ACTIVE_TAB':
      return { type };
    case 'ADD_URL': {
      const url = raw['url'];
      if (typeof url !== 'string' || url === '') return null;
      const title = raw['title'];
      if (title === undefined) return { type, url };
      return typeof title === 'string' ? { type, url, title } : null;
    }
    case 'LIST_ITEMS': {
      const query = raw['query'];
      const limit = raw['limit'];
      if (query !== undefined && typeof query !== 'string') return null;
      if (limit !== undefined && !isPositiveInteger(limit)) return null;
      return {
        type,
        ...(query === undefined ? {} : { query }),
        ...(limit === undefined ? {} : { limit }),
      };
    }
    case 'OPEN_ITEM': {
      const id = raw['id'];
      if (typeof id !== 'string' || id === '') return null;
      const force = raw['force'];
      const clearHistoryAfter = raw['clearHistoryAfter'];
      if (force !== undefined && typeof force !== 'boolean') return null;
      if (clearHistoryAfter !== undefined && typeof clearHistoryAfter !== 'boolean') return null;
      return {
        type,
        id,
        ...(force === undefined ? {} : { force }),
        ...(clearHistoryAfter === undefined ? {} : { clearHistoryAfter }),
      };
    }
    case 'DELETE_ITEMS':
    case 'RESTORE_ITEMS': {
      const ids = parseIdList(raw['ids']);
      return ids === null ? null : { type, ids };
    }
    case 'INCOGNITO_ACCESS': {
      const recheck = raw['recheck'];
      if (recheck === undefined) return { type };
      return typeof recheck === 'boolean' ? { type, recheck } : null;
    }
    case 'GET_TREE':
    case 'DESTROY_VAULT':
    case 'GET_SYNC_STATUS':
    case 'SYNC_NOW':
    case 'LIST_CONFLICTS':
      return { type };
    case 'RESOLVE_CONFLICTS': {
      const ids = parseIdList(raw['ids']);
      const resolution = raw['resolution'];
      if (ids === null) return null;
      if (resolution !== 'mine' && resolution !== 'theirs' && resolution !== 'both') return null;
      return { type, ids, resolution };
    }
    case 'LIST_VIEW': {
      const { folderId, query, sort, untagged } = raw;
      if (folderId !== undefined && !isNonEmptyString(folderId)) return null;
      if (query !== undefined && typeof query !== 'string') return null;
      if (sort !== undefined && !isSortKey(sort)) return null;
      if (untagged !== undefined && typeof untagged !== 'boolean') return null;
      return {
        type,
        ...(folderId === undefined ? {} : { folderId }),
        ...(query === undefined ? {} : { query }),
        ...(sort === undefined ? {} : { sort }),
        ...(untagged === undefined ? {} : { untagged }),
      };
    }
    case 'GET_ITEM': {
      const id = raw['id'];
      return isNonEmptyString(id) ? { type, id } : null;
    }
    case 'CREATE_FOLDER': {
      const title = raw['title'];
      const parentId = raw['parentId'];
      if (!isNonEmptyString(title)) return null;
      if (parentId !== undefined && !isNonEmptyString(parentId)) return null;
      return { type, title, ...(parentId === undefined ? {} : { parentId }) };
    }
    case 'UPDATE_ITEM': {
      const id = raw['id'];
      const patch = parseItemEdit(raw['patch']);
      if (!isNonEmptyString(id) || patch === null) return null;
      return { type, id, patch };
    }
    case 'MOVE_ITEMS': {
      const ids = parseIdList(raw['ids']);
      const parentId = raw['parentId'];
      if (ids === null || !isNonEmptyString(parentId)) return null;
      return { type, ids, parentId };
    }
    case 'DELETE_FOLDER': {
      const id = raw['id'];
      const mode = raw['mode'];
      if (!isNonEmptyString(id)) return null;
      if (mode !== 'recursive' && mode !== 'reparent') return null;
      return { type, id, mode };
    }
    case 'TAG_ITEMS': {
      const ids = parseIdList(raw['ids']);
      const add = raw['add'];
      const remove = raw['remove'];
      if (ids === null) return null;
      if (add !== undefined && !isStringArray(add)) return null;
      if (remove !== undefined && !isStringArray(remove)) return null;
      return {
        type,
        ids,
        ...(add === undefined ? {} : { add }),
        ...(remove === undefined ? {} : { remove }),
      };
    }
    case 'RENAME_TAG': {
      const from = raw['from'];
      const to = raw['to'];
      if (!isNonEmptyString(from) || !isNonEmptyString(to)) return null;
      return { type, from, to };
    }
    case 'CHANGE_PASSWORD': {
      const currentPassword = raw['currentPassword'];
      const newPassword = raw['newPassword'];
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') return null;
      return { type, currentPassword, newPassword };
    }
    default:
      return null;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * A list of item ids: non-empty strings, and at least one of them.
 *
 * An empty array is rejected rather than treated as a no-op. Every caller of a bulk operation has a
 * selection behind it, so an empty one is a bug in the caller — and answering `OK` to "delete
 * nothing" is how that bug reaches a user as "the delete button does nothing sometimes".
 */
function parseIdList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every(isNonEmptyString) ? [...value] : null;
}

/** Validate an item edit. Rejects the whole patch on any bad field, like {@link parseSettingsPatch}. */
export function parseItemEdit(raw: unknown): ItemEdit | null {
  if (!isRecord(raw)) return null;
  const patch: { -readonly [K in keyof ItemEdit]: ItemEdit[K] } = {};

  const title = raw['title'];
  if (title !== undefined) {
    if (typeof title !== 'string') return null;
    patch.title = title;
  }

  const url = raw['url'];
  if (url !== undefined) {
    if (!isNonEmptyString(url)) return null;
    patch.url = url;
  }

  const note = raw['note'];
  if (note !== undefined) {
    if (note !== null && typeof note !== 'string') return null;
    patch.note = note;
  }

  const tags = raw['tags'];
  if (tags !== undefined) {
    if (tags !== null && !isStringArray(tags)) return null;
    patch.tags = tags;
  }

  return patch;
}

/**
 * Validate a settings patch.
 *
 * Rejects the whole patch on any bad field rather than silently dropping it: a UI that sent an
 * unusable value has a bug, and half-applying its update would hide it.
 */
export function parseSettingsPatch(raw: unknown): SettingsPatch | null {
  if (!isRecord(raw)) return null;
  const patch: { -readonly [K in keyof VaultSettings]?: VaultSettings[K] } = {};

  const theme = raw['theme'];
  if (theme !== undefined) {
    if (theme !== 'system' && theme !== 'light' && theme !== 'dark') return null;
    patch.theme = theme;
  }

  const idle = raw['idleTimeoutMinutes'];
  if (idle !== undefined) {
    if (typeof idle !== 'number' || !Number.isFinite(idle) || idle < 0) return null;
    patch.idleTimeoutMinutes = idle;
  }

  const providerId = raw['providerId'];
  if (providerId !== undefined) {
    if (providerId !== 'chrome' && providerId !== 'drive') return null;
    patch.providerId = providerId;
  }

  const lockOnBrowserBlur = raw['lockOnBrowserBlur'];
  if (lockOnBrowserBlur !== undefined) {
    if (typeof lockOnBrowserBlur !== 'boolean') return null;
    patch.lockOnBrowserBlur = lockOnBrowserBlur;
  }

  const stripTrackingParams = raw['stripTrackingParams'];
  if (stripTrackingParams !== undefined) {
    if (typeof stripTrackingParams !== 'boolean') return null;
    patch.stripTrackingParams = stripTrackingParams;
  }

  const reuseIncognitoWindow = raw['reuseIncognitoWindow'];
  if (reuseIncognitoWindow !== undefined) {
    if (typeof reuseIncognitoWindow !== 'boolean') return null;
    patch.reuseIncognitoWindow = reuseIncognitoWindow;
  }

  const sortBy = raw['sortBy'];
  if (sortBy !== undefined) {
    if (!isSortKey(sortBy)) return null;
    patch.sortBy = sortBy;
  }

  // Clamped rather than rejected: the sender is a mouse drag, and the honest answer to "wider than
  // the window" is the widest allowed, not a refused write that leaves the column where it was.
  const sidebarWidth = raw['sidebarWidth'];
  if (sidebarWidth !== undefined) {
    if (typeof sidebarWidth !== 'number' || !Number.isFinite(sidebarWidth)) return null;
    patch.sidebarWidth = clampPaneWidth(sidebarWidth, SIDEBAR_WIDTH);
  }

  const detailWidth = raw['detailWidth'];
  if (detailWidth !== undefined) {
    if (typeof detailWidth !== 'number' || !Number.isFinite(detailWidth)) return null;
    patch.detailWidth = clampPaneWidth(detailWidth, DETAIL_WIDTH);
  }

  return patch;
}

const RESPONSE_TYPES: ReadonlySet<string> = new Set([
  'PONG',
  'STATE',
  'OK',
  'SETTINGS',
  'TOUCHED',
  'ADDED',
  'ITEMS',
  'OPENED',
  'INCOGNITO_ACCESS_STATE',
  'TREE',
  'VIEW',
  'ITEM',
  'CREATED',
  'COUNT',
  'SYNC_STATUS',
  'CONFLICTS',
  'ERROR',
]);

/** Narrow a reply from the service worker. Shallow: it is our own worker on the other end. */
export function parseResponse(raw: unknown): Response | null {
  if (!isRecord(raw)) return null;
  const type = raw['type'];
  if (typeof type !== 'string' || !RESPONSE_TYPES.has(type)) return null;
  // Every field was produced by `handleRequest` in the service worker one line before it was
  // cloned onto the wire; re-validating our own output field by field would only add a second
  // place to keep in step with the union above.
  return raw as unknown as Response;
}

const BROADCAST_TYPES: ReadonlySet<string> = new Set([
  'SESSION_LOCKED',
  'SESSION_UNLOCKED',
  'SETTINGS_CHANGED',
  'VAULT_CHANGED',
  'SYNC_CHANGED',
]);

export function parseBroadcast(raw: unknown): Broadcast | null {
  if (!isRecord(raw)) return null;
  const type = raw['type'];
  if (typeof type !== 'string' || !BROADCAST_TYPES.has(type)) return null;
  // Same reasoning as `parseResponse`: the sender is our own service worker.
  return raw as unknown as Broadcast;
}

/* ------------------------------------------------------------------ transport */

/**
 * Send a request to the service worker and get the response its type promises.
 *
 * Never rejects. A dead worker that fails to restart, or a popup that closed mid-flight, is a
 * state the UI has to render anyway, and an exception at every call site is a worse way to say so.
 */
export async function send<R extends Request>(request: R): Promise<ResponseFor<R>> {
  let raw: unknown;
  try {
    raw = await chrome.runtime.sendMessage(request);
  } catch {
    return { type: 'ERROR', code: 'UNREACHABLE' };
  }
  const response = parseResponse(raw);
  if (response === null) return { type: 'ERROR', code: 'UNKNOWN' };
  // `ResponseMap` is the sole authority on which response answers which request, and it is not
  // something the runtime can check — the worker is a separate context.
  return response as ResponseFor<R>;
}

/**
 * Register the service worker's request router.
 *
 * Returning `true` keeps the message channel open for the async answer, which is the one part of
 * `chrome.runtime.onMessage` that silently breaks if you get it wrong: an async listener that
 * returns `undefined` leaves the sender waiting forever.
 */
export function onRequest(handler: (request: Request) => Promise<Response>): void {
  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const request = parseRequest(raw);
    if (request === null) return false;
    void handler(request).then(sendResponse, () => {
      sendResponse({ type: 'ERROR', code: 'UNKNOWN' } satisfies ErrorResponse);
    });
    return true;
  });
}

/** Service worker → every open extension page. Nothing listening is the normal case. */
export async function broadcast(message: Broadcast): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // "Could not establish connection. Receiving end does not exist" — every extension page is
    // closed. That is the common case for a lock that fires on an idle alarm, not an error.
  }
}

/** UI side of {@link broadcast}. Returns an unsubscribe function. */
export function onBroadcast(handler: (message: Broadcast) => void): () => void {
  const listener = (raw: unknown): undefined => {
    const message = parseBroadcast(raw);
    if (message !== null) handler(message);
    return undefined;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => {
    chrome.runtime.onMessage.removeListener(listener);
  };
}
