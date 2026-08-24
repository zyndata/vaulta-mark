/**
 * The favicon store (PLAN §9 Phase 17, ARCHITECTURE §10.1).
 *
 * Two claims carry the feature, and both are asserted here against the **real** cipher from a real
 * `VaultRepository` — a stubbed one would prove nothing about either.
 *
 * - **The stored name is keyed.** The set of domains is enumerable, so a name anyone could compute
 *   from a host would turn "how many domains are in this vault" into "which ones". The test does
 *   not check that we called an HMAC; it checks that the obvious unkeyed guesses — the host itself,
 *   its SHA-256, its base64 — are not the name on disk.
 * - **One host costs one file**, however many bookmarks point at it. That is the whole reason icons
 *   are affordable where thumbnails are per item.
 *
 * The `_favicon/` half — when a capture is allowed to happen at all — is in
 * `test/unit/background/favicons.test.ts`, because it is about `chrome` rather than about storage.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';
import { fakeDrive, chromeTier } from '../../helpers/provider.js';
import { VaultRepository } from '../../../src/storage/repo.js';
import { toBase64Url, utf8, type Bytes } from '../../../src/crypto/codec.js';
import { sha256 } from '../../../src/crypto/hash.js';
import {
  LOCAL_KEYS,
  deleteIcons,
  iconBytesInUse,
  listIconNames,
  readIcon,
} from '../../../src/storage/local.js';
import {
  ICON_CACHE_BYTES,
  MAX_ICON_BYTES,
  classifyIcon,
  dropIcons,
  evictIcons,
  hasIcon,
  iconHost,
  loadIcon,
  saveIcon,
  sweepIcons,
  type IconStoreDeps,
  frameIcon,
  unframeIcon,
} from '../../../src/thumbs/favicons.js';
import type { SyncProvider } from '../../../src/sync/provider.js';

const PASSWORD = 'a reasonably long master password';

let repo: VaultRepository;

function deps(provider: SyncProvider | null): IconStoreDeps {
  return { cipher: repo.iconCipher(), provider };
}

/** A plausible favicon: the PNG magic a sniffer looks for, then filler. */
function png(bytes = 646, seed = 7): Bytes {
  const out = new Uint8Array(bytes);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < bytes; i++) out[i] = (i * seed) % 251;
  return out;
}

beforeAll(async () => {
  installChromeMock();
  repo = new VaultRepository({ coalesceMs: 0 });
  await repo.create(PASSWORD);
});

beforeEach(async () => {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((key) =>
    key.startsWith(LOCAL_KEYS.iconPrefix),
  );
  if (keys.length > 0) await chrome.storage.local.remove(keys);
  await chrome.storage.local.remove(LOCAL_KEYS.iconsLru);
  await chrome.storage.sync.clear();
});

afterAll(() => {
  uninstallChromeMock();
});

describe('the name a host is filed under', () => {
  it('is not derivable from the host by any unkeyed means', async () => {
    const host = 'github.com';
    const { name } = await saveIcon(deps(fakeDrive()), host, png());

    const guesses = [
      host,
      toBase64Url(utf8(host)),
      toBase64Url(await sha256(utf8(host))),
      // The truncations an implementation that "hashed the host" would plausibly have produced.
      toBase64Url((await sha256(utf8(host))).subarray(0, 16)),
      toBase64Url((await sha256(utf8(host))).subarray(0, 8)),
      [...(await sha256(utf8(host)))].map((b) => b.toString(16).padStart(2, '0')).join(''),
    ];
    for (const guess of guesses) {
      expect(name, `an unkeyed guess found the stored name: ${guess}`).not.toBe(guess);
    }
    expect(await listIconNames()).toEqual([name]);
  });

  it('says nothing about the host it names', async () => {
    const { name } = await saveIcon(deps(fakeDrive()), 'github.com', png());
    expect(name.toLowerCase()).not.toContain('github');
    // 128 bits of HMAC, base64url: 22 characters and no padding.
    expect(name).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  });

  it('is stable for one vault and different in another', async () => {
    const first = await repo.iconCipher().name('github.com');
    expect(await repo.iconCipher().name('github.com')).toBe(first);

    const other = new VaultRepository({ coalesceMs: 0 });
    await chrome.storage.local.clear();
    await other.create(PASSWORD);
    const elsewhere = await other.iconCipher().name('github.com');
    await chrome.storage.local.clear();
    // Same password, same host, different vault: a different random DEK is what makes the names
    // useless to anyone comparing two people's Drive folders.
    expect(elsewhere).not.toBe(first);
  });
});

describe('what a host is', () => {
  it.each([
    ['https://github.com/zyndata/vaulta-mark', 'github.com'],
    ['https://www.github.com/', 'github.com'],
    ['https://WWW.GitHub.com/x', 'github.com'],
    ['http://localhost:3000/page', 'localhost:3000'],
    ['https://sub.example.co.uk/a', 'sub.example.co.uk'],
    ['not a url at all', null],
    ['', null],
  ])('%s → %s', (url, expected) => {
    expect(iconHost(url)).toBe(expected);
  });
});

describe('one host, one file', () => {
  it('costs one stored icon however many bookmarks point at it', async () => {
    const drive = fakeDrive();
    // Fifty bookmarks on one host is the case the whole design is for.
    for (let i = 0; i < 50; i++) {
      const host = iconHost(`https://github.com/repo/${i}`);
      expect(host).toBe('github.com');
      if (!(await hasIcon(deps(drive), host!))) await saveIcon(deps(drive), host!, png());
    }
    expect(await listIconNames()).toHaveLength(1);
    expect(drive.icons.size).toBe(1);
  });

  it('files two different hosts separately', async () => {
    const drive = fakeDrive();
    await saveIcon(deps(drive), 'github.com', png(646, 3));
    await saveIcon(deps(drive), 'gitlab.com', png(646, 11));
    expect(await listIconNames()).toHaveLength(2);
    expect(drive.icons.size).toBe(2);
  });
});

describe('what reaches storage (INV-6)', () => {
  it('seals the bytes and the name: no host and no PNG magic in any stored value', async () => {
    const drive = fakeDrive();
    await saveIcon(deps(drive), 'github.com', png());

    const stored = await chrome.storage.local.get(null);
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(LOCAL_KEYS.iconPrefix) && key !== LOCAL_KEYS.iconsLru) continue;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      expect(`${key}${text}`).not.toContain('github');
      if (typeof value !== 'string') continue;
      const decoded = atob(value.replace(/-/gu, '+').replace(/_/gu, '/'));
      expect(decoded.includes('\x89PNG')).toBe(false);
    }
  });

  it('hands the provider the same ciphertext, never the icon', async () => {
    const drive = fakeDrive();
    const { name } = await saveIcon(deps(drive), 'github.com', png());
    const pushed = drive.icons.get(name);
    expect(pushed).toBeDefined();
    expect(await readIcon(name)).toEqual(pushed);
    // The envelope's version byte, not PNG's.
    expect(pushed?.[0]).toBe(0x02);
  });

  it('writes nothing to chrome.storage.sync', async () => {
    const drive = fakeDrive();
    await saveIcon(deps(drive), 'github.com', png());
    await loadIcon(deps(drive), 'github.com');
    await dropIcons(deps(drive), ['github.com']);
    // The heavy tier never touches the 100 KB area, which is an invariant rather than a preference.
    expect(await chrome.storage.sync.get(null)).toEqual({});
  });

  it('round-trips through the real cipher', async () => {
    const drive = fakeDrive();
    const bytes = png(1_100, 13);
    await saveIcon(deps(drive), 'github.com', bytes);
    expect(await loadIcon(deps(drive), 'github.com')).toEqual({ source: 'chrome', bytes });
  });
});

describe('judging a _favicon/ response', () => {
  const placeholder = png(646, 2);

  it.each([
    ['the placeholder itself', placeholder, 'placeholder'],
    ['a real icon', png(646, 9), 'store'],
    ['nothing at all', new Uint8Array(0), 'empty'],
    ['something absurd', png(MAX_ICON_BYTES + 1), 'too-large'],
  ])('%s → %s', (_label, bytes, verdict) => {
    expect(classifyIcon(bytes, placeholder)).toBe(verdict);
  });

  it('stores nothing when the placeholder could not be measured', () => {
    // An unknown globe is a globe we would otherwise store once per domain in the vault.
    expect(classifyIcon(png(), null)).toBe('placeholder');
  });
});

describe('reading one back', () => {
  it('answers from the local cache without asking the backend', async () => {
    const drive = fakeDrive();
    await saveIcon(deps(drive), 'github.com', png());
    drive.reads.length = 0;
    expect(await loadIcon(deps(drive), 'github.com')).not.toBeNull();
    expect(drive.reads).toEqual([]);
  });

  it('fetches from the backend on a cache miss, then caches it', async () => {
    const drive = fakeDrive();
    const { name } = await saveIcon(deps(drive), 'github.com', png());
    await chrome.storage.local.remove(`${LOCAL_KEYS.iconPrefix}${name}`);

    expect(await loadIcon(deps(drive), 'github.com')).not.toBeNull();
    expect(drive.reads).toEqual([`icon:${name}`]);
    drive.reads.length = 0;
    expect(await loadIcon(deps(drive), 'github.com')).not.toBeNull();
    expect(drive.reads).toEqual([]);
  });

  it('drops a local value that will not open, and replaces it from the backend', async () => {
    const drive = fakeDrive();
    const { name } = await saveIcon(deps(drive), 'github.com', png());
    // Bytes from another vault, or from a schema this build no longer opens (§10.1).
    await chrome.storage.local.set({ [`${LOCAL_KEYS.iconPrefix}${name}`]: toBase64Url(png(80)) });

    expect(await loadIcon(deps(drive), 'github.com')).not.toBeNull();
    expect(drive.reads).toEqual([`icon:${name}`]);
  });

  it('never asks a backend with no heavy tier', async () => {
    const chrome_ = chromeTier();
    // `getIcon` on the Chrome tier rejects in this fake, so reaching it would fail the test rather
    // than pass it quietly.
    expect(await loadIcon(deps(chrome_), 'github.com')).toBeNull();
  });

  it('answers null rather than throwing when the backend is unreachable', async () => {
    const drive = fakeDrive();
    const offline: SyncProvider = { ...drive, getIcon: () => Promise.reject(new Error('offline')) };
    expect(await loadIcon(deps(offline), 'github.com')).toBeNull();
  });
});

describe('letting go', () => {
  it('drops both copies for a host', async () => {
    const drive = fakeDrive();
    const { name } = await saveIcon(deps(drive), 'github.com', png());
    await dropIcons(deps(drive), ['github.com']);

    expect(await readIcon(name)).toBeNull();
    expect(drive.deletedIcons).toEqual([name]);
  });

  it('still drops the local copy when the backend refuses', async () => {
    const drive = fakeDrive();
    const { name } = await saveIcon(deps(drive), 'github.com', png());
    const stubborn: SyncProvider = {
      ...drive,
      deleteIcon: () => Promise.reject(new Error('offline')),
    };
    await dropIcons(deps(stubborn), ['github.com']);
    expect(await readIcon(name)).toBeNull();
  });

  it('sweeps the hosts that are no longer in the vault, and keeps the ones that are', async () => {
    const drive = fakeDrive();
    const kept = await saveIcon(deps(drive), 'github.com', png(646, 3));
    const gone = await saveIcon(deps(drive), 'example.com', png(646, 5));

    const swept = await sweepIcons(deps(drive), ['github.com']);

    expect(swept).toEqual([gone.name]);
    expect(await readIcon(gone.name)).toBeNull();
    expect(await readIcon(kept.name)).not.toBeNull();
    expect(drive.deletedIcons).toEqual([gone.name]);
  });

  it('sweeps nothing when every stored host is still there', async () => {
    const drive = fakeDrive();
    await saveIcon(deps(drive), 'github.com', png());
    expect(await sweepIcons(deps(drive), ['github.com', 'unrelated.example'])).toEqual([]);
    expect(drive.deletedIcons).toEqual([]);
  });

  it('evicts least-recently-shown first, and only locally', async () => {
    const drive = fakeDrive();
    const now = { at: 1_000 };
    const withClock: IconStoreDeps = { cipher: repo.iconCipher(), provider: drive, now: () => now.at };

    const oldest = await saveIcon(withClock, 'a.example', png(3_000));
    now.at = 2_000;
    const newest = await saveIcon(withClock, 'b.example', png(3_000));

    // The cap is exactly what one of them costs, so evicting the older one is enough and the
    // arithmetic does not depend on how base64url and the mock's key accounting round.
    const evicted = await evictIcons(await iconBytesInUse([newest.name]));

    expect(evicted).toEqual([oldest.name]);
    expect(await readIcon(oldest.name)).toBeNull();
    expect(await readIcon(newest.name)).not.toBeNull();
    // Drive is the system of record: eviction is what makes the cap safe, so it must not delete.
    expect(drive.deletedIcons).toEqual([]);
    expect(drive.icons.size).toBe(2);
  });

  it('leaves a cache that is under the cap alone', async () => {
    await saveIcon(deps(fakeDrive()), 'a.example', png());
    expect(await evictIcons(ICON_CACHE_BYTES)).toEqual([]);
  });
});

/* ------------------------------------------------ where an icon came from (§10.1, D37) */

describe('the provenance frame', () => {
  const BYTES = png(300, 5);

  it.each(['chrome', 'page'] as const)('round-trips a %s icon', (source) => {
    expect(unframeIcon(frameIcon(source, BYTES))).toEqual({ source, bytes: BYTES });
  });

  it('reads an unframed blob as chrome, which is what every pre-Phase-19 icon is', () => {
    // The whole reason this was free to introduce: nothing already in a vault is invalidated and
    // nothing is re-uploaded on upgrade. The alternative — treating an unframed blob as a miss —
    // would have re-captured and re-pushed every icon in every vault.
    expect(unframeIcon(BYTES)).toEqual({ source: 'chrome', bytes: BYTES });
  });

  it.each([
    ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['JPEG', [0xff, 0xd8, 0xff, 0xe0]],
    ['GIF', [0x47, 0x49, 0x46, 0x38]],
    ['BMP', [0x42, 0x4d, 0x00, 0x00]],
    ['WebP', [0x52, 0x49, 0x46, 0x46]],
    ['ICO', [0x00, 0x00, 0x01, 0x00]],
    ['AVIF', [0x00, 0x00, 0x00, 0x20]],
  ])('cannot be confused with a real %s header', (_label, magic) => {
    // 0xF0 is the whole trick: no image format this store can hold begins with it, so an unframed
    // blob is never ambiguous.
    const bytes = new Uint8Array([...magic, 1, 2, 3, 4]);
    expect(unframeIcon(bytes)).toEqual({ source: 'chrome', bytes });
  });

  it('reads a frame carrying an unknown source as chrome', () => {
    // A stranger writer, or a build from the future. `chrome` is the reading that cannot lose
    // anything a refresh would then delete.
    const bytes = new Uint8Array([0xf0, 0x56, 0x4d, 0x5a, 9, 9, 9]);
    expect(unframeIcon(bytes)).toEqual({ source: 'chrome', bytes });
  });

  it('costs four bytes', () => {
    expect(frameIcon('page', BYTES)).toHaveLength(BYTES.length + 4);
  });

  it('survives the real cipher and comes back as a page icon', async () => {
    const drive = fakeDrive();
    await saveIcon(deps(drive), 'vault-only.example', BYTES, 'page');
    expect(await loadIcon(deps(drive), 'vault-only.example')).toEqual({
      source: 'page',
      bytes: BYTES,
    });
  });

  it('travels to the provider and back, not only through the local cache', async () => {
    const drive = fakeDrive();
    await saveIcon(deps(drive), 'vault-only.example', BYTES, 'page');
    // Empty the local half, so the answer can only have come from the backend.
    await deleteIcons(await listIconNames());
    expect(await loadIcon(deps(drive), 'vault-only.example')).toEqual({
      source: 'page',
      bytes: BYTES,
    });
  });

  it('defaults to chrome when a caller does not say', async () => {
    const drive = fakeDrive();
    await saveIcon(deps(drive), 'github.com', BYTES);
    expect((await loadIcon(deps(drive), 'github.com'))?.source).toBe('chrome');
  });
});
