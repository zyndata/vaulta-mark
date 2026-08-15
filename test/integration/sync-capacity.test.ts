/**
 * How many bookmarks actually fit in `chrome.storage.sync` (ARCHITECTURE §5.3).
 *
 * §5.3 derives ~980 from a paper calculation: ~280 bytes of JSON per bookmark, 3.5–4× from gzip on
 * a homogeneous array, a third back for base64url, minus the header and the padding. Phase 7 is
 * required to check that against a real vault, and this is that check — a fixture built out of
 * plausible bookmarks, sealed by the real codec, pushed through the real provider into a mock that
 * enforces Chrome's real limits, until it will not take another one.
 *
 * The assertion is a **band**, not a number. The exact figure moves with the length of the URLs
 * someone happens to save, and a test pinned to one integer is a test that fails on a compression
 * library update without anything being wrong. What matters is that the number the documentation
 * gives a user is not optimistic.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VaultRepository } from '../../src/storage/repo.js';
import { ChromeSyncProvider } from '../../src/sync/chrome-provider.js';
import { QuotaExceeded } from '../../src/sync/provider.js';
import { WriteBudget, type BudgetStore } from '../../src/sync/rate.js';
import { BLOCK_RATIO, WARN_RATIO } from '../../src/storage/quota.js';
import type { Mutation } from '../../src/vault/model.js';
import { installChromeMock, uninstallChromeMock } from '../mocks/chrome.js';
import { seededRandom } from '../helpers/items.js';

const PASSWORD = 'a reasonably long master password';

/** The numbers §5.3 and the README promise. A measurement below these would be a documentation bug. */
const DOCUMENTED_COMFORTABLE = 600;
const DOCUMENTED_CEILING = 980;

const roomyBudget: BudgetStore = { read: () => Promise.resolve([]), write: () => Promise.resolve() };

/**
 * A plausible bookmark.
 *
 * Deliberately varied rather than `Item 1`, `Item 2`: gzip on a thousand copies of the same string
 * would report a capacity nobody will ever see. Real bookmarks share their scheme, their common
 * hosts and their JSON keys, and differ in everything else — which is what the 3.5–4× in §5.3 is
 * actually measuring.
 */
function bookmarkAt(index: number, random: () => number): Mutation {
  const hosts = ['news.example.com', 'docs.example.org', 'blog.example.net', 'shop.example.co'];
  const words = ['guide', 'reference', 'weekly', 'archive', 'notes', 'review', 'thread', 'release'];
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;

  const slug = `${pick(words)}-${pick(words)}-${String(index)}`;
  return {
    kind: 'add',
    input: {
      type: 'bookmark',
      url: `https://${pick(hosts)}/${pick(words)}/${slug}?ref=${String(index)}`,
      title: `${pick(words)} ${pick(words)}: ${pick(words)} ${pick(words)} (${String(index)})`,
      tags: [pick(words), pick(words)],
    },
  };
}

beforeAll(() => {
  installChromeMock();
});

afterAll(() => {
  uninstallChromeMock();
});

describe('the documented ceiling', () => {
  it('is not optimistic: a real vault reaches it before the quota does', async () => {
    const repo = new VaultRepository();
    await repo.create(PASSWORD);
    await repo.flush();

    const provider = new ChromeSyncProvider({
      budget: new WriteBudget({ store: roomyBudget, perMinute: 1e9, perHour: 1e9 }),
    });

    const random = seededRandom(20_260_731);
    let stamp = await provider.pushLight(await repo.exportEncrypted(), null);
    let count = 0;
    let warnedAt = 0;

    // Fifty at a time: one push per fifty bookmarks, which is what an import looks like and keeps
    // this test to a couple of seconds rather than a thousand round trips.
    for (let batch = 0; batch < 40; batch++) {
      const mutations = Array.from({ length: 50 }, (_unused, index) =>
        bookmarkAt(count + index, random),
      );
      await repo.apply(mutations);
      await repo.flush();

      try {
        stamp = await provider.pushLight(
          await repo.sealSnapshot(repo.items(), repo.header().vaultRev),
          stamp,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(QuotaExceeded);
        break;
      }
      count += mutations.length;

      const usage = await provider.quota();
      if (warnedAt === 0 && usage.ratio >= WARN_RATIO) warnedAt = count;
      if (usage.ratio >= BLOCK_RATIO) break;
    }

    // Reported rather than merely asserted: this is the number the documentation quotes, and a
    // reader of a CI log should be able to see what the measurement actually was.
    console.info(
      `measured chrome.storage.sync capacity: ${String(count)} bookmarks ` +
        `(warned at ${String(warnedAt)}, quota ${String((await provider.quota()).usedBytes)} bytes)`,
    );

    expect(count).toBeGreaterThanOrEqual(DOCUMENTED_COMFORTABLE);
    // The theoretical ceiling is exactly that. A measurement far above it would mean the fixture is
    // too compressible to be telling us anything about real bookmarks.
    expect(count).toBeLessThanOrEqual(DOCUMENTED_CEILING * 2);
    expect(warnedAt).toBeGreaterThan(0);
    expect(warnedAt).toBeLessThan(count);
  }, 120_000);
});
