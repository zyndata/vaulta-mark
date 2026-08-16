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

import type { Diagnostics } from './diagnostics.js';
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

/**
 * Move a selection into a folder, optionally to a position within it (Phase 12).
 *
 * `afterId` is the sibling the selection lands *after*; `null` means "first"; omitting it appends,
 * which is what dropping onto a folder has always done. The model has supported this since Phase 3
 * — `moveItem` takes an `afterId` — and until the manager grew a manual sort order there was no
 * view in which the answer was visible, so the wire never carried it.
 */
export interface MoveItemsRequest {
  readonly type: 'MOVE_ITEMS';
  readonly ids: readonly string[];
  readonly parentId: string;
  readonly afterId?: string | null;
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
 * How many saved bookmarks carry a tracking parameter.
 *
 * Asked when the strip-tracking setting is switched on, so the offer to clean what is already in
 * the vault is only made when there is something to clean. Reads; changes nothing.
 */
export interface CountTrackingParamsRequest {
  readonly type: 'COUNT_TRACKING_PARAMS';
}

/** Rewrite every saved URL that carries a tracking parameter, as one revision. */
export interface StripTrackingParamsRequest {
  readonly type: 'STRIP_TRACKING_PARAMS';
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
  /**
   * Also remove the encrypted copy from the sync backend. Defaults to **true**.
   *
   * The default is the one that matches what the button says. Leaving the synced copy behind meant a
   * profile that had just erased its vault was offered the chance to adopt it back, and a
   * replacement vault created with the same password could never open those bytes — a new vault is a
   * new DEK — so the two sat in one sync area refusing each other forever. Anyone who genuinely
   * wants the copy left for another computer unticks the box and is told what that means.
   */
  readonly deleteRemote?: boolean;
}

/**
 * Put this vault in the sync area, over whatever is there.
 *
 * The escape from `VAULT_MISMATCH`. Answers with the sync status the run ended at, so the screen
 * that asked can say whether it worked without a second round trip.
 */
export interface ReplaceRemoteVaultRequest {
  readonly type: 'REPLACE_REMOTE_VAULT';
}

/**
 * Take the synced vault, and let this profile's own go.
 *
 * The other half of the same escape, and the destructive direction: everything in `storage.local`
 * is erased and replaced with what the sync area holds. `password` is the **synced** vault's, which
 * is the whole reason this can work at all — the KDF salt and the wrapped DEK travel in the header.
 *
 * `from` names the backend rather than letting the worker read it, because the case this exists for
 * is a Drive migration that was *refused*: `providerId` is still `chrome` at that point, and the
 * vault being asked for is the one in Drive.
 */
export interface AdoptRemoteVaultRequest {
  readonly type: 'ADOPT_REMOTE_VAULT';
  readonly password: string;
  readonly from: 'chrome' | 'drive';
}

/** Is "Allow in Incognito" on? `recheck` bypasses the per-worker cache for the Re-check button. */
export interface IncognitoAccessRequest {
  readonly type: 'INCOGNITO_ACCESS';
  readonly recheck?: boolean;
}

/* --- thumbnails (Phase 11) ------------------------------------------------- */

/**
 * The preview picture for one item, decrypted.
 *
 * Sent **only when somebody asked to look** — an eye icon clicked, a hover that outlived its delay.
 * A list render never sends it: a row knows from `ListRow.hasThumb` whether there is a picture, and
 * that boolean is the whole of what rendering needs. This is also the only request in the protocol
 * that can cause a network request, and only on a Drive-backed cache miss (§14.6).
 */
export interface GetThumbRequest {
  readonly type: 'GET_THUMB';
  readonly id: string;
}

/**
 * Re-capture the preview for an item, from the page in the active tab.
 *
 * Only ever an explicit click, never automatic and never on a timer (§14.5). The tab is not named:
 * the worker reads the active one itself, under the `activeTab` grant the click that produced this
 * message just created — the same reasoning as {@link AddActiveTabRequest}, and the reason this can
 * exist at all without a host permission.
 */
export interface RefreshThumbRequest {
  readonly type: 'REFRESH_THUMB';
  readonly id: string;
}

/**
 * Is the page in front of the popup already vaulted?
 *
 * Asked when the popup opens, so the one place that *can* re-capture a preview offers it directly
 * rather than only after an add reports a duplicate — a refresh that begins with "press Add this
 * page" reads as the wrong button, and the step was missed often enough to be reported as the
 * feature not working (§14.5).
 *
 * It reads the active tab under the same `activeTab` grant the click that opened the popup created,
 * and it is a **read**: nothing is vaulted, nothing is injected, nothing is written.
 */
export interface LookupActiveTabRequest {
  readonly type: 'LOOKUP_ACTIVE_TAB';
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

/* --- Drive sync (Phase 10) ------------------------------------------------- */

/** Is Drive connected, and as whom? Answered while locked — the settings screen shows it either way. */
export interface GetDriveStateRequest {
  readonly type: 'GET_DRIVE_STATE';
}

/**
 * The redacted bug-report dump (Phase 12). Answered while locked, with the vault half left `null`.
 *
 * Gathered in the **worker**, not in the page, and that is the point of it being a message at all
 * rather than something `manager/settings.ts` assembles from what it already has on screen. The
 * worker is the only context holding decrypted items, so it is the only one that can count them —
 * and having it hand back a finished {@link Diagnostics} record means the page never receives
 * anything it would then have to be trusted to redact.
 */
export interface GetDiagnosticsRequest {
  readonly type: 'GET_DIAGNOSTICS';
}

/**
 * Connect Google Drive and move the vault there (§6.6).
 *
 * One message rather than "authorize" plus "migrate", because they are one decision: nobody
 * authorizes Drive in order to leave the vault in Chrome sync. The optional `identity` permission
 * has to be granted *before* this is sent — `chrome.permissions.request` only works from a page
 * during a user gesture, and a service worker cannot ask.
 */
export interface ConnectDriveRequest {
  readonly type: 'CONNECT_DRIVE';
  /**
   * Take the Drive folder over if it already holds a *different* vault.
   *
   * Off by default, and it has to be: finding a vault already there is the normal case for a second
   * computer, and one that opens under this key is adopted rather than overwritten (§6.6). This is
   * the answer to the refusal that follows when it does *not* open — asked for explicitly, from the
   * screen that reported it, and never something the migration decides on its own.
   */
  readonly replaceExisting?: boolean;
}

/**
 * Stop using Drive and move the vault back into Chrome sync.
 *
 * Refused, with a count, when the vault no longer fits — which is the whole reason Drive exists,
 * and a refusal is the only honest answer to "move 2,400 bookmarks into 100 KB".
 */
export interface DisconnectDriveRequest {
  readonly type: 'DISCONNECT_DRIVE';
  /** Also delete the folder in Drive. Default false: those files are the user's, not ours. */
  readonly deleteRemote?: boolean;
}

/* --- import and export (Phase 8) ------------------------------------------- */

/**
 * Produce a `.vmv` backup.
 *
 * The password is always typed, even when it is the vault's own: the service worker holds the data
 * key, not the password, and a backup sealed under a mistyped password is one nobody discovers is
 * unopenable until the day they need it. `mode: 'vault'` is checked against the vault before
 * anything is sealed; `'custom'` is whatever the user chose, confirmed twice in the UI.
 */
export interface ExportVaultRequest {
  readonly type: 'EXPORT_VAULT';
  readonly password: string;
  readonly mode: 'vault' | 'custom';
}

/** What is in this file? Decrypts, validates and counts; writes nothing. */
export interface PreviewImportRequest {
  readonly type: 'PREVIEW_IMPORT';
  readonly file: string;
  readonly password: string;
}

/** Apply a previewed file. Re-reads it rather than trusting a handle a dead worker would have lost. */
export interface ImportVaultRequest {
  readonly type: 'IMPORT_VAULT';
  readonly file: string;
  readonly password: string;
  readonly mode: 'merge' | 'replace';
}

/** Is there an undo for a replace-mode import, and until when? Answered while unlocked. */
export interface GetRollbackRequest {
  readonly type: 'GET_ROLLBACK';
}

/** Put the vault back the way it was before the last replace-mode import. One shot. */
export interface RollbackImportRequest {
  readonly type: 'ROLLBACK_IMPORT';
}

/** Chrome's own bookmark tree. Needs the optional `bookmarks` permission to have been granted. */
export interface NativeTreeRequest {
  readonly type: 'NATIVE_TREE';
}

/** Copy a selection of native bookmarks into the vault, preserving folders. */
export interface ImportNativeRequest {
  readonly type: 'IMPORT_NATIVE';
  readonly ids: readonly string[];
  /** File the imported tree inside this folder rather than at the top level. */
  readonly parentId?: string;
}

/**
 * Delete native bookmarks — the second, separate step (INV-5).
 *
 * Its own message rather than a flag on {@link ImportNativeRequest}, because a flag would put
 * "and delete the originals" one mis-click away from an import, and Chrome's bookmark deletion has
 * no undo we can offer.
 */
export interface DeleteNativeRequest {
  readonly type: 'DELETE_NATIVE';
  readonly ids: readonly string[];
}

/* --- onboarding and history hygiene (Phase 9) ------------------------------ */

/** How far the first-run flow got. Answered while locked — it runs before a vault exists. */
export interface GetOnboardingRequest {
  readonly type: 'GET_ONBOARDING';
}

/** Record a step, a skip, or the completion. Also how "Replay onboarding" clears the stamp. */
export interface SetOnboardingRequest {
  readonly type: 'SET_ONBOARDING';
  readonly patch: OnboardingPatch;
}

/**
 * What a history cleanup *would* delete (ARCHITECTURE §12.2).
 *
 * Reads history and the vault; deletes nothing. Its answer is what the confirmation is written from,
 * and the run that follows deletes from the same scan rather than re-deriving one — so "this will
 * remove 143 entries" and "removed 143 entries" agree by construction.
 */
export interface PreviewHistoryCleanupRequest {
  readonly type: 'PREVIEW_HISTORY_CLEANUP';
}

/** Do it. Deletes only URLs whose registrable domain is one the vault holds. */
export interface ClearVaultedHistoryRequest {
  readonly type: 'CLEAR_VAULTED_HISTORY';
}

/**
 * Which vaulted bookmarks still have a visit in Chrome's history (§12.6).
 *
 * One scan for the whole vault, because the alternative is a query per row. Asked by the manager
 * when it loads and after anything that could change the answer; never on the path of a keystroke.
 */
export interface HistoryPresenceRequest {
  readonly type: 'HISTORY_PRESENCE';
}

/**
 * Delete the history entries for one bookmark's page — not for its site.
 *
 * The narrow counterpart of `CLEAR_VAULTED_HISTORY`, offered in the detail pane under the title of
 * the bookmark it is about. The page-matching rule lives in `history/match.ts`.
 */
export interface ForgetItemHistoryRequest {
  readonly type: 'FORGET_ITEM_HISTORY';
  readonly id: string;
}

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
  | GetThumbRequest
  | RefreshThumbRequest
  | LookupActiveTabRequest
  | GetTreeRequest
  | ListViewRequest
  | GetItemRequest
  | CreateFolderRequest
  | UpdateItemRequest
  | MoveItemsRequest
  | DeleteFolderRequest
  | TagItemsRequest
  | RenameTagRequest
  | CountTrackingParamsRequest
  | StripTrackingParamsRequest
  | ChangePasswordRequest
  | DestroyVaultRequest
  | GetSyncStatusRequest
  | SyncNowRequest
  | ListConflictsRequest
  | ResolveConflictsRequest
  | ReplaceRemoteVaultRequest
  | AdoptRemoteVaultRequest
  | ExportVaultRequest
  | PreviewImportRequest
  | ImportVaultRequest
  | GetRollbackRequest
  | RollbackImportRequest
  | NativeTreeRequest
  | ImportNativeRequest
  | DeleteNativeRequest
  | GetDriveStateRequest
  | GetDiagnosticsRequest
  | ConnectDriveRequest
  | DisconnectDriveRequest
  | GetOnboardingRequest
  | SetOnboardingRequest
  | PreviewHistoryCleanupRequest
  | ClearVaultedHistoryRequest
  | HistoryPresenceRequest
  | ForgetItemHistoryRequest;

/** A partial settings update. Absent fields keep their stored value. */
export type SettingsPatch = Partial<VaultSettings>;

/**
 * A partial onboarding update.
 *
 * `completed` is a boolean rather than a timestamp because the *worker* stamps the clock: a page
 * that could name the completion time could also name one in 1970 and turn the flow back on for
 * everyone, and there is no reason for the wire to carry a number the receiver already knows.
 */
export interface OnboardingPatch {
  readonly step?: number;
  readonly incognitoSkipped?: boolean;
  readonly completed?: boolean;
}

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

/**
 * The vault is gone from this profile. `remoteRemoved` says what happened to the synced copy.
 *
 * Three states, and the screen says a different sentence for each: `true` (it was removed), `false`
 * (it was asked for and could not be — Drive offline, the grant withdrawn), and `null` (the user
 * unticked the box, so it is still there on purpose). The local erase succeeded in all three; a
 * failure to reach a backend is not allowed to stop someone destroying their own vault.
 */
export interface DestroyedResponse {
  readonly type: 'DESTROYED';
  readonly remoteRemoved: boolean | null;
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
  /**
   * Whether there is a preview to open — a picture, **or** the page's own title and summary.
   *
   * A boolean and not the thing itself, for the reason the note is absent: the popup draws an eye
   * from it, and shipping the words (900 bytes) or the picture (up to 40 KB) with every row to
   * decide whether to draw an icon is the version of this that makes a list of 5,000 bookmarks
   * expensive. `GET_THUMB` fetches the card when one is actually opened. Same field, same meaning,
   * same source as {@link ListRow.hasPreview}.
   */
  readonly hasPreview: boolean;
}

export interface AddedResponse {
  readonly type: 'ADDED';
  /** `duplicate` means this URL was already vaulted; `item` is the one that was already there. */
  readonly status: 'added' | 'duplicate';
  readonly item: ItemSummary;
  /**
   * This is the moment to offer "keep thumbnails on this device only" (§14.4).
   *
   * True at most once per profile, and only from an entry point that has a window to ask in — the
   * keyboard shortcut and the context menu report on a badge and have nowhere to put a question, so
   * they never set it. The UI marks the offer as made whichever way it is answered.
   */
  readonly offerThumbnails?: boolean;
}

/**
 * What the popup is looking at: the vault item for the active tab, or `null`.
 *
 * `null` covers every reason there is nothing to say — no tab, a `chrome://` page, a scheme the
 * vault will not take, a page that simply is not saved. The popup treats them identically, so none
 * of them is an error and none of them produces a message on open.
 */
export interface ActiveTabResponse {
  readonly type: 'ACTIVE_TAB';
  readonly item: ItemSummary | null;
}

/**
 * One preview picture, or the reason there is none.
 *
 * The bytes travel as base64url text for the same reason the export file does: `chrome.runtime`
 * structured-clones, and a page turns this straight into a blob URL it revokes when the preview
 * closes. Nothing is written down on the page's side.
 */
export interface ThumbResponse {
  readonly type: 'THUMB';
  readonly id: string;
  /**
   * `ready` — bytes are here. `remote` — the item has a picture and this device cannot reach it,
   * so the row degrades quietly to favicon and title. `none` — there is no picture at all.
   */
  readonly state: 'ready' | 'remote' | 'none';
  readonly image: string | null;
  readonly width: number;
  readonly height: number;
  /**
   * The card's text — `og:title` and `og:description` as the page published them (§14.5).
   *
   * Carried here rather than on {@link ListRow} for the same reason the note is not on a row: it is
   * up to 900 bytes an item, and a five-thousand-row view would put four megabytes of it on the
   * wire to decide whether to draw an icon. This response is fetched exactly when a card opens.
   *
   * Independent of {@link state}. A page whose image was refused — CSP, a CDN, a `data:` URL we
   * would not follow — can still have published a perfectly good title and summary, and that is
   * the case this text was captured for.
   */
  readonly ogTitle: string | null;
  readonly ogDescription: string | null;
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
  /**
   * This item has a preview card to show (§14.5).
   *
   * A boolean for the same reason `hasNote` is one: it decides whether a row draws an eye icon, and
   * shipping forty kilobytes of picture per row to answer that would be absurd. Whether the *bytes*
   * are reachable from this device is a separate question, asked with {@link GetThumbRequest} when
   * somebody actually looks.
   *
   * It means a picture **or** the page's own title and summary. It was `hasThumb` and meant only
   * the picture, which left a bookmark whose image had been refused — CSP, a CDN, a `data:` URL —
   * with a card's worth of captured text and no way to open it.
   */
  readonly hasPreview: boolean;
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

/* --- import and export (Phase 8) ------------------------------------------- */

/**
 * A file the page is about to hand to the user.
 *
 * The bytes cross `chrome.runtime` as text, which is the one place decrypted vault content is
 * allowed to travel (see the note at the top of this file): the worker holds the key and the page
 * holds the download. It is never written to storage on either side — the page turns it straight
 * into an object URL and revokes it.
 */
export interface FileResponse {
  readonly type: 'FILE';
  readonly filename: string;
  readonly mime: string;
  readonly text: string;
}

/** What an import file holds, before anything is applied. */
export interface ImportPreviewResponse {
  readonly type: 'IMPORT_PREVIEW';
  readonly bookmarks: number;
  readonly folders: number;
  /** Tombstones carried in the file, so a merge does not resurrect what was deleted. */
  readonly deleted: number;
  readonly oldest: number | null;
  readonly newest: number | null;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly schemaVersion: number;
  readonly includesThumbs: boolean;
  /** Ids the vault already has — the ceiling on how many items a merge could disagree about. */
  readonly known: number;
  /**
   * Which of the two `.vmv` shapes this was: a backup, or the live sync container from Drive.
   *
   * Both are importable and both hold the same kind of thing, but they are not the same object and
   * the confirmation must not pretend otherwise — a container has no creation date and no writing
   * version, only a "last changed".
   */
  readonly origin: 'backup' | 'sync';
}

export interface ImportResultResponse {
  readonly type: 'IMPORT_RESULT';
  readonly mode: 'merge' | 'replace';
  readonly total: number;
  readonly added: number;
  readonly updated: number;
  readonly conflicts: number;
  /** Whether an undo was kept. Replace mode only. */
  readonly rollback: boolean;
}

export interface RollbackResponse {
  readonly type: 'ROLLBACK';
  readonly available: boolean;
  readonly createdAt: number | null;
  readonly expiresAt: number | null;
}

/** One node of Chrome's bookmark tree, as the picker renders it. */
export interface NativeNodeView {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly children?: readonly NativeNodeView[];
}

export interface NativeTreeResponse {
  readonly type: 'NATIVE_TREE_STATE';
  /** False when the optional `bookmarks` permission has not been granted; `nodes` is then empty. */
  readonly granted: boolean;
  readonly nodes: readonly NativeNodeView[];
}

export interface NativeImportResponse {
  readonly type: 'NATIVE_IMPORT';
  readonly bookmarks: number;
  readonly folders: number;
  readonly duplicates: number;
  /** Bookmarks whose URL the vault will not store — `javascript:`, `file:`, a Chrome page. */
  readonly skipped: number;
}

export interface NativeDeleteResponse {
  readonly type: 'NATIVE_DELETE';
  readonly removed: number;
  /** Chrome refused these — its permanent folders cannot be deleted. */
  readonly failed: number;
}

/* --- Drive sync (Phase 10) ------------------------------------------------- */

/**
 * What the settings screen needs to draw the Drive section.
 *
 * `configured` is about the *build*, not the user: a source build with no `VM_OAUTH_CLIENT_ID` has
 * no Google project behind it and cannot offer Drive at all. Saying so is better than a button that
 * fails with something cryptic.
 */
export interface DriveStateResponse {
  readonly type: 'DRIVE_STATE';
  readonly configured: boolean;
  /** Whether the optional `identity` permission and the googleapis origin have been granted. */
  readonly granted: boolean;
  /** Whether this profile is actually syncing through Drive right now. */
  readonly connected: boolean;
  readonly email: string | null;
  /** Drive's own "open this file" address, learned from the API. Never built by us. */
  readonly fileLink: string | null;
}

/**
 * The redacted bug-report dump, already redacted (Phase 12).
 *
 * The payload is a {@link Diagnostics} record — a flat set of counts, booleans and enums with no
 * free-form string in it anywhere. See `shared/diagnostics.ts` for the rule that keeps it that way.
 */
export interface DiagnosticsResponse {
  readonly type: 'DIAGNOSTICS';
  readonly diagnostics: Diagnostics;
}

/** The outcome of a provider migration (§6.6). `ok: false` means nothing was flipped. */
export interface MigrationResponse {
  readonly type: 'MIGRATION';
  readonly ok: boolean;
  readonly providerId: 'chrome' | 'drive';
  readonly reason?: 'locked' | 'auth' | 'offline' | 'too-large' | 'mismatch' | 'verify' | 'unknown';
  /** Roughly how many bookmarks Chrome sync would hold, when the answer is `too-large`. */
  readonly fits?: number;
  readonly items?: number;
}

/* --- onboarding and history hygiene (Phase 9) ------------------------------ */

export interface OnboardingResponse {
  readonly type: 'ONBOARDING';
  readonly completedAt: number | null;
  readonly step: number;
  readonly incognitoSkipped: boolean;
}

/** One vaulted domain and what it has in history. */
export interface HistoryDomainCount {
  readonly domain: string;
  readonly entries: number;
}

/**
 * The dry run.
 *
 * The per-domain list travels because §12.2 asks for "Review the list" and a count on its own is
 * not reviewable — "143 entries across 27 domains" is a number you either accept or abandon, while
 * a list is something you can disagree with. It is decrypted vault content, which is allowed on this
 * wire and only on this wire (see the note at the top of this file): it goes to an extension page,
 * while the vault is unlocked, and is never written down on either side.
 */
export interface HistoryPreviewResponse {
  readonly type: 'HISTORY_PREVIEW';
  /** False when the optional `history` permission has not been granted; the rest is then empty. */
  readonly granted: boolean;
  /** Only the domains that actually have history. Ordered as the vault yielded them. */
  readonly domains: readonly HistoryDomainCount[];
  /** How many distinct vaulted domains were searched, including the ones with nothing. */
  readonly searched: number;
  readonly entries: number;
}

/**
 * Which bookmarks Chrome's history still holds a visit to (§12.6).
 *
 * Ids and nothing else. The page already knows the titles and addresses of the rows it is showing —
 * it drew them — so the answer to "which of these is still in history" needs to carry no vault
 * content of its own, and deliberately does not.
 */
export interface HistoryPresenceResponse {
  readonly type: 'HISTORY_PRESENCE';
  /** False when the optional `history` permission has not been granted; `ids` is then empty. */
  readonly granted: boolean;
  readonly ids: readonly string[];
}

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
  /** Reading the browser's bookmarks needs the optional `bookmarks` permission, and it is not on. */
  | 'BOOKMARKS_PERMISSION'
  /** Clearing history needs the optional `history` permission, and it is not on. */
  | 'HISTORY_PERMISSION'
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
  readonly GET_THUMB: ThumbResponse;
  readonly REFRESH_THUMB: ThumbResponse;
  readonly LOOKUP_ACTIVE_TAB: ActiveTabResponse;
  readonly GET_TREE: TreeResponse;
  readonly LIST_VIEW: ViewResponse;
  readonly GET_ITEM: ItemResponse;
  readonly CREATE_FOLDER: CreatedResponse;
  readonly UPDATE_ITEM: OkResponse;
  readonly MOVE_ITEMS: CountResponse;
  readonly DELETE_FOLDER: OkResponse;
  readonly TAG_ITEMS: CountResponse;
  readonly RENAME_TAG: CountResponse;
  readonly COUNT_TRACKING_PARAMS: CountResponse;
  readonly STRIP_TRACKING_PARAMS: CountResponse;
  readonly CHANGE_PASSWORD: OkResponse;
  readonly DESTROY_VAULT: DestroyedResponse;
  readonly GET_SYNC_STATUS: SyncStatusResponse;
  readonly SYNC_NOW: SyncStatusResponse;
  readonly LIST_CONFLICTS: ConflictsResponse;
  readonly RESOLVE_CONFLICTS: CountResponse;
  readonly REPLACE_REMOTE_VAULT: SyncStatusResponse;
  readonly ADOPT_REMOTE_VAULT: SyncStatusResponse;
  readonly EXPORT_VAULT: FileResponse;
  readonly PREVIEW_IMPORT: ImportPreviewResponse;
  readonly IMPORT_VAULT: ImportResultResponse;
  readonly GET_ROLLBACK: RollbackResponse;
  readonly ROLLBACK_IMPORT: CountResponse;
  readonly NATIVE_TREE: NativeTreeResponse;
  readonly IMPORT_NATIVE: NativeImportResponse;
  readonly DELETE_NATIVE: NativeDeleteResponse;
  readonly GET_DRIVE_STATE: DriveStateResponse;
  readonly GET_DIAGNOSTICS: DiagnosticsResponse;
  readonly CONNECT_DRIVE: MigrationResponse;
  readonly DISCONNECT_DRIVE: MigrationResponse;
  readonly GET_ONBOARDING: OnboardingResponse;
  readonly SET_ONBOARDING: OnboardingResponse;
  readonly PREVIEW_HISTORY_CLEANUP: HistoryPreviewResponse;
  readonly CLEAR_VAULTED_HISTORY: CountResponse;
  readonly HISTORY_PRESENCE: HistoryPresenceResponse;
  readonly FORGET_ITEM_HISTORY: CountResponse;
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

/**
 * How far along a long import or export is (Phase 8).
 *
 * Sent from the worker while it works, because the work is in the worker and the progress bar is in
 * the page: a five-thousand-bookmark import is one message that takes seconds to answer, and a UI
 * with nothing between the click and the answer is a UI people click again.
 *
 * Carries counts and a phase, never an item. `done`/`total` are units of work, not bookmarks that
 * could be identified — and `total` may be zero for a phase whose length is not known in advance.
 */
export interface IoProgressBroadcast {
  readonly type: 'IO_PROGRESS';
  readonly job: 'export' | 'import' | 'native';
  readonly done: number;
  readonly total: number;
}

/**
 * Which step of connecting or disconnecting Drive is running (Phase 12).
 *
 * Same shape of problem as {@link IoProgressBroadcast} and, until this landed, the same untreated
 * one: `migration.ts` has always reported its phase through an `onPhase` callback documented as
 * "reported as it goes, so a slow upload is not a frozen screen", and nothing was subscribed to it.
 * Settings said "Asking Google for permission…" for the whole run — through the authorization, the
 * upload of an entire vault, a verifying read-back and the switch — so the one phase that is over
 * in a second was the only one the screen ever named.
 *
 * Carries the phase and nothing else. A phase name is an enum from our own source; the vault it is
 * moving is not describable here (INV-6) and does not need to be.
 */
export interface MigrationProgressBroadcast {
  readonly type: 'MIGRATION_PROGRESS';
  readonly phase: 'authorizing' | 'uploading' | 'verifying' | 'switching' | 'cleaning' | 'done';
}

/** Service worker → open UIs. Never answered; `broadcast()` ignores the absence of a listener. */
export type Broadcast =
  | SessionLockedBroadcast
  | SessionUnlockedBroadcast
  | SettingsChangedBroadcast
  | VaultChangedBroadcast
  | SyncChangedBroadcast
  | IoProgressBroadcast
  | MigrationProgressBroadcast;

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
    case 'LOOKUP_ACTIVE_TAB':
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
    case 'COUNT_TRACKING_PARAMS':
    case 'STRIP_TRACKING_PARAMS':
    case 'GET_SYNC_STATUS':
    case 'SYNC_NOW':
    case 'LIST_CONFLICTS':
    case 'GET_ROLLBACK':
    case 'ROLLBACK_IMPORT':
    case 'NATIVE_TREE':
    case 'GET_DRIVE_STATE':
    case 'GET_DIAGNOSTICS':
    case 'GET_ONBOARDING':
    case 'PREVIEW_HISTORY_CLEANUP':
    case 'CLEAR_VAULTED_HISTORY':
    case 'HISTORY_PRESENCE':
    case 'REPLACE_REMOTE_VAULT':
      return { type };
    case 'DESTROY_VAULT':
    case 'DISCONNECT_DRIVE': {
      const deleteRemote = raw['deleteRemote'];
      if (deleteRemote === undefined) return { type };
      return typeof deleteRemote === 'boolean' ? { type, deleteRemote } : null;
    }
    case 'CONNECT_DRIVE': {
      const replaceExisting = raw['replaceExisting'];
      if (replaceExisting === undefined) return { type };
      return typeof replaceExisting === 'boolean' ? { type, replaceExisting } : null;
    }
    case 'ADOPT_REMOTE_VAULT': {
      const password = raw['password'];
      const from = raw['from'];
      if (typeof password !== 'string') return null;
      if (from !== 'chrome' && from !== 'drive') return null;
      return { type, password, from };
    }
    case 'SET_ONBOARDING': {
      const patch = parseOnboardingPatch(raw['patch']);
      return patch === null ? null : { type, patch };
    }
    case 'EXPORT_VAULT': {
      const password = raw['password'];
      const mode = raw['mode'];
      if (typeof password !== 'string') return null;
      if (mode !== 'vault' && mode !== 'custom') return null;
      return { type, password, mode };
    }
    case 'PREVIEW_IMPORT': {
      const file = raw['file'];
      const password = raw['password'];
      if (!isNonEmptyString(file) || typeof password !== 'string') return null;
      return { type, file, password };
    }
    case 'IMPORT_VAULT': {
      const file = raw['file'];
      const password = raw['password'];
      const mode = raw['mode'];
      if (!isNonEmptyString(file) || typeof password !== 'string') return null;
      if (mode !== 'merge' && mode !== 'replace') return null;
      return { type, file, password, mode };
    }
    case 'IMPORT_NATIVE': {
      const ids = parseIdList(raw['ids']);
      const parentId = raw['parentId'];
      if (ids === null) return null;
      if (parentId !== undefined && !isNonEmptyString(parentId)) return null;
      return { type, ids, ...(parentId === undefined ? {} : { parentId }) };
    }
    case 'DELETE_NATIVE': {
      const ids = parseIdList(raw['ids']);
      return ids === null ? null : { type, ids };
    }
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
    case 'GET_ITEM':
    case 'GET_THUMB':
    case 'FORGET_ITEM_HISTORY':
    case 'REFRESH_THUMB': {
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
      const afterId = raw['afterId'];
      if (ids === null || !isNonEmptyString(parentId)) return null;
      // Three distinct answers, and the parser has to keep them apart: absent means "append",
      // `null` means "first", and a string means "after that one". Collapsing absent into `null`
      // would silently turn every drop onto a folder into a drop at the top of it.
      if (afterId === undefined) return { type, ids, parentId };
      if (afterId !== null && !isNonEmptyString(afterId)) return null;
      return { type, ids, parentId, afterId };
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

/** Validate an onboarding update. Rejects the whole patch on any bad field, like the others here. */
export function parseOnboardingPatch(raw: unknown): OnboardingPatch | null {
  if (!isRecord(raw)) return null;
  const patch: { -readonly [K in keyof OnboardingPatch]: OnboardingPatch[K] } = {};

  const step = raw['step'];
  if (step !== undefined) {
    if (typeof step !== 'number' || !Number.isInteger(step) || step < 0) return null;
    patch.step = step;
  }

  const incognitoSkipped = raw['incognitoSkipped'];
  if (incognitoSkipped !== undefined) {
    if (typeof incognitoSkipped !== 'boolean') return null;
    patch.incognitoSkipped = incognitoSkipped;
  }

  const completed = raw['completed'];
  if (completed !== undefined) {
    if (typeof completed !== 'boolean') return null;
    patch.completed = completed;
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

  const clearHistoryOnLock = raw['clearHistoryOnLock'];
  if (clearHistoryOnLock !== undefined) {
    if (typeof clearHistoryOnLock !== 'boolean') return null;
    patch.clearHistoryOnLock = clearHistoryOnLock;
  }

  const quickClose = raw['quickClose'];
  if (quickClose !== undefined) {
    if (typeof quickClose !== 'boolean') return null;
    patch.quickClose = quickClose;
  }

  const localThumbnails = raw['localThumbnails'];
  if (localThumbnails !== undefined) {
    if (typeof localThumbnails !== 'boolean') return null;
    patch.localThumbnails = localThumbnails;
  }

  const thumbnailsOffered = raw['thumbnailsOffered'];
  if (thumbnailsOffered !== undefined) {
    if (typeof thumbnailsOffered !== 'boolean') return null;
    patch.thumbnailsOffered = thumbnailsOffered;
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
  'THUMB',
  'TREE',
  'VIEW',
  'ITEM',
  'CREATED',
  'COUNT',
  'SYNC_STATUS',
  'CONFLICTS',
  'FILE',
  'IMPORT_PREVIEW',
  'IMPORT_RESULT',
  'ROLLBACK',
  'NATIVE_TREE_STATE',
  'NATIVE_IMPORT',
  'NATIVE_DELETE',
  'ONBOARDING',
  'HISTORY_PREVIEW',
  'HISTORY_PRESENCE',
  'DRIVE_STATE',
  'DIAGNOSTICS',
  'MIGRATION',
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
  'IO_PROGRESS',
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
