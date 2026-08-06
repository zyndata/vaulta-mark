/**
 * The half of `vm.settings` that travels with the vault (PLAN §9 Phase 10).
 *
 * A second Chrome profile that joins a synced vault used to start from the defaults: theme, idle
 * timeout, lock-on-blur, the tracking strip, the sort order — all of it set again by hand, on every
 * computer. This is the fix, and it is four decisions rather than one move.
 *
 * **It goes inside the ciphertext.** INV-6 is about vault *content* and a theme is not content — but
 * `chrome.storage.sync` is replicated by Google whatever it holds, and "which of our users leaves
 * the vault unlocked forever" is not a fact worth publishing in the clear when encrypting it is
 * free.
 *
 * **Two settings deliberately stay behind.** `sidebarWidth`/`detailWidth` describe a *screen*, so a
 * laptop must not inherit a desktop's column widths; `providerId` describes *this profile's*
 * connection, and syncing it would tell a profile with no Drive token to use Drive. `vm.settings`
 * therefore does not go away — it becomes the per-device half of a two-part record.
 *
 * **Last writer wins, per field, and there is no conflict UI.** Two devices disagreeing about a
 * theme is not a disagreement worth interrupting anybody over. Per *field* rather than per record so
 * that a device changing the sort order does not silently revert another's idle timeout.
 *
 * **A tie is broken by value, not by device.** Equal timestamps happen — two devices changed the
 * same field in the same millisecond, or a clock is wrong — and "whichever merged last" would make
 * the merge order-dependent, which is the one property §6.4's convergence proof cannot do without.
 * Comparing the values themselves is arbitrary but it is the *same* arbitrary answer on both sides.
 */

import { isSortKey, type VaultSettings } from './types.js';

/** The fields that travel. Anything absent from this list is per-device by omission, deliberately. */
export const SYNCED_SETTING_KEYS = [
  'theme',
  'idleTimeoutMinutes',
  'lockOnBrowserBlur',
  'stripTrackingParams',
  'reuseIncognitoWindow',
  'clearHistoryOnLock',
  'quickClose',
  'sortBy',
] as const;

export type SyncedSettingKey = (typeof SYNCED_SETTING_KEYS)[number];

/** One field's value, and when it last changed on the device that changed it. */
export interface SyncedField {
  readonly v: string | number | boolean;
  /** Epoch ms. Used for ordering only — never for correctness anywhere else (§6.2). */
  readonly at: number;
}

export type SyncedSettings = Readonly<Partial<Record<SyncedSettingKey, SyncedField>>>;

export const EMPTY_SYNCED_SETTINGS: SyncedSettings = {};

/**
 * Record a settings change: stamp the fields this edit actually moved, and touch nothing else.
 *
 * **A field nobody has ever changed stays absent from the record**, and that is the important part.
 * The obvious implementation — write every field at `now` — makes the *first* device to change one
 * preference claim all eight, including the seven still sitting at their defaults, at a timestamp
 * newer than another device's genuine edit. The other device's theme then loses to a default nobody
 * chose. An absent field simply defers to whichever device has an opinion, which is what an
 * untouched preference should do.
 *
 * A field whose value did not change keeps its old timestamp, so opening the settings screen cannot
 * outrank a real edit either.
 */
export function stampSettings(
  record: SyncedSettings,
  previous: VaultSettings,
  next: VaultSettings,
  now: number,
): SyncedSettings {
  const stamped: Partial<Record<SyncedSettingKey, SyncedField>> = { ...record };
  for (const key of SYNCED_SETTING_KEYS) {
    if (next[key] === previous[key]) continue;
    stamped[key] = { v: next[key], at: now };
  }
  return stamped;
}

/**
 * Fold two records together, newest per field.
 *
 * Symmetric by construction: `merge(a, b)` and `merge(b, a)` produce the same record, including for
 * the tie. That is not tidiness — the sync engine merges on whichever device notices first, and a
 * merge that depended on which side was called `mine` would leave two devices trading revisions
 * over a theme forever.
 */
export function mergeSyncedSettings(mine: SyncedSettings, theirs: SyncedSettings): SyncedSettings {
  const merged: Partial<Record<SyncedSettingKey, SyncedField>> = {};
  for (const key of SYNCED_SETTING_KEYS) {
    const a = mine[key];
    const b = theirs[key];
    if (a === undefined) {
      if (b !== undefined) merged[key] = b;
      continue;
    }
    if (b === undefined) {
      merged[key] = a;
      continue;
    }
    if (a.at !== b.at) {
      merged[key] = a.at > b.at ? a : b;
      continue;
    }
    // Equal timestamps: pick by value, so both devices pick the same one.
    merged[key] = String(a.v) <= String(b.v) ? a : b;
  }
  return merged;
}

/** Whether two records say the same thing. The engine's "is there anything to push?" question. */
export function sameSyncedSettings(a: SyncedSettings, b: SyncedSettings): boolean {
  return SYNCED_SETTING_KEYS.every((key) => {
    const one = a[key];
    const two = b[key];
    if (one === undefined || two === undefined) return one === two;
    return one.v === two.v && one.at === two.at;
  });
}

/**
 * Apply a record over the local settings.
 *
 * Every value is validated on the way in, for the same reason `readSettings` validates: these bytes
 * came out of a vault written by some other build of VaultaMark, and a `theme` of `"purple"` must
 * leave the theme alone rather than produce a page with no styles.
 */
export function applySyncedSettings(
  local: VaultSettings,
  record: SyncedSettings,
): VaultSettings {
  return {
    ...local,
    theme: pick(record.theme, local.theme, ['system', 'light', 'dark']),
    idleTimeoutMinutes: nonNegative(record.idleTimeoutMinutes, local.idleTimeoutMinutes),
    lockOnBrowserBlur: flag(record.lockOnBrowserBlur, local.lockOnBrowserBlur),
    stripTrackingParams: flag(record.stripTrackingParams, local.stripTrackingParams),
    reuseIncognitoWindow: flag(record.reuseIncognitoWindow, local.reuseIncognitoWindow),
    clearHistoryOnLock: flag(record.clearHistoryOnLock, local.clearHistoryOnLock),
    quickClose: flag(record.quickClose, local.quickClose),
    sortBy: isSortKey(record.sortBy?.v) ? record.sortBy.v : local.sortBy,
  };
}

/**
 * Validate a decrypted record.
 *
 * The bytes authenticated before they got here, so this is not defending against an attacker — it
 * is defending against a record written by a newer build with a field this one has never heard of,
 * which is dropped rather than carried into a `VaultSettings`.
 */
export function parseSyncedSettings(raw: unknown): SyncedSettings {
  if (raw === null || typeof raw !== 'object') return EMPTY_SYNCED_SETTINGS;
  const stored = raw as Record<string, unknown>;
  const out: Partial<Record<SyncedSettingKey, SyncedField>> = {};
  for (const key of SYNCED_SETTING_KEYS) {
    const entry = stored[key];
    if (entry === null || typeof entry !== 'object') continue;
    const field = entry as Partial<SyncedField>;
    const value = field.v;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    if (typeof field.at !== 'number' || !Number.isFinite(field.at)) continue;
    out[key] = { v: value, at: field.at };
  }
  return out;
}

function flag(field: SyncedField | undefined, fallback: boolean): boolean {
  return typeof field?.v === 'boolean' ? field.v : fallback;
}

function nonNegative(field: SyncedField | undefined, fallback: number): number {
  const value = field?.v;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function pick<T extends string>(
  field: SyncedField | undefined,
  fallback: T,
  allowed: readonly T[],
): T {
  const value = field?.v;
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
