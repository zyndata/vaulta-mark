/**
 * The "copy diagnostics" report (PLAN §9 Phase 12).
 *
 * A bug report about an encrypted bookmark manager is a hard thing to write. "Sync stopped working"
 * is not actionable, and the obvious way to make it actionable — paste what is on screen — is the
 * one thing this product exists to prevent. So there is a button that produces a report, and the
 * report is built to be safe to paste into a public issue tracker without reading it first.
 *
 * **The single rule this file exists to enforce: the report is assembled from a closed list of
 * named fields, never by walking an object.** {@link Diagnostics} is a flat record of primitives
 * with no index signature, and {@link formatDiagnostics} names every one of them. A version that
 * serialised `settings` or `syncStatus` wholesale would be shorter, would look identical today, and
 * would silently begin leaking the day somebody adds a field holding a folder name or an email —
 * which is precisely the kind of change nobody thinks to re-audit a diagnostics dump for.
 *
 * What is deliberately absent, and must stay absent: URLs, page titles, folder names, tag names,
 * notes, item ids, thumbnails, the Drive account's email address, the OAuth client id, file ids,
 * tokens of any kind, and the master password in every form including its length. Counts and
 * booleans only. A count is not content — it is already visible in the quota bar — and it is the
 * difference between "sync is stuck" and "sync is stuck with 1,100 bookmarks and 3 conflicts".
 */

/**
 * Everything the report may contain, and nothing else.
 *
 * Every field is a number, a boolean, or a string drawn from a fixed set defined in our own source.
 * A free-form string is never added here: `providerId` is safe because it is `'chrome' | 'drive'`,
 * and `syncError` because it is a {@link SyncErrorCode}, not because someone checked the value.
 */
export interface Diagnostics {
  /* --- build ------------------------------------------------------------- */
  readonly version: string;
  /** Chrome's major version, parsed out of the user agent. Never the full string, which is a fingerprint. */
  readonly chromeMajor: number | null;
  readonly platform: string;
  /** Whether this build has an OAuth client at all — never which one (RELEASE §5). */
  readonly oauthConfigured: boolean;
  /** A development build carries a manifest `key`; a Store build does not. Explains an id mismatch. */
  readonly developmentBuild: boolean;

  /* --- vault ------------------------------------------------------------- */
  readonly vaultExists: boolean;
  readonly locked: boolean;
  readonly schemaVersion: number | null;
  /** `null` while locked: these come from the decrypted item set and there is not one. */
  readonly bookmarks: number | null;
  readonly folders: number | null;
  readonly tags: number | null;
  readonly tombstones: number | null;
  readonly withNotes: number | null;
  readonly withThumbnails: number | null;

  /* --- storage ----------------------------------------------------------- */
  readonly localBytes: number;
  readonly buckets: number;
  readonly thumbnailCacheBytes: number;
  /**
   * How many hosts this device holds a stored favicon for (§10.1).
   *
   * A count, never a name: the names are HMACs and the hosts are the thing this report may not
   * carry. It is here because it is the one number that answers "did the icons arrive?" on a second
   * computer, which is the whole of what the feature claims.
   */
  readonly storedIcons: number;

  /* --- sync -------------------------------------------------------------- */
  readonly providerId: 'chrome' | 'drive';
  readonly syncPhase: string;
  readonly syncError: string | null;
  readonly conflicts: number;
  /** Milliseconds since the last successful sync, not the wall-clock time it happened at. */
  readonly sinceLastSyncMs: number | null;
  readonly syncUsedBytes: number;
  readonly syncQuotaBytes: number;

  /* --- permissions and settings ------------------------------------------ */
  /** Which *optional* permissions are granted. The required set is in the manifest and is public. */
  readonly optionalPermissions: readonly string[];
  readonly incognitoAllowed: boolean;
  readonly theme: string;
  readonly idleTimeoutMinutes: number;
  readonly lockOnBrowserBlur: boolean;
  readonly stripTrackingParams: boolean;
  readonly reuseIncognitoWindow: boolean;
  readonly clearHistoryOnLock: boolean;
  readonly quickClose: boolean;
  readonly localThumbnails: boolean;
  readonly sortBy: string;
}

/** `null` renders as this rather than as nothing, so a missing line is never mistaken for a zero. */
const UNKNOWN = 'n/a';

function show(value: string | number | boolean | null): string {
  if (value === null) return UNKNOWN;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/**
 * The report, as text.
 *
 * Plain `key: value` lines under headings rather than JSON, because the audience is a person
 * skimming an issue — and because a reader who *can* skim it is the last line of defence behind
 * the closed field list above. A wall of minified JSON is one nobody checks before pasting.
 *
 * The labels are English and are not translated. This is the one piece of user-visible text in the
 * extension that is deliberately outside `_locales` (INV-10 sees no `msg()` here and so never asks
 * about it): its reader is whoever triages the issue, not whoever pressed the button, and a report
 * arriving in a language the maintainer cannot read is a report that cannot be acted on.
 */
export function formatDiagnostics(diagnostics: Diagnostics): string {
  const lines: string[] = [
    'VaultaMark diagnostics',
    '',
    'This report contains no URLs, titles, folder or tag names, notes, item ids,',
    'account addresses or tokens — counts and settings only. It is safe to paste',
    'into a public issue.',
    '',
    '[build]',
    `version: ${diagnostics.version}`,
    `chrome: ${show(diagnostics.chromeMajor)}`,
    `platform: ${diagnostics.platform}`,
    `oauth client configured: ${show(diagnostics.oauthConfigured)}`,
    `development build: ${show(diagnostics.developmentBuild)}`,
    '',
    '[vault]',
    `exists: ${show(diagnostics.vaultExists)}`,
    `locked: ${show(diagnostics.locked)}`,
    `schema version: ${show(diagnostics.schemaVersion)}`,
    `bookmarks: ${show(diagnostics.bookmarks)}`,
    `folders: ${show(diagnostics.folders)}`,
    `tags: ${show(diagnostics.tags)}`,
    `tombstones: ${show(diagnostics.tombstones)}`,
    `with notes: ${show(diagnostics.withNotes)}`,
    `with thumbnails: ${show(diagnostics.withThumbnails)}`,
    '',
    '[storage]',
    `local bytes: ${show(diagnostics.localBytes)}`,
    `buckets: ${show(diagnostics.buckets)}`,
    `thumbnail cache bytes: ${show(diagnostics.thumbnailCacheBytes)}`,
    `stored icons: ${show(diagnostics.storedIcons)}`,
    '',
    '[sync]',
    `provider: ${diagnostics.providerId}`,
    `phase: ${diagnostics.syncPhase}`,
    `last error: ${diagnostics.syncError ?? 'none'}`,
    `conflicts: ${show(diagnostics.conflicts)}`,
    `ms since last sync: ${show(diagnostics.sinceLastSyncMs)}`,
    `used bytes: ${show(diagnostics.syncUsedBytes)}`,
    `quota bytes: ${show(diagnostics.syncQuotaBytes)}`,
    '',
    '[permissions]',
    `optional granted: ${diagnostics.optionalPermissions.length === 0 ? 'none' : [...diagnostics.optionalPermissions].sort().join(', ')}`,
    `allowed in incognito: ${show(diagnostics.incognitoAllowed)}`,
    '',
    '[settings]',
    `theme: ${diagnostics.theme}`,
    `idle timeout minutes: ${show(diagnostics.idleTimeoutMinutes)}`,
    `lock on browser blur: ${show(diagnostics.lockOnBrowserBlur)}`,
    `strip tracking params: ${show(diagnostics.stripTrackingParams)}`,
    `reuse incognito window: ${show(diagnostics.reuseIncognitoWindow)}`,
    `clear history on lock: ${show(diagnostics.clearHistoryOnLock)}`,
    `quick close: ${show(diagnostics.quickClose)}`,
    `local thumbnails: ${show(diagnostics.localThumbnails)}`,
    `sort by: ${diagnostics.sortBy}`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Chrome's major version, from a user-agent string.
 *
 * The major alone, and never the whole string: a full UA carries the exact build, the OS build and
 * the CPU architecture, which together identify a machine far more sharply than anything else this
 * report contains. The major is what a bug report actually needs.
 */
export function chromeMajorFrom(userAgent: string): number | null {
  const match = /Chrome\/(\d+)\./u.exec(userAgent);
  if (match?.[1] === undefined) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}
