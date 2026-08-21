/**
 * The diagnostics report's redaction guarantee.
 *
 * The report's whole value is the promise on the button: safe to paste into a public issue without
 * reading it first. That promise is kept by the record being a closed list of counts, booleans and
 * enums — so the tests that matter here are the ones that would fail if somebody widened it. The
 * formatting tests exist mostly to pin `n/a`, which carries real evidence in a bug report.
 */

import {
  chromeMajorFrom,
  formatDiagnostics,
  type Diagnostics,
} from '../../../src/shared/diagnostics.js';

const FULL: Diagnostics = {
  version: '1.4.2',
  chromeMajor: 128,
  platform: 'windows',
  oauthConfigured: true,
  developmentBuild: false,

  vaultExists: true,
  locked: false,
  schemaVersion: 2,
  bookmarks: 412,
  folders: 17,
  tags: 9,
  tombstones: 33,
  withNotes: 4,
  withThumbnails: 120,

  localBytes: 2_400_000,
  buckets: 16,
  thumbnailCacheBytes: 5_120_000,
  storedIcons: 37,

  providerId: 'drive',
  syncPhase: 'idle',
  syncError: null,
  conflicts: 0,
  sinceLastSyncMs: 61_000,
  syncUsedBytes: 98_000,
  syncQuotaBytes: 15_728_640,

  optionalPermissions: ['identity', 'history'],
  incognitoAllowed: true,
  theme: 'dark',
  idleTimeoutMinutes: 10,
  lockOnBrowserBlur: false,
  stripTrackingParams: true,
  reuseIncognitoWindow: true,
  clearHistoryOnLock: false,
  quickClose: false,
  localThumbnails: false,
  sortBy: 'title',
};

const LOCKED: Diagnostics = {
  ...FULL,
  locked: true,
  bookmarks: null,
  folders: null,
  tags: null,
  tombstones: null,
  withNotes: null,
  withThumbnails: null,
  schemaVersion: 2,
};

describe('the report', () => {
  it('renders exactly one labelled line per field of the record', () => {
    /*
     * Counted rather than spot-checked, and in both directions. A field added to `Diagnostics` and
     * forgotten in the formatter is a field nobody notices is missing — the report just quietly
     * stops carrying the fact that would have explained the bug. A line in the formatter with no
     * field behind it is the other half: something being reported that no closed list vouches for.
     */
    const labelled = formatDiagnostics(FULL)
      .split('\n')
      .filter((line) => /^[a-z][a-z ]*: /u.test(line));
    expect(labelled).toHaveLength(Object.keys(FULL).length);
  });

  it('says "n/a" rather than 0 for what a locked vault cannot count', () => {
    // "0 bookmarks" and "the vault was locked when this was taken" are very different pieces of
    // evidence in a bug report about missing bookmarks, and the difference must survive the format.
    const text = formatDiagnostics(LOCKED);
    expect(text).toContain('bookmarks: n/a');
    expect(text).toContain('folders: n/a');
    expect(text).toContain('locked: yes');
    expect(text).not.toContain('bookmarks: 0');
  });

  it('renders booleans as words, because "false" beside a count reads as a value', () => {
    expect(formatDiagnostics(FULL)).toContain('lock on browser blur: no');
    expect(formatDiagnostics(FULL)).toContain('strip tracking params: yes');
  });

  it('says "none" for an absent error rather than leaving the line empty', () => {
    expect(formatDiagnostics(FULL)).toContain('last error: none');
    expect(formatDiagnostics({ ...FULL, syncError: 'QUOTA_EXCEEDED' })).toContain(
      'last error: QUOTA_EXCEEDED',
    );
  });

  it('says so in the report itself, so a reader knows what they are pasting', () => {
    expect(formatDiagnostics(FULL)).toContain('no URLs, titles, folder or tag names');
  });

  it('carries no colon-separated line whose value came from outside our own source', () => {
    /*
     * The regression test for the failure this design exists to prevent: somebody adds
     * `driveEmail` or `lastQuery` to the record, every other test still passes, and the button goes
     * on promising the report is safe. Every value on a line has to be a number, one of a handful
     * of words, or a comma-separated list of permission names — nothing with an `@`, a `://`, a
     * dot-separated host or a run of arbitrary text in it.
     */
    const safeValue = /^(n\/a|none|yes|no|-?\d+|[a-z][a-z0-9-]*(, [a-z][a-z0-9-]*)*|[A-Z_]+|\d+\.\d+\.\d+)$/u;
    const offenders = formatDiagnostics(FULL)
      .split('\n')
      .filter((line) => /^[a-z].*: /u.test(line))
      .map((line) => line.slice(line.indexOf(': ') + 2))
      .filter((value) => !safeValue.test(value));
    expect(offenders).toEqual([]);
  });
});

describe('chromeMajorFrom', () => {
  it('takes the major and discards the build, which identifies a machine', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.120 Safari/537.36';
    expect(chromeMajorFrom(ua)).toBe(128);
  });

  it('answers null rather than guessing when there is no Chrome in it', () => {
    expect(chromeMajorFrom('Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0')).toBeNull();
    expect(chromeMajorFrom('')).toBeNull();
  });
});
