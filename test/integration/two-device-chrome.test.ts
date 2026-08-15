/**
 * Two devices over `chrome.storage.sync` — the zero-configuration tier.
 *
 * The suite is in `test/helpers/two-device.ts` and is run twice, once per provider. This file is
 * the half that knows about `storage.sync`: one area shared between the two profiles, which is the
 * whole of Chrome's built-in replication and the reason this provider needs no configuration at all.
 */

import { ChromeSyncProvider } from '../../src/sync/chrome-provider.js';
import { WriteBudget, type BudgetStore } from '../../src/sync/rate.js';
import { createChromeMock, type ChromeMock } from '../mocks/chrome.js';
import { describeTwoDeviceSync } from '../helpers/two-device.js';

/**
 * A budget with room for a simulation.
 *
 * The governor itself is proven against Chrome's real ceilings in `test/unit/sync/rate.test.ts`;
 * here it would only mean a test that fails because it ran too many scenarios too fast.
 */
const roomyBudget: BudgetStore = { read: () => Promise.resolve([]), write: () => Promise.resolve() };

let cloud: ChromeMock;
let now: () => number = () => Date.now();

describeTwoDeviceSync({
  name: 'chrome.storage.sync',

  reset(clock) {
    now = () => clock.now();
    // The *shared* clock: the sync area simulates Chrome's write-rate ceilings against it, and a
    // second clock would have it charging the fuzz's whole run to one minute.
    cloud = createChromeMock({ clock });
  },

  attach(mock) {
    (mock.chrome.storage as { sync: unknown }).sync = cloud.chrome.storage.sync;
  },

  provider() {
    return new ChromeSyncProvider({
      budget: new WriteBudget({ store: roomyBudget, perMinute: 1e9, perHour: 1e9 }),
      now,
    });
  },

  remoteFingerprint() {
    return JSON.stringify(cloud.storage.sync.snapshot());
  },

  /**
   * Kill the push between the bucket parts and the header.
   *
   * This is the torn state §5.4.1 orders the writes to survive: the remote is left holding new
   * bucket bytes under a header that still points at the previous revision.
   */
  async tear(push) {
    const area = cloud.chrome.storage.sync as unknown as {
      set: (items: Record<string, unknown>) => Promise<void>;
    };
    const original = area.set;
    area.set = async (items) => {
      if ('vm.s.meta' in items) throw new Error('the browser went away');
      await original(items);
    };
    try {
      await push();
    } finally {
      area.set = original;
    }
  },
});
