/**
 * Gather the redacted bug-report dump (PLAN §9 Phase 12).
 *
 * This runs in the **worker**, and that is the design rather than an accident of where the data
 * happens to live. The worker is the only context that ever holds decrypted items, so it is the
 * only one that can count them — and because it hands back a finished {@link Diagnostics} record,
 * the page never receives anything it would then have to be trusted to redact. There is no version
 * of this feature where a decrypted item crosses `chrome.runtime` and is filtered on the far side.
 *
 * The shape of the record, and the rule that every field in it is a count, a boolean or an enum
 * drawn from our own source, is in `shared/diagnostics.ts`. Read that before adding a field here.
 *
 * Nothing in here may throw. A diagnostics report is what someone reaches for when the extension is
 * already misbehaving, so every source is wrapped: a `usage()` that fails because Drive is
 * unreachable must produce a report saying so, not a button that does nothing — the same lesson
 * `status()` learned in Phase 10.
 */

import type { SyncStatusResponse } from '../shared/messages.js';
import { chromeMajorFrom, type Diagnostics } from '../shared/diagnostics.js';
import {
  listIconNames,
  listThumbIds,
  readHeader,
  readSettings,
  thumbBytesInUse,
} from '../storage/local.js';
import { isBookmark, ROOT_ID } from '../vault/types.js';
import * as session from './session.js';
import * as syncing from './syncing.js';

/** Never rejects; a failed source becomes the fallback rather than an empty report. */
async function attempt<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

export async function collect(): Promise<Diagnostics> {
  const manifest = chrome.runtime.getManifest();
  // Not wrapped: `readSettings` is documented never to throw — a corrupt blob answers with the
  // defaults, because the worst case has to be a reset theme rather than a lock screen that will
  // not render. Wrapping it would add a dozen fallbacks behind a branch nothing can take.
  const settings = await readSettings();
  const header = await attempt(readHeader, null);
  // One fallback object rather than a `??` on each of seven fields: `syncStatus()` either answers
  // or it does not, and a report showing six real numbers and one invented zero would be worse
  // than one that says plainly it could not ask.
  const status = await attempt<SyncStatusResponse>(syncing.syncStatus, {
    type: 'SYNC_STATUS',
    phase: 'error',
    providerId: settings.providerId,
    lastSyncedAt: null,
    conflicts: 0,
    error: 'UNKNOWN',
    retryAfterMs: null,
    usedBytes: 0,
    quotaBytes: 0,
  });
  const repo = await attempt(async () => await session.currentRepository(), null);

  /*
   * The vault half, or nulls. `getAll()` on a locked vault is not a thing that can be asked, so
   * every count here is `null` while locked rather than 0 — and `formatDiagnostics` renders that
   * as `n/a`, because "0 bookmarks" and "the vault was locked when this was taken" are two very
   * different pieces of evidence in a bug report about missing bookmarks.
   */
  const items = repo === null ? null : repo.getAll({ includeDeleted: true });
  const live = items?.filter((item) => item.deleted !== true) ?? null;
  const bookmarks = live?.filter(isBookmark) ?? null;
  const tags =
    bookmarks === null ? null : new Set(bookmarks.flatMap((item) => item.tags ?? [])).size;

  const thumbIds = await attempt(listThumbIds, []);

  return {
    version: manifest.version,
    chromeMajor: chromeMajorFrom(navigator.userAgent),
    // `navigator.platform` is deprecated and, more to the point, more precise than this needs:
    // the useful fact in a bug report is which family of OS, and that is what this is.
    platform: platformFamily(navigator.userAgent),
    oauthConfigured: 'oauth2' in manifest,
    // A build loaded from a folder has a `key` pinning its id; a Store build does not. It is the
    // single most useful line here for a Drive problem — `redirect_uri_mismatch` names none of it.
    developmentBuild: 'key' in manifest,

    vaultExists: header !== null,
    locked: repo === null,
    schemaVersion: header?.schemaVersion ?? null,
    bookmarks: bookmarks?.length ?? null,
    folders:
      live === null
        ? null
        : live.filter((item) => item.type === 'folder' && item.id !== ROOT_ID).length,
    tags,
    tombstones: items === null ? null : items.filter((item) => item.deleted === true).length,
    withNotes: bookmarks === null ? null : bookmarks.filter((item) => (item.note ?? '') !== '').length,
    withThumbnails: bookmarks === null ? null : bookmarks.filter((item) => item.thumb !== undefined).length,

    localBytes: await attempt(async () => await chrome.storage.local.getBytesInUse(null), 0),
    buckets: header?.bucketCount ?? 0,
    thumbnailCacheBytes: await attempt(async () => await thumbBytesInUse(thumbIds), 0),
    storedIcons: (await attempt(listIconNames, [])).length,

    providerId: status.providerId,
    syncPhase: status.phase,
    syncError: status.error,
    conflicts: status.conflicts,
    // An elapsed time, not a clock reading: when the last sync happened is a fact about this
    // person's day, and how long ago it was is the fact that diagnoses a stuck sync.
    sinceLastSyncMs: status.lastSyncedAt === null ? null : Date.now() - status.lastSyncedAt,
    syncUsedBytes: status.usedBytes,
    syncQuotaBytes: status.quotaBytes,

    optionalPermissions: await grantedOptionalPermissions(),
    incognitoAllowed: await attempt(
      async () => await chrome.extension.isAllowedIncognitoAccess(),
      false,
    ),

    theme: settings.theme,
    idleTimeoutMinutes: settings.idleTimeoutMinutes,
    lockOnBrowserBlur: settings.lockOnBrowserBlur,
    stripTrackingParams: settings.stripTrackingParams,
    reuseIncognitoWindow: settings.reuseIncognitoWindow,
    clearHistoryOnLock: settings.clearHistoryOnLock,
    quickClose: settings.quickClose,
    localThumbnails: settings.localThumbnails,
    sortBy: settings.sortBy,
  };
}

/**
 * Which optional permissions are granted, asked one at a time about the manifest's own declared set.
 *
 * Deliberately not `chrome.permissions.getAll()`. That answers with an `origins` array of host
 * patterns as well, and an "everything Chrome felt like reporting" list is exactly the shape the
 * closed-field-list rule in `shared/diagnostics.ts` exists to keep out of this report — a new
 * optional origin would start appearing in bug reports with nobody having decided that it should.
 * The manifest's `optional_permissions` is a list this project wrote, and it is public anyway.
 */
async function grantedOptionalPermissions(): Promise<string[]> {
  const declared = chrome.runtime.getManifest().optional_permissions ?? [];
  const granted: string[] = [];
  for (const permission of declared) {
    // `getManifest()` types the array as plain strings while `contains()` wants the literal union.
    // The two describe one list, and it is the list in `build/manifest.ts`.
    const named = permission as chrome.runtime.ManifestPermission;
    const has = await attempt<boolean>(
      async (): Promise<boolean> => await chrome.permissions.contains({ permissions: [named] }),
      false,
    );
    if (has) granted.push(permission);
  }
  return granted;
}

/** Windows, macOS, Linux, ChromeOS or unknown. One word, from the user agent, never the whole string. */
export function platformFamily(userAgent: string): string {
  if (userAgent.includes('CrOS')) return 'chromeos';
  if (userAgent.includes('Windows')) return 'windows';
  if (userAgent.includes('Mac OS X')) return 'macos';
  if (userAgent.includes('Linux') || userAgent.includes('X11')) return 'linux';
  return 'unknown';
}
