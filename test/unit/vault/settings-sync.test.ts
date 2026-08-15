/**
 * The synced half of the settings: what travels, how two records fold together, and what a
 * malformed one does.
 *
 * The property that matters most here is **symmetry**. The sync engine merges on whichever device
 * notices the divergence first, so a fold that depended on which side was called `mine` would leave
 * two devices trading revisions over a theme forever — which is exactly the trap §6.4 documents for
 * `item.rev`.
 */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_SYNCED_SETTINGS,
  SYNCED_SETTING_KEYS,
  applySyncedSettings,
  mergeSyncedSettings,
  parseSyncedSettings,
  sameSyncedSettings,
  stampSettings,
  type SyncedSettings,
} from '../../../src/vault/settings-sync.js';
import { DEFAULT_SETTINGS, type VaultSettings } from '../../../src/vault/types.js';

const NOW = 1_800_000_000_000;

function settings(patch: Partial<VaultSettings> = {}): VaultSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe('what travels', () => {
  it('carries preferences and nothing that describes a screen or a connection', () => {
    const keys = [...SYNCED_SETTING_KEYS] as string[];
    // A laptop must not inherit a desktop's column widths, and a profile with no Drive token must
    // not be told to use Drive. Both stay in the per-device half of `vm.settings`.
    expect(keys).not.toContain('sidebarWidth');
    expect(keys).not.toContain('detailWidth');
    expect(keys).not.toContain('providerId');
    expect(keys).toContain('theme');
    expect(keys).toContain('idleTimeoutMinutes');
  });

  it('records only the field the edit actually moved', () => {
    const record = stampSettings(EMPTY_SYNCED_SETTINGS, settings(), settings({ theme: 'dark' }), NOW);
    expect(record).toEqual({ theme: { v: 'dark', at: NOW } });
  });

  it('leaves a field nobody has ever changed absent, so it defers rather than competing', () => {
    // The trap this avoids: stamping all eight fields on the first edit makes a device claim seven
    // defaults nobody chose, at a timestamp that then beats another device's real change.
    const record = stampSettings(EMPTY_SYNCED_SETTINGS, settings(), settings({ theme: 'dark' }), NOW);
    expect(record).not.toHaveProperty('idleTimeoutMinutes');
    expect(mergeSyncedSettings(record, { idleTimeoutMinutes: { v: 30, at: NOW - 60_000 } })).toEqual({
      theme: { v: 'dark', at: NOW },
      idleTimeoutMinutes: { v: 30, at: NOW - 60_000 },
    });
  });

  it('keeps the old timestamp for a field the edit left alone', () => {
    const first = stampSettings(EMPTY_SYNCED_SETTINGS, settings(), settings({ theme: 'dark' }), NOW);
    const again = stampSettings(first, settings({ theme: 'dark' }), settings({ theme: 'dark', quickClose: true }), NOW + 5_000);

    expect(again.theme).toEqual({ v: 'dark', at: NOW });
    expect(again.quickClose).toEqual({ v: true, at: NOW + 5_000 });
  });

  it('ignores the fields that do not travel', () => {
    const record = stampSettings(
      EMPTY_SYNCED_SETTINGS,
      settings(),
      settings({ sidebarWidth: 400 }),
      NOW,
    );
    expect(record).toEqual({});
  });
});

describe('merging', () => {
  const mine: SyncedSettings = { theme: { v: 'dark', at: 200 }, quickClose: { v: true, at: 100 } };
  const theirs: SyncedSettings = {
    theme: { v: 'light', at: 100 },
    idleTimeoutMinutes: { v: 30, at: 300 },
  };

  it('takes the newer value per field, not the newer record', () => {
    const merged = mergeSyncedSettings(mine, theirs);
    expect(merged.theme).toEqual({ v: 'dark', at: 200 });
    expect(merged.idleTimeoutMinutes).toEqual({ v: 30, at: 300 });
    expect(merged.quickClose).toEqual({ v: true, at: 100 });
  });

  it('is symmetric, which is what stops two devices arguing forever', () => {
    expect(mergeSyncedSettings(mine, theirs)).toEqual(mergeSyncedSettings(theirs, mine));
  });

  it('breaks a tie by value, so both sides break it the same way', () => {
    const a: SyncedSettings = { theme: { v: 'dark', at: 500 } };
    const b: SyncedSettings = { theme: { v: 'light', at: 500 } };
    expect(mergeSyncedSettings(a, b)).toEqual(mergeSyncedSettings(b, a));
    expect(mergeSyncedSettings(a, b).theme?.v).toBe('dark');
  });

  it('takes a field only one side has ever had', () => {
    expect(mergeSyncedSettings({}, theirs)).toEqual(theirs);
    expect(mergeSyncedSettings(mine, {})).toEqual(mine);
  });

  it('is idempotent', () => {
    const merged = mergeSyncedSettings(mine, theirs);
    expect(mergeSyncedSettings(merged, merged)).toEqual(merged);
  });

  it('compares two records the way the engine asks "is there anything to push?"', () => {
    expect(sameSyncedSettings(mine, { ...mine })).toBe(true);
    expect(sameSyncedSettings(mine, theirs)).toBe(false);
    expect(sameSyncedSettings(mine, { theme: { v: 'dark', at: 999 }, quickClose: { v: true, at: 100 } })).toBe(false);
    expect(sameSyncedSettings({}, {})).toBe(true);
  });
});

describe('applying', () => {
  it('overwrites what travelled and leaves the rest alone', () => {
    const local = settings({ sidebarWidth: 400, detailWidth: 500, providerId: 'drive' });
    const applied = applySyncedSettings(local, {
      theme: { v: 'dark', at: 1 },
      idleTimeoutMinutes: { v: 30, at: 1 },
      sortBy: { v: 'title', at: 1 },
    });

    expect(applied.theme).toBe('dark');
    expect(applied.idleTimeoutMinutes).toBe(30);
    expect(applied.sortBy).toBe('title');
    // The DoD item: a second profile keeps its own columns and its own backend.
    expect(applied.sidebarWidth).toBe(400);
    expect(applied.detailWidth).toBe(500);
    expect(applied.providerId).toBe('drive');
  });

  it('keeps "never auto-lock", which is a legal zero', () => {
    expect(applySyncedSettings(settings(), { idleTimeoutMinutes: { v: 0, at: 1 } }).idleTimeoutMinutes).toBe(0);
  });

  it('ignores a value it does not recognise rather than rendering a page with no theme', () => {
    const applied = applySyncedSettings(settings({ theme: 'light' }), {
      theme: { v: 'purple', at: 1 },
      sortBy: { v: 'whenever', at: 1 },
      idleTimeoutMinutes: { v: -5, at: 1 },
      quickClose: { v: 'yes', at: 1 },
    });
    expect(applied.theme).toBe('light');
    expect(applied.sortBy).toBe(DEFAULT_SETTINGS.sortBy);
    expect(applied.idleTimeoutMinutes).toBe(DEFAULT_SETTINGS.idleTimeoutMinutes);
    expect(applied.quickClose).toBe(false);
  });
});

describe('parsing what came out of a vault', () => {
  it('round-trips a real record', () => {
    const record = stampSettings(EMPTY_SYNCED_SETTINGS, settings(), settings({ theme: 'dark' }), NOW);
    expect(parseSyncedSettings(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('drops fields a newer build invented, and anything malformed', () => {
    expect(
      parseSyncedSettings({
        theme: { v: 'dark', at: 5 },
        somethingNew: { v: 'x', at: 5 },
        quickClose: { v: true },
        sortBy: { v: {}, at: 5 },
        clearHistoryOnLock: 'not an object',
      }),
    ).toEqual({ theme: { v: 'dark', at: 5 } });
  });

  it('treats anything that is not a record as no record at all', () => {
    expect(parseSyncedSettings(null)).toEqual({});
    expect(parseSyncedSettings('nope')).toEqual({});
    expect(parseSyncedSettings(undefined)).toEqual({});
  });
});
