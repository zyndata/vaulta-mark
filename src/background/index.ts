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
  onRequest,
  type ErrorCode,
  type Request,
  type Response,
} from '../shared/messages.js';
import { VaultLockedError, VaultStateError, WeakPasswordError } from '../vault/errors.js';
import { armHousekeeping, registerLifecycleListeners } from './autolock.js';
import { registerCommandListener } from './commands.js';
import * as session from './session.js';

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
  return 'UNKNOWN';
}

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
    }
  } catch (error) {
    // Nothing here may reach a log: a request carries a master password, and the errors that come
    // back from an unlock are exactly the ones whose context is most sensitive.
    return { type: 'ERROR', code: toErrorCode(error) };
  }
}

/* ------------------------------------------------------------------ registration */

onRequest(handleRequest);

registerLifecycleListeners({
  enforceDeadline: () => session.enforceDeadline(),
  housekeep: () => session.housekeep(),
  lock: (reason) => session.lock({ reason }),
  settings: () => session.settings(),
});

registerCommandListener({
  lock: (reason) => session.lock({ reason, flush: reason !== 'panic' }),
  touch: () => session.touch(),
});

/**
 * Once-per-browser-session setup.
 *
 * Both events, because `onInstalled` fires on install and update while `onStartup` fires on every
 * browser launch, and neither implies the other. Everything in here is idempotent.
 */
function onStart(): void {
  void (async () => {
    await session.hardenSessionStorage();
    await armHousekeeping();
  })();
}

chrome.runtime.onInstalled.addListener(onStart);
chrome.runtime.onStartup.addListener(onStart);
