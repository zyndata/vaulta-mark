/**
 * The heavy tier's two copies (ARCHITECTURE §14.6), and the invariant underneath them.
 *
 * **INV-6 extended.** A thumbnail is vault content: it is a picture of a page the user vaulted, and
 * on a good day it is legible enough to read the headline off. So the assertion here is not "we
 * called seal" — it is that no stored value in `storage.local`, and nothing handed to the provider,
 * contains the magic bytes of any image format. That test fails if somebody ever writes the raw
 * bytes "just for the cache".
 *
 * The cipher is the real one from a real `VaultRepository`, because a stubbed one would prove
 * nothing about the thing being asserted.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';
import { VaultRepository } from '../../../src/storage/repo.js';
import type { Bytes } from '../../../src/crypto/codec.js';
import {
  LOCAL_KEYS,
  listThumbIds,
  readThumb,
  readThumbsLru,
} from '../../../src/storage/local.js';
import {
  THUMB_CACHE_BYTES,
  dropThumbs,
  evictThumbs,
  hasHeavyTier,
  loadThumb,
  saveThumb,
  touchThumb,
  type ThumbStoreDeps,
} from '../../../src/thumbs/store.js';
import type { SyncProvider } from '../../../src/sync/provider.js';

const PASSWORD = 'a reasonably long master password';

let repo: VaultRepository;

/** A provider that keeps thumbnails in a map, and counts what it was asked to do. */
function fakeDrive(): SyncProvider & {
  readonly blobs: Map<string, Uint8Array>;
  readonly deleted: string[];
} {
  const blobs = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  return {
    blobs,
    deleted,
    id: 'drive',
    capabilities: { heavyTier: true, maxLightBytes: 10_000_000 },
    init: () => Promise.resolve(),
    peek: () => Promise.resolve(null),
    pullLight: () => Promise.resolve(null),
    pushLight: () => Promise.reject(new Error('not used here')),
    getThumb: (id) => Promise.resolve(blobs.get(id) ?? null),
    putThumb: (id, blob) => {
      blobs.set(id, blob);
      return Promise.resolve();
    },
    deleteThumb: (id) => {
      deleted.push(id);
      blobs.delete(id);
      return Promise.resolve();
    },
    usage: () => Promise.resolve({ usedBytes: 0, quotaBytes: 0 }),
    disconnect: () => Promise.resolve(),
  };
}

/** The Chrome tier: no heavy tier, and every thumbnail call refuses. */
function chromeTier(): SyncProvider {
  return {
    ...fakeDrive(),
    id: 'chrome',
    capabilities: { heavyTier: false, maxLightBytes: 102_400 },
    getThumb: () => Promise.reject(new Error('no heavy tier')),
    putThumb: () => Promise.reject(new Error('no heavy tier')),
    deleteThumb: () => Promise.reject(new Error('no heavy tier')),
  };
}

function deps(provider: SyncProvider | null, now?: () => number): ThumbStoreDeps {
  return { cipher: repo.thumbCipher(), provider, ...(now === undefined ? {} : { now }) };
}

/** A plausible WebP: the RIFF header a sniffer looks for, then filler. */
function webp(bytes: number): Bytes {
  const out = new Uint8Array(bytes);
  out.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  for (let i = 12; i < bytes; i++) out[i] = i % 251;
  return out;
}

const MAGIC: readonly (readonly [string, readonly number[]])[] = [
  ['WebP (RIFF…WEBP)', [0x52, 0x49, 0x46, 0x46]],
  ['JPEG (FF D8 FF)', [0xff, 0xd8, 0xff]],
  ['PNG (89 50 4E 47)', [0x89, 0x50, 0x4e, 0x47]],
  ['GIF (GIF8)', [0x47, 0x49, 0x46, 0x38]],
];

/** Whether a run of bytes appears anywhere in a stored value's text. */
function containsMagic(text: string, magic: readonly number[]): boolean {
  const needle = String.fromCharCode(...magic);
  // The values are base64url, so a byte run cannot be searched for directly — decode first.
  const decoded = atob(text.replace(/-/gu, '+').replace(/_/gu, '/'));
  return decoded.includes(needle);
}

beforeAll(async () => {
  installChromeMock();
  repo = new VaultRepository({ coalesceMs: 0 });
  await repo.create(PASSWORD);
});

/**
 * Only the thumbnails are cleared between tests.
 *
 * The vault — and therefore the repository holding `k_thumbs` — is created once: 600,000 PBKDF2
 * iterations is half a second, and every test here needs the *real* cipher rather than a stub,
 * because "the bytes are encrypted at rest" is the thing being asserted.
 */
beforeEach(async () => {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((key) =>
    key.startsWith(LOCAL_KEYS.thumbPrefix),
  );
  if (keys.length > 0) await chrome.storage.local.remove(keys);
  await chrome.storage.local.remove(LOCAL_KEYS.thumbsLru);
});

afterAll(() => {
  uninstallChromeMock();
});

describe('what reaches storage', () => {
  it('seals the bytes: no image magic appears in any stored value (INV-6)', async () => {
    const drive = fakeDrive();
    await saveThumb(deps(drive), 'item-a', webp(4_000));

    const stored = await chrome.storage.local.get(null);
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(LOCAL_KEYS.thumbPrefix)) continue;
      expect(typeof value).toBe('string');
      for (const [label, magic] of MAGIC) {
        expect(containsMagic(value as string, magic), `${key} leaked ${label}`).toBe(false);
      }
    }
  });

  it('sends the provider the same ciphertext, never the picture', async () => {
    const drive = fakeDrive();
    await saveThumb(deps(drive), 'item-a', webp(4_000));

    const pushed = drive.blobs.get('item-a');
    expect(pushed).toBeDefined();
    const local = await readThumb('item-a');
    expect(local).toEqual(pushed);
    // The envelope's version byte, not RIFF.
    expect(pushed?.[0]).toBe(0x02);
  });

  it('reports the sealed size, which is what ThumbMeta.bytes is for', async () => {
    const plain = webp(4_000);
    const { sealedBytes } = await saveThumb(deps(fakeDrive()), 'item-a', plain);
    expect(sealedBytes).toBeGreaterThan(plain.length);
    expect(sealedBytes).toBe((await readThumb('item-a'))?.length);
  });

  it('round-trips through the real cipher', async () => {
    const plain = webp(1_234);
    await saveThumb(deps(fakeDrive()), 'item-a', plain);
    const loaded = await loadThumb(deps(fakeDrive()), 'item-a');
    expect(loaded.state).toBe('ready');
    expect(loaded.bytes).toEqual(plain);
  });

  it('will not open one item’s thumbnail as another’s — the AAD binds the id', async () => {
    await saveThumb(deps(fakeDrive()), 'item-a', webp(500));
    const sealed = await readThumb('item-a');
    await chrome.storage.local.set({ [`${LOCAL_KEYS.thumbPrefix}item-b`]: 'x' });
    expect(sealed).not.toBeNull();
    await expect(repo.thumbCipher().open('item-b', sealed!)).rejects.toThrow();
  });
});

describe('the Chrome tier', () => {
  it('never asks the provider for anything', async () => {
    const provider = chromeTier();
    expect(hasHeavyTier(provider)).toBe(false);
    // Every thumbnail method on this provider rejects, so a call would surface as a failed test.
    await saveThumb(deps(provider), 'item-a', webp(800));
    await dropThumbs(deps(provider), ['item-a']);
    expect(await readThumb('item-a')).toBeNull();
  });

  it('reports a missing picture as `remote` rather than pretending it is gone', async () => {
    // Authored on a Drive machine, viewed here: the item has `thumb` metadata, this device has no
    // bytes and no way to get them. The row degrades to favicon and title (§14.5).
    const loaded = await loadThumb(deps(chromeTier()), 'never-cached');
    expect(loaded).toEqual({ state: 'remote', bytes: null });
  });
});

describe('the Drive tier', () => {
  it('fetches on a cache miss and keeps what it fetched', async () => {
    const drive = fakeDrive();
    await saveThumb(deps(drive), 'item-a', webp(900));
    await chrome.storage.local.remove(`${LOCAL_KEYS.thumbPrefix}item-a`);

    const loaded = await loadThumb(deps(drive), 'item-a');
    expect(loaded.state).toBe('ready');
    expect(await readThumb('item-a')).not.toBeNull();
  });

  it('answers `remote` when the backend cannot be reached, without throwing', async () => {
    const drive = fakeDrive();
    await saveThumb(deps(drive), 'item-a', webp(900));
    await chrome.storage.local.remove(`${LOCAL_KEYS.thumbPrefix}item-a`);

    const offline: SyncProvider = {
      ...drive,
      getThumb: () => Promise.reject(new Error('offline')),
    };
    expect(await loadThumb(deps(offline), 'item-a')).toEqual({ state: 'remote', bytes: null });
  });

  it('answers `none` when the backend simply has nothing for that item', async () => {
    expect(await loadThumb(deps(fakeDrive()), 'unknown')).toEqual({ state: 'none', bytes: null });
  });

  it('drops a locally cached value it cannot open, and refills it from the provider', async () => {
    const drive = fakeDrive();
    await saveThumb(deps(drive), 'item-a', webp(900));
    // Somebody else's ciphertext, or a damaged value.
    await chrome.storage.local.set({ [`${LOCAL_KEYS.thumbPrefix}item-a`]: 'AgAAAAAAAAAAAAAAAA' });

    const loaded = await loadThumb(deps(drive), 'item-a');
    expect(loaded.state).toBe('ready');
  });

  it('deletes both copies', async () => {
    const drive = fakeDrive();
    await saveThumb(deps(drive), 'item-a', webp(900));
    await dropThumbs(deps(drive), ['item-a']);

    expect(await readThumb('item-a')).toBeNull();
    expect(drive.deleted).toEqual(['item-a']);
    expect(drive.blobs.has('item-a')).toBe(false);
  });

  it('still deletes locally when the provider refuses', async () => {
    const drive = fakeDrive();
    await saveThumb(deps(drive), 'item-a', webp(900));
    const stubborn: SyncProvider = {
      ...drive,
      deleteThumb: () => Promise.reject(new Error('offline')),
    };
    await dropThumbs(deps(stubborn), ['item-a']);
    expect(await readThumb('item-a')).toBeNull();
  });

  it('keeps the picture when the push fails, rather than throwing the capture away', async () => {
    const drive = fakeDrive();
    const unreachable: SyncProvider = {
      ...drive,
      putThumb: () => Promise.reject(new Error('offline')),
    };
    const result = await saveThumb(deps(unreachable), 'item-a', webp(900));
    expect(result.pushed).toBe(false);
    expect(await readThumb('item-a')).not.toBeNull();
  });
});

describe('the LRU cap', () => {
  it('evicts least-recently-viewed first, and only past the cap', async () => {
    const drive = fakeDrive();
    let clock = 1_000;
    const store = deps(drive, () => clock);

    // Three pictures, viewed in a known order.
    for (const id of ['old', 'middle', 'fresh']) {
      clock += 1_000;
      await saveThumb(store, id, webp(2_000));
    }
    expect((await listThumbIds()).sort()).toEqual(['fresh', 'middle', 'old']);

    // A cap that leaves room for roughly one of them.
    const evicted = await evictThumbs(4_000);
    expect(evicted).toContain('old');
    expect(evicted).not.toContain('fresh');
    expect(await readThumb('fresh')).not.toBeNull();
  });

  it('does nothing while the cache is inside the cap', async () => {
    await saveThumb(deps(fakeDrive()), 'item-a', webp(2_000));
    expect(await evictThumbs(THUMB_CACHE_BYTES)).toEqual([]);
    expect(await readThumb('item-a')).not.toBeNull();
  });

  it('evicts a thumbnail nobody has ever viewed before one that was viewed', async () => {
    const drive = fakeDrive();
    let clock = 5_000;
    await saveThumb(deps(drive, () => clock), 'viewed', webp(2_000));
    clock += 1_000;
    await saveThumb(deps(drive, () => clock), 'orphan', webp(2_000));
    // A write interrupted between the bytes and the LRU entry leaves exactly this shape.
    const lru = await readThumbsLru();
    Reflect.deleteProperty(lru, 'orphan');
    await chrome.storage.local.set({ [LOCAL_KEYS.thumbsLru]: lru });

    expect(await evictThumbs(3_000)).toEqual(['orphan']);
  });

  it('a view moves an item to the back of the queue', async () => {
    const drive = fakeDrive();
    let clock = 10_000;
    const store = deps(drive, () => clock);
    await saveThumb(store, 'a', webp(2_000));
    clock += 1_000;
    await saveThumb(store, 'b', webp(2_000));

    clock += 1_000;
    await touchThumb(store, 'a');

    expect(await evictThumbs(3_000)).toEqual(['b']);
  });

  it('forgets an evicted item’s LRU entry, so the record cannot grow without bound', async () => {
    const drive = fakeDrive();
    let clock = 20_000;
    await saveThumb(deps(drive, () => clock), 'a', webp(2_000));
    clock += 1_000;
    await saveThumb(deps(drive, () => clock), 'b', webp(2_000));

    await evictThumbs(3_000);
    expect(Object.keys(await readThumbsLru())).toEqual(['b']);
  });

  it('leaves the provider’s copy alone — Drive is the system of record', async () => {
    const drive = fakeDrive();
    await saveThumb(deps(drive), 'a', webp(2_000));
    await evictThumbs(100);
    expect(await readThumb('a')).toBeNull();
    expect(drive.blobs.has('a')).toBe(true);
    expect(drive.deleted).toEqual([]);
  });
});
