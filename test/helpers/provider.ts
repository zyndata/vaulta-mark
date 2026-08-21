/**
 * A `SyncProvider` that keeps the heavy tier in two maps.
 *
 * Shared rather than re-declared per suite because the interface now carries two families of blob —
 * thumbnails keyed by item id, favicons keyed by an HMAC of a host (ARCHITECTURE §10.1) — and a
 * per-file fake is a per-file chance for one of them to be quietly forgotten.
 */

import type { SyncProvider } from '../../src/sync/provider.js';

export interface FakeProvider extends SyncProvider {
  readonly thumbs: Map<string, Uint8Array>;
  readonly icons: Map<string, Uint8Array>;
  readonly deletedThumbs: string[];
  readonly deletedIcons: string[];
  /** Every heavy-tier read, in order. Lets a test say "and it asked the backend once". */
  readonly reads: string[];
}

/** The Drive tier: a heavy tier that works. */
export function fakeDrive(): FakeProvider {
  const thumbs = new Map<string, Uint8Array>();
  const icons = new Map<string, Uint8Array>();
  const deletedThumbs: string[] = [];
  const deletedIcons: string[] = [];
  const reads: string[] = [];
  return {
    thumbs,
    icons,
    deletedThumbs,
    deletedIcons,
    reads,
    id: 'drive',
    capabilities: { heavyTier: true, maxLightBytes: 10_000_000 },
    init: () => Promise.resolve(),
    peek: () => Promise.resolve(null),
    pullLight: () => Promise.resolve(null),
    pushLight: () => Promise.reject(new Error('not used here')),
    getThumb: (id) => {
      reads.push(`thumb:${id}`);
      return Promise.resolve(thumbs.get(id) ?? null);
    },
    putThumb: (id, blob) => {
      thumbs.set(id, blob);
      return Promise.resolve();
    },
    deleteThumb: (id) => {
      deletedThumbs.push(id);
      thumbs.delete(id);
      return Promise.resolve();
    },
    getIcon: (name) => {
      reads.push(`icon:${name}`);
      return Promise.resolve(icons.get(name) ?? null);
    },
    putIcon: (name, blob) => {
      icons.set(name, blob);
      return Promise.resolve();
    },
    deleteIcon: (name) => {
      deletedIcons.push(name);
      icons.delete(name);
      return Promise.resolve();
    },
    usage: () => Promise.resolve({ usedBytes: 0, quotaBytes: 0 }),
    disconnect: () => Promise.resolve(),
  };
}

/** The Chrome tier: no heavy tier, and every heavy-tier write refuses. */
export function chromeTier(): FakeProvider {
  const base = fakeDrive();
  const refuse = (): Promise<never> => Promise.reject(new Error('no heavy tier'));
  return {
    ...base,
    id: 'chrome',
    capabilities: { heavyTier: false, maxLightBytes: 102_400 },
    getThumb: refuse,
    putThumb: refuse,
    deleteThumb: refuse,
    getIcon: refuse,
    putIcon: refuse,
    deleteIcon: refuse,
  };
}
