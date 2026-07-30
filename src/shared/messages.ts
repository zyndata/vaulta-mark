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
 * - **No message carries vault content or a key.** The unlocked DEK never leaves the service
 *   worker, and no message here has a field it could travel in.
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

export type Request =
  | PingRequest
  | GetStateRequest
  | CreateVaultRequest
  | UnlockRequest
  | LockRequest
  | TouchRequest
  | GetSettingsRequest
  | SetSettingsRequest;

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

/** Service worker → open UIs. Never answered; `broadcast()` ignores the absence of a listener. */
export type Broadcast =
  | SessionLockedBroadcast
  | SessionUnlockedBroadcast
  | SettingsChangedBroadcast;

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
    default:
      return null;
  }
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

  return patch;
}

const RESPONSE_TYPES: ReadonlySet<string> = new Set([
  'PONG',
  'STATE',
  'OK',
  'SETTINGS',
  'TOUCHED',
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
