/**
 * Every box a person types into shows its whole focus ring.
 *
 * This needs a real browser and could not be checked anywhere else. The property is geometric:
 * `overflow` on either axis makes an element clip on **both** — the two axes cannot disagree — and
 * it clips at the *padding* edge, while an outline is drawn *outside* the border box. So a
 * `width: 100%` field flush against a scroll container silently loses its ring. jsdom has no layout
 * and cannot see it; the rule that fixes it belongs to a stylesheet rather than to any module, so
 * there is nothing a unit test could hold.
 *
 * It has been reported twice. The first fix gave the scroll boxes 4 px of inline padding, which was
 * wrong in two ways this file now pins: the ring needs exactly 4 px (`--vm-focus`'s 2 px plus 2 px
 * of `outline-offset`) and so had *no* slack, on a popup 26.4 rem wide — 422.4 px — where every box
 * inside lands on a fractional boundary; and inline padding says nothing about the **top**, which is
 * where the vault filter sits, being the first thing inside the box that scrolls.
 *
 * `--vm-ring-room` is 6 px on all four sides. The 2 px of slack are the point.
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

import { extensionArgs } from './harness.js';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

const PASSWORD = 'correct horse battery staple';
const CONFIRM_PHRASE = 'I understand';

/** What the ring occupies outside the border box: `--vm-focus`'s width plus its offset. */
const RING = 4;

let context: BrowserContext;
let userDataDir: string;
let extensionId: string;

async function openPage(path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  return page;
}

/**
 * Focus what `selector` names, and answer how much room its ring has on each side.
 *
 * The room is the gap to the nearest clipping ancestor's padding edge — the smallest one, over every
 * ancestor that clips, because it only takes one to cut the ring.
 */
async function ringRoom(
  page: Page,
  selector: string,
): Promise<Record<'left' | 'right' | 'top' | 'bottom', number>> {
  return await page.evaluate((query) => {
    const element = document.querySelector<HTMLElement>(query);
    if (element === null) throw new Error(`no element matches ${query}`);
    element.focus();

    const box = element.getBoundingClientRect();
    const room = { left: Infinity, right: Infinity, top: Infinity, bottom: Infinity };

    for (let at = element.parentElement; at !== null; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const outer = at.getBoundingClientRect();
      // `getBoundingClientRect` is the border box; clipping happens at the padding edge, so the
      // border's own width is not room the ring may use.
      const border = (side: string): number => Number.parseFloat(style.getPropertyValue(side)) || 0;
      room.left = Math.min(room.left, box.left - (outer.left + border('border-left-width')));
      room.right = Math.min(room.right, outer.right - border('border-right-width') - box.right);
      room.top = Math.min(room.top, box.top - (outer.top + border('border-top-width')));
      room.bottom = Math.min(room.bottom, outer.bottom - border('border-bottom-width') - box.bottom);
    }
    return room;
  }, selector);
}

async function expectWholeRing(page: Page, selector: string, what: string): Promise<void> {
  const room = await ringRoom(page, selector);
  for (const [side, gap] of Object.entries(room)) {
    expect(gap, `${what} — ${side} edge`).toBeGreaterThanOrEqual(RING);
  }
}

/**
 * The inline edges of a box, and of the scrollbar it paints inside them.
 *
 * A scrollbar is drawn at the inline end of its own border box, which is why widening a box to make
 * room for its contents' focus rings is not free: the scrollbar moves out with the box. If it moves
 * out past the things stacked above and below it, it lands in the column their rings are drawn in.
 */
async function inlineEdges(
  page: Page,
  selector: string,
): Promise<{ left: number; right: number; scrollbar: number }> {
  return await page.evaluate((query) => {
    const node = document.querySelector<HTMLElement>(query);
    if (node === null) throw new Error(`no element matches ${query}`);
    const box = node.getBoundingClientRect();
    return { left: box.left, right: box.right, scrollbar: node.offsetWidth - node.clientWidth };
  }, selector);
}

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-e2e-ring-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    // The default headless build does not run extensions at all — see lock.spec.ts.
    channel: 'chromium',
    headless: true,
    args: extensionArgs(DIST),
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
});

test('the popup draws every field’s ring in full, on the create screen and the vault screen', async () => {
  const popup = await openPage('popup.html');
  // The screen is built after the worker answers, so there is nothing to measure until it has.
  await expect(popup.getByLabel('Master password')).toBeVisible();

  // The create screen: three fields, and the tallest screen in the popup — which is why `#vm-root`
  // scrolls at all, and therefore why it clips.
  await expectWholeRing(popup, 'input[autocomplete="new-password"]', 'master password');
  await expectWholeRing(popup, 'input[type="text"]', 'the typed confirmation');

  await popup.getByLabel('Master password').fill(PASSWORD);
  await popup.getByLabel('Repeat the password').fill(PASSWORD);
  await popup.getByLabel('Type the phrase to confirm').fill(CONFIRM_PHRASE);
  await popup.getByRole('button', { name: 'Create vault' }).click();
  await expect(popup.getByRole('button', { name: 'Add this page' })).toBeVisible();

  // The one that was reported: first thing in the scrolling box, top edge on the clip boundary.
  await expectWholeRing(popup, '.vm-field--filter input', 'the vault filter');
  await popup.close();
});

test('a dialog draws its field’s ring in full, inside a body that scrolls', async () => {
  // Runs after the test above, which is what left a vault here to open the manager on.
  const manager = await openPage('manager.html');
  await expect(manager.getByRole('button', { name: 'New folder' })).toBeVisible();
  await manager.getByRole('button', { name: 'New folder' }).click();
  await expect(manager.getByRole('dialog')).toBeVisible();

  // `.vm-dialog-body` is the other box in this project that scrolls around things people type into.
  await expectWholeRing(manager, '.vm-dialog-body input[type="text"]', 'the folder name');
  await manager.close();
});

/**
 * The scrolling list keeps its scrollbar inside the column everything else on the screen occupies.
 *
 * The other half of the same lesson, and a regression in its own right. `.vm-list` was given its
 * ring room the way `#vm-root` gets it — negative margin, positive padding, layout-neutral for its
 * own contents — which widened it by 12 px. That moved its scrollbar 6 px *out*, past the right edge
 * of the filter above it and into the column the filter's focus ring is drawn in, an arrow-button's
 * height below the ring's corner. Nothing was clipped and no two rectangles actually intersected,
 * so neither check above could see it; it simply looked like the scrollbar was eating the outline.
 *
 * So the property worth pinning is the one that differs: the list takes its room **inward**, and its
 * edges stay level with the filter's. Then the scrollbar cannot be anywhere a neighbour's ring is.
 */
test('the scrolling list keeps its scrollbar inside the filter’s column', async () => {
  const popup = await openPage('popup.html');
  await expect(popup.getByLabel('Filter your vault')).toBeVisible();

  // Enough rows that the list really scrolls — an empty list paints no scrollbar to misplace.
  for (let index = 0; index < 30; index++) {
    await popup.evaluate(
      (n) =>
        chrome.runtime.sendMessage({
          type: 'ADD_URL',
          url: `https://ring-e2e.invalid/p${String(n)}`,
          title: `Bookmark number ${String(n)}`,
        }),
      index,
    );
  }
  await popup.reload();
  await expect(popup.getByRole('button', { name: 'Add this page' })).toBeVisible();
  await expect(popup.locator('.vm-row').first()).toBeVisible();

  const filter = await inlineEdges(popup, '.vm-field--filter');
  const list = await inlineEdges(popup, '.vm-list');
  expect(list.right, 'the list reaches further right than the filter above it').toBeLessThanOrEqual(
    filter.right,
  );
  expect(list.left, 'the list reaches further left than the filter above it').toBeGreaterThanOrEqual(
    filter.left,
  );

  // And the filter's ring is still whole, which is what the widening was for in the first place.
  await expectWholeRing(popup, '.vm-field--filter input', 'the vault filter');
  await popup.close();
});
