/**
 * The wire-code → `_locales` key tables.
 *
 * Errors cross the service-worker boundary as codes rather than as sentences (see
 * `shared/messages.ts`), so every UI has to turn a code back into text. Two pages doing that from
 * two tables is two places to forget a new code — and TypeScript only catches the omission where
 * the table is `Record<ErrorCode, string>`, which is here.
 *
 * There is no fallback branch on purpose. A missing key would render as an empty string, which is
 * indistinguishable from "nothing went wrong"; an exhaustive record makes it a compile error.
 */

import { MIN_PASSWORD_LENGTH, type PasswordWarning } from '../crypto/password.js';
import type { ErrorCode, LockReason, SyncErrorCode } from '../shared/messages.js';
import { msg } from './dom.js';

export const ERROR_KEYS: Record<ErrorCode, string> = {
  WRONG_PASSWORD: 'errorWrongPassword',
  PASSWORD_TOO_SHORT: 'errorPasswordTooShort',
  CORRUPT_VAULT: 'errorCorruptVault',
  UNSUPPORTED_SCHEMA: 'errorUnsupportedSchema',
  VAULT_LOCKED: 'errorVaultLocked',
  VAULT_STATE: 'errorVaultState',
  ITEM_NOT_FOUND: 'errorItemNotFound',
  INVALID_MUTATION: 'errorInvalidMutation',
  NO_ACTIVE_TAB: 'errorNoActiveTab',
  URL_INTERNAL_PAGE: 'errorUrlInternalPage',
  URL_LOCAL_FILE: 'errorUrlLocalFile',
  URL_UNSUPPORTED_SCHEME: 'errorUrlUnsupportedScheme',
  SYNC_FAILED: 'errorSyncFailed',
  BOOKMARKS_PERMISSION: 'errorBookmarksPermission',
  UNREACHABLE: 'errorUnreachable',
  UNKNOWN: 'errorUnknown',
};

/**
 * Why a sync failed, in words.
 *
 * A separate table from {@link ERROR_KEYS} because these are not failures of something the user
 * just did: they describe a background process, they are shown in a status line rather than beside
 * a button, and most of them are temporary. "Sync storage is full" needs a different tone — and a
 * different call to action — from "that URL cannot be vaulted".
 */
export const SYNC_ERROR_KEYS: Record<SyncErrorCode, string> = {
  QUOTA_EXCEEDED: 'syncErrorQuotaExceeded',
  RATE_LIMITED: 'syncErrorRateLimited',
  OFFLINE: 'syncErrorOffline',
  AUTH_REQUIRED: 'syncErrorAuthRequired',
  CORRUPT_REMOTE: 'syncErrorCorruptRemote',
  PRECONDITION_FAILED: 'syncErrorPreconditionFailed',
  VAULT_LOCKED: 'syncErrorVaultLocked',
  VAULT_MISMATCH: 'syncErrorVaultMismatch',
  UNKNOWN: 'syncErrorUnknown',
};

export function syncErrorText(code: SyncErrorCode): string {
  return msg(SYNC_ERROR_KEYS[code]);
}

export const WARNING_KEYS: Record<PasswordWarning, string> = {
  'too-short': 'warnTooShort',
  'common-password': 'warnCommonPassword',
  'common-password-variant': 'warnCommonPasswordVariant',
  'single-character-class': 'warnSingleCharacterClass',
  'repeated-characters': 'warnRepeatedCharacters',
  'sequential-characters': 'warnSequentialCharacters',
  'keyboard-pattern': 'warnKeyboardPattern',
  'year-like': 'warnYearLike',
};

export const LOCK_REASON_KEYS: Record<LockReason, string> = {
  manual: 'lockedManual',
  panic: 'lockedPanic',
  expired: 'lockedExpired',
  idle: 'lockedIdle',
  blur: 'lockedBlur',
};

/** A localized sentence for an error code. The one code carrying a number gets it substituted. */
export function errorText(code: ErrorCode): string {
  return code === 'PASSWORD_TOO_SHORT'
    ? msg(ERROR_KEYS[code], [String(MIN_PASSWORD_LENGTH)])
    : msg(ERROR_KEYS[code]);
}
