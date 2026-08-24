/**
 * The sync orchestrator's own behaviour: single-flight, debounce, and what it does with a failure.
 *
 * The *outcomes* of syncing — what gets merged, what gets pushed, what converges — are covered by
 * `test/integration/two-device-{chrome,drive}.test.ts` against real providers and a real second
 * device.
 * What is left here is the scheduling and the error surface, which are exactly the parts a
 * two-device simulation cannot provoke on purpose.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeSettings } from '../../../src/storage/local.js';
import { VaultRepository } from '../../../src/storage/repo.js';
import { DEFAULT_SETTINGS } from '../../../src/vault/types.js';
import {
  LOCAL_CHANGE_DEBOUNCE_MS,
  PROBE_INTERVAL_MS,
  configureSync,
  probe,
  resetSync,
  scheduleSync,
  status,
  syncNow,
  toSyncErrorCode,
} from '../../../src/sync/engine.js';
import {
  AuthRequired,
  CorruptRemote,
  Offline,
  PreconditionFailed,
  QuotaExceeded,
  RateLimited,
  type RemoteStamp,
  type SyncProvider,
} from '../../../src/sync/provider.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

const PASSWORD = 'a reasonably long master password';

let mock: ChromeMock;
let repo: VaultRepository;

/** A provider that does nothing, plus counters and a way to make any call fail. */
function stubProvider(over: Partial<SyncProvider> = {}): SyncProvider & { peeks: number; pushes: number } {
  const provider = {
    id: 'chrome' as const,
    capabilities: { heavyTier: false, maxLightBytes: 102_400 },
    peeks: 0,
    pushes: 0,
    init: () => Promise.resolve(),
    peek(): Promise<RemoteStamp | null> {
      provider.peeks += 1;
      return Promise.resolve(null);
    },
    pullLight: () => Promise.resolve(null),
    pushLight(): Promise<RemoteStamp> {
      provider.pushes += 1;
      return Promise.resolve({ vaultRev: 1, contentHash: 'hash', modifiedAt: 0 });
    },
    getThumb: () => Promise.resolve(null),
    putThumb: () => Promise.resolve(),
    deleteThumb: () => Promise.resolve(),
    getIcon: () => Promise.resolve(null),
    putIcon: () => Promise.resolve(),
    deleteIcon: () => Promise.resolve(),
    usage: () => Promise.resolve({ usedBytes: 10, quotaBytes: 102_400 }),
    disconnect: () => Promise.resolve(),
    ...over,
  };
  return provider;
}

function useProvider(provider: SyncProvider, unlocked = true): void {
  configureSync({
    repository: () => Promise.resolve(unlocked ? repo : null),
    provider: () => provider,
  });
}

beforeAll(async () => {
  mock = installChromeMock();
  repo = new VaultRepository();
  await repo.create(PASSWORD);
  await repo.flush();
}, 30_000);

afterAll(() => {
  resetSync();
  uninstallChromeMock();
});

beforeEach(() => {
  resetSync();
});

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ status */

describe('status', () => {
  it('says "locked" and asks the provider for nothing when there is no key', async () => {
    const provider = stubProvider();
    useProvider(provider, false);

    const result = await syncNow();
    expect(result.phase).toBe('locked');
    expect(provider.peeks).toBe(0);
  });

  it('reports the provider, its quota, and no error on a clean run', async () => {
    useProvider(stubProvider());
    const result = await syncNow();
    expect(result.phase).toBe('idle');
    expect(result.providerId).toBe('chrome');
    expect(result.quotaBytes).toBe(102_400);
    expect(result.error).toBeNull();
  });
});

/* ------------------------------------------------------------------ single flight */

describe('single-flight', () => {
  it('coalesces concurrent triggers into one run', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let peeks = 0;
    useProvider(
      stubProvider({
        peek: async () => {
          peeks += 1;
          await gate;
          return null;
        },
      }),
    );

    const first = syncNow();
    const second = syncNow();
    const third = syncNow();
    release?.();
    await Promise.all([first, second, third]);

    // One peek for the run in flight, plus one for the re-run the later triggers earned: they
    // arrived after the peek that would have had to see them, so their changes cannot be assumed
    // to have gone out with it. Three triggers, two runs — never three.
    expect(peeks).toBe(2);
  });

  it('runs once more for a trigger that arrived mid-run, and then stops', async () => {
    const provider = stubProvider();
    useProvider(provider);
    await syncNow();
    expect(provider.peeks).toBe(1);
    await syncNow();
    expect(provider.peeks).toBe(2);
  });
});

/* ------------------------------------------------------------------ the debounce */

describe('scheduleSync', () => {
  it('waits for the burst to settle, and fires once for all of it', async () => {
    vi.useFakeTimers();
    const provider = stubProvider();
    useProvider(provider);

    for (let change = 0; change < 20; change++) scheduleSync();
    expect(provider.peeks).toBe(0);

    await vi.advanceTimersByTimeAsync(LOCAL_CHANGE_DEBOUNCE_MS + 1);
    expect(provider.peeks).toBe(1);
  });

  it('is cancelled by resetSync, so a torn-down worker leaves no timer behind', async () => {
    vi.useFakeTimers();
    const provider = stubProvider();
    useProvider(provider);

    scheduleSync();
    resetSync();
    await vi.advanceTimersByTimeAsync(LOCAL_CHANGE_DEBOUNCE_MS + 1);
    expect(provider.peeks).toBe(0);
  });
});

/* ------------------------------------------------------------------ the wake probe */

describe('probe', () => {
  beforeEach(async () => {
    await chrome.storage.session.clear();
  });

  it('checks the remote on the first wake', async () => {
    const provider = stubProvider();
    useProvider(provider);
    await probe();
    expect(provider.peeks).toBe(1);
  });

  it('coalesces the wakes that follow into nothing, for a minute', async () => {
    const provider = stubProvider();
    useProvider(provider);
    let at = 1_800_000_000_000;
    configureSync({
      repository: () => Promise.resolve(repo),
      provider: () => provider,
      now: () => at,
    });

    await probe();
    at += PROBE_INTERVAL_MS - 1;
    await probe();
    await probe();
    expect(provider.peeks).toBe(1);

    at += 2;
    await probe();
    expect(provider.peeks).toBe(2);
  });

  it('remembers when it last probed in storage.session, not in a variable', async () => {
    // The variable is the thing being defended against: MV3 tears the worker down every ~30 s, so a
    // module-scope timestamp would reset as often as the events being coalesced arrive.
    useProvider(stubProvider());
    await probe();
    expect(mock.storage.session.snapshot()['vm.probedAt']).toBeTypeOf('number');
  });

  it('goes anyway when the caller says the wake was a browser start', async () => {
    const provider = stubProvider();
    useProvider(provider);
    await probe();
    await probe(true);
    expect(provider.peeks).toBe(2);
  });

  it('says nothing when it fires into a world that is no longer there', async () => {
    const saved = globalThis.chrome;
    delete (globalThis as { chrome?: typeof chrome }).chrome;
    await expect(probe()).resolves.toBeUndefined();
    (globalThis as { chrome?: typeof chrome }).chrome = saved;
  });
});

/* ------------------------------------------------------------------ failure */

describe('failure', () => {
  it('maps every provider error onto its wire code', () => {
    expect(toSyncErrorCode(new QuotaExceeded(1, 2))).toBe('QUOTA_EXCEEDED');
    expect(toSyncErrorCode(new RateLimited(500))).toBe('RATE_LIMITED');
    expect(toSyncErrorCode(new Offline('no network'))).toBe('OFFLINE');
    expect(toSyncErrorCode(new AuthRequired('sign in'))).toBe('AUTH_REQUIRED');
    expect(toSyncErrorCode(new CorruptRemote('torn'))).toBe('CORRUPT_REMOTE');
    expect(toSyncErrorCode(new PreconditionFailed(null))).toBe('PRECONDITION_FAILED');
    expect(toSyncErrorCode(new Error('something else'))).toBe('UNKNOWN');
  });

  it('surfaces a full quota without throwing at the caller', async () => {
    useProvider(
      stubProvider({
        pushLight: () => Promise.reject(new QuotaExceeded(120_000, 102_400)),
      }),
    );
    const result = await syncNow();
    expect(result.phase).toBe('error');
    expect(result.error).toBe('QUOTA_EXCEEDED');
  });

  it('passes on how long to wait when the write budget is spent', async () => {
    useProvider(stubProvider({ pushLight: () => Promise.reject(new RateLimited(42_000)) }));
    const result = await syncNow();
    expect(result.error).toBe('RATE_LIMITED');
    expect(result.retryAfterMs).toBe(42_000);
  });

  it('never rejects, even when the world it was scheduled in has gone', async () => {
    // A timer firing into a torn-down MV3 worker: there is no `chrome`, no session, and nobody to
    // tell. An unhandled rejection from a background task is noise in a console that is supposed to
    // stay empty, so the run reports and returns instead.
    configureSync({
      repository: () => Promise.reject(new ReferenceError('chrome is not defined')),
    });
    const result = await syncNow();
    expect(result.phase).toBe('error');
    expect(result.error).toBe('UNKNOWN');
    expect(result.quotaBytes).toBe(0);
  });

  it('clears the previous error once a run succeeds', async () => {
    useProvider(stubProvider({ peek: () => Promise.reject(new Offline('no network')) }));
    expect((await syncNow()).error).toBe('OFFLINE');

    useProvider(stubProvider());
    expect((await syncNow()).error).toBeNull();
    expect((await status()).error).toBeNull();
  });
});

/* ------------------------------------------------------------------ the default provider */

describe('without an injected provider', () => {
  it('uses the Chrome sync area, which is what "zero configuration" means', async () => {
    configureSync({ repository: () => Promise.resolve(repo) });
    await syncNow();
    expect(Object.keys(mock.storage.sync.snapshot())).toContain('vm.s.meta');
  });

  it('answers a "drive" setting with Drive rather than quietly syncing somewhere else', async () => {
    await writeSettings({ ...DEFAULT_SETTINGS, providerId: 'drive' });
    configureSync({ repository: () => Promise.resolve(repo) });
    // No OAuth client and no `identity` grant in this mock, so the run fails at authorization —
    // which is the point: it reached Drive. Before Phase 10 this silently used Chrome sync.
    expect((await syncNow()).error).toBe('AUTH_REQUIRED');
    expect((await syncNow()).providerId).toBe('drive');
    await writeSettings(DEFAULT_SETTINGS);
  });
});
