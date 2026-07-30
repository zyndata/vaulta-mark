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

import type { VaultSettings } from '../vault/types.js';

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

export interface DeleteItemRequest {
  readonly type: 'DELETE_ITEM';
  readonly id: string;
}

/** Undo a delete. The tombstone still holds the item, so this restores it under its own id. */
export interface RestoreItemRequest {
  readonly type: 'RESTORE_ITEM';
  readonly id: string;
}

/** Is "Allow in Incognito" on? `recheck` bypasses the per-worker cache for the Re-check button. */
export interface IncognitoAccessRequest {
  readonly type: 'INCOGNITO_ACCESS';
  readonly recheck?: boolean;
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
  | DeleteItemRequest
  | RestoreItemRequest
  | IncognitoAccessRequest;

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
  /** There was no active tab to read, or `activeTab` did not grant us its URL. */
  | 'NO_ACTIVE_TAB'
  /** A Chrome page, our own pages, `about:` — nothing we could reopen in incognito later. */
  | 'URL_INTERNAL_PAGE'
  /** A `file://` URL. Incognito windows will not open it, so vaulting it would be a dead entry. */
  | 'URL_LOCAL_FILE'
  /** Any other scheme we refuse to store: `javascript:`, `data:`, `blob:`, and the long tail. */
  | 'URL_UNSUPPORTED_SCHEME'
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
  readonly DELETE_ITEM: OkResponse;
  readonly RESTORE_ITEM: OkResponse;
  readonly INCOGNITO_ACCESS: IncognitoAccessResponse;
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

/** Service worker → open UIs. Never answered; `broadcast()` ignores the absence of a listener. */
export type Broadcast =
  | SessionLockedBroadcast
  | SessionUnlockedBroadcast
  | SettingsChangedBroadcast
  | VaultChangedBroadcast;

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
    case 'DELETE_ITEM':
    case 'RESTORE_ITEM': {
      const id = raw['id'];
      return typeof id === 'string' && id !== '' ? { type, id } : null;
    }
    case 'INCOGNITO_ACCESS': {
      const recheck = raw['recheck'];
      if (recheck === undefined) return { type };
      return typeof recheck === 'boolean' ? { type, recheck } : null;
    }
    default:
      return null;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
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
