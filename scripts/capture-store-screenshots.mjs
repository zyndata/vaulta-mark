#!/usr/bin/env node
/**
 * The five Chrome Web Store screenshots, captured from the real extension (PLAN §9 Phase 13,
 * STORE_LISTING §1).
 *
 * Not a test and not part of `npm run verify`: it drives a throwaway Chrome profile, seeds a vault
 * with invented bookmarks, and writes PNGs into `docs/store/`. The PNGs are the deliverable; this
 * is the record of how they were made, so the day one of them has to be retaken it is a command
 * rather than an afternoon.
 *
 * **Everything in the pictures is invented.** Real, well-known destinations — so the favicons and
 * the domains look like a person's vault rather than a lorem-ipsum one — with titles, folders,
 * tags and notes written for this script. No real vault is ever opened, and no URL here belongs to
 * anybody. The one live thing is a warm-up pass that visits those domains so Chrome's *local*
 * favicon cache has something to answer with; it is best-effort and the shots degrade to Chrome's
 * generic globe when there is no network.
 *
 * Previews are seeded the way `test/e2e/thumbs.spec.ts` seeds them: `chrome.tabs.query` and
 * `chrome.scripting.executeScript` are replaced inside the service worker so the worker believes a
 * page is in front of it with an `activeTab` grant, and the injected capture answers with an image
 * built on a canvas. That is the harness standing in for a toolbar click Playwright cannot perform
 * — the encryption, the downscale and the storage are all the product's own.
 *
 * The popup is 422 × 600 and the Store wants 1280 × 800, so its two shots are composed onto a
 * branded backdrop. The manager fills 1280 × 800 on its own and is captured full-bleed.
 *
 * Usage: node scripts/capture-store-screenshots.mjs      (needs a built dist/)
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const DIST = resolve(repoRoot, 'dist');
const OUT = resolve(repoRoot, 'docs/store');

const PASSWORD = 'correct horse battery staple';
const CONFIRM_PHRASE = 'I understand';

/** The listing these pictures belong to. Matches `E2E_LANGUAGE` in test/e2e/harness.ts. */
const LANGUAGE = 'en-US';

const SHOT = { width: 1280, height: 800 };
/** `#vm-root` is 26.4rem × 37.5rem; the extra pixel keeps the fractional width off a scrollbar. */
const POPUP = { width: 423, height: 600 };

/**
 * The vault the screenshots show. Folders are created in order of first appearance; `preview` adds
 * an Open Graph card, which is the slower path, so only a few carry one.
 *
 * @type {readonly {
 *   url: string, title: string, folder?: string, tags?: string[], note?: string,
 *   preview?: { heading: string, summary: string, hue: number },
 * }[]}
 */
const SEED = [
  {
    url: 'https://www.nytimes.com/section/world',
    title: 'The week in review, saved to read later',
    tags: ['longread'],
    preview: {
      heading: 'The week in review',
      summary: 'Everything that happened, arranged so it makes sense on a Sunday morning.',
      hue: 12,
    },
  },
  {
    url: 'https://www.newyorker.com/magazine',
    title: 'On the quiet economics of secondhand bookshops',
    folder: 'Reading',
    tags: ['longread', 'essays'],
    preview: {
      heading: 'The quiet economics of secondhand bookshops',
      summary: 'A trade that survives on patience, mispriced first editions, and rent control.',
      hue: 268,
    },
  },
  {
    url: 'https://longform.org/posts',
    title: 'Longform — the archive worth keeping',
    folder: 'Reading',
    tags: ['essays'],
  },
  {
    url: 'https://en.wikipedia.org/wiki/Diffie%E2%80%93Hellman_key_exchange',
    title: 'Diffie–Hellman key exchange',
    folder: 'Reference',
    tags: ['crypto'],
  },
  {
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto',
    title: 'SubtleCrypto — MDN',
    folder: 'Reference',
    tags: ['crypto', 'webdev'],
    note: 'The AES-GCM section is the one worth rereading before touching envelope.ts.',
  },
  {
    url: 'https://developer.chrome.com/docs/extensions/reference/api/storage',
    title: 'chrome.storage — quotas, and what session actually means',
    folder: 'Reference',
    tags: ['webdev'],
  },
  {
    url: 'https://www.rfc-editor.org/rfc/rfc8018',
    title: 'RFC 8018 — PKCS #5: Password-Based Cryptography',
    folder: 'Reference',
    tags: ['crypto'],
  },
  {
    url: 'https://github.com/features/actions',
    title: 'Reusable workflows, finally explained properly',
    tags: ['webdev'],
    preview: {
      heading: 'Reusable workflows, explained properly',
      summary: 'Inputs, secrets, and the four things that silently do not inherit.',
      hue: 210,
    },
  },
  {
    url: 'https://news.ycombinator.com/item?id=38904055',
    title: 'That thread about SQLite as an application file format',
    folder: 'Work',
    tags: ['reading'],
  },
  {
    url: 'https://www.figma.com/community',
    title: 'Component library to steal spacing decisions from',
    folder: 'Work',
    tags: ['design'],
  },
  {
    url: 'https://www.smashingmagazine.com/articles/',
    title: 'Focus rings that survive a scrolling container',
    folder: 'Work',
    tags: ['design', 'webdev'],
  },
  {
    url: 'https://www.seriouseats.com/recipes',
    title: 'Mushroom risotto, done properly and without stirring for an hour',
    tags: ['dinner'],
    preview: {
      heading: 'Mushroom risotto, properly',
      summary: 'The stirring is optional. The stock being hot is not.',
      hue: 34,
    },
  },
  {
    url: 'https://cooking.nytimes.com/recipes/1018181-overnight-bread',
    title: 'Overnight bread — the one with four ingredients',
    folder: 'Kitchen',
    tags: ['baking'],
  },
  {
    url: 'https://www.kingarthurbaking.com/recipes',
    title: 'Sourdough timings for a cold kitchen',
    folder: 'Kitchen',
    tags: ['baking'],
  },
  {
    url: 'https://www.gov.uk/browse/visas-immigration',
    title: 'Visa checklist — renewal window opens in March',
    folder: 'Admin',
    tags: ['travel'],
    note: 'Passport must have six months left on it. Book the appointment before the fee changes.',
  },
  {
    url: 'https://www.which.co.uk/reviews',
    title: 'Which washing machine, and why it is never the cheap one',
    folder: 'Admin',
  },
  {
    url: 'https://www.seat61.com/',
    title: 'The Man in Seat 61 — trains across Europe without flying',
    tags: ['travel'],
    preview: {
      heading: 'Across Europe without flying',
      summary: 'Every sleeper worth taking, and the booking window that decides the price.',
      hue: 168,
    },
  },
  {
    url: 'https://www.atlasobscura.com/places',
    title: 'Places worth the detour',
    folder: 'Travel',
    tags: ['travel'],
  },
  {
    url: 'https://www.openstreetmap.org/',
    title: 'OpenStreetMap — the offline export for the trip',
    folder: 'Travel',
  },
  { url: 'https://arxiv.org/list/cs.CR/recent', title: 'arXiv cs.CR — this week', tags: ['crypto'] },
  { url: 'https://www.bbc.co.uk/weather', title: 'Weather, for the weekend', tags: ['reading'] },
];

/**
 * Warmed by *page* URL rather than by origin: Chrome files favicons against the page that loaded
 * them, and `_favicon/?pageUrl=` answers with a generic globe for a page it has never seen even
 * when it holds the site's icon. Warming `https://github.com/` and then asking about
 * `https://github.com/features/actions` produced exactly that — half the rows with globes.
 */
const WARM = SEED.map((item) => item.url);

/* ------------------------------------------------------------------ browser plumbing */

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @returns {Promise<import('@playwright/test').Worker>}
 */
async function serviceWorker(context) {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

/**
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} id
 * @param {string} path
 * @param {{ width: number, height: number }} size
 * @param {'light' | 'dark'} scheme
 */
async function openExtensionPage(context, id, path, size, scheme = 'light') {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`chrome-extension://${id}/${path}`);
  return page;
}

/**
 * Replace the two APIs a toolbar click would otherwise be needed for. Exactly the stand-in
 * `test/e2e/thumbs.spec.ts` uses, and for the same reason: Playwright drives pages, not chrome.
 *
 * @param {import('@playwright/test').Worker} worker
 * @param {{ url: string, title: string }} tab
 * @param {unknown} capture
 */
async function grantActiveTab(worker, tab, capture) {
  await worker.evaluate(
    ([page, result]) => {
      const target = /** @type {{ chrome: typeof chrome }} */ (
        /** @type {unknown} */ (globalThis)
      );
      target.chrome.tabs.query = () =>
        Promise.resolve(/** @type {chrome.tabs.Tab[]} */ (/** @type {unknown} */ ([
          { id: 42, url: page.url, title: page.title, active: true },
        ])));
      target.chrome.scripting.executeScript = /** @type {typeof chrome.scripting.executeScript} */ (
        /** @type {unknown} */ ((/** @type {{ func?: unknown }} */ options) =>
          Promise.resolve([{ frameId: 0, result: options.func === undefined ? undefined : result }]))
      );
    },
    /** @type {[unknown, unknown]} */ ([tab, capture]),
  );
}

/**
 * A 1200 × 630 Open Graph card, drawn rather than downloaded. Real dimensions, because
 * `src/thumbs/process.ts` never upscales and a small source would produce a small thumbnail.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ heading: string, summary: string, hue: number }} card
 * @returns {Promise<string>} base64url, which is how the capture result crosses `executeScript`
 */
async function drawCard(page, card) {
  return await page.evaluate(async (spec) => {
    const canvas = new OffscreenCanvas(1200, 630);
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('no 2d context');

    const gradient = ctx.createLinearGradient(0, 0, 1200, 630);
    gradient.addColorStop(0, `hsl(${spec.hue} 62% 42%)`);
    gradient.addColorStop(1, `hsl(${(spec.hue + 40) % 360} 58% 22%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1200, 630);

    // Soft shapes, so the thumbnail reads as a photograph-shaped thing rather than a flat swatch
    // that would compress to nothing and look like a rendering failure at 320px.
    for (let i = 0; i < 7; i += 1) {
      ctx.fillStyle = `hsl(${(spec.hue + i * 24) % 360} 70% ${30 + i * 6}% / 0.35)`;
      ctx.beginPath();
      ctx.ellipse(120 + i * 170, 180 + ((i * 137) % 320), 190, 130, i, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.font = '600 62px system-ui, sans-serif';
    ctx.fillText(spec.heading.slice(0, 34), 72, 330);
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.font = '400 32px system-ui, sans-serif';
    ctx.fillText(spec.summary.slice(0, 58), 72, 392);

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let at = 0; at < bytes.length; at += 0x2000) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 0x2000));
    }
    return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  }, card);
}

/* ------------------------------------------------------------------ composition */

/**
 * Put a captured PNG on a 1280 × 800 backdrop. Used for the popup, which is 422 px wide and would
 * otherwise be a postage stamp in a corner of the Store's frame.
 *
 * @param {import('@playwright/test').Page} canvasPage
 * @param {Buffer} png
 * @param {{ heading: string, body: string }} caption
 * @returns {Promise<Buffer>}
 */
async function compose(canvasPage, png, caption) {
  await canvasPage.setViewportSize(SHOT);
  await canvasPage.setContent(`
    <style>
      html,body{margin:0;height:100%}
      .frame{
        box-sizing:border-box;width:1280px;height:800px;display:flex;align-items:center;
        justify-content:center;gap:80px;padding:0 90px;
        background:linear-gradient(135deg,#1a2668 0%,#0e1436 100%);
        font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#fff}
      .words{max-width:470px}
      h1{font-size:44px;line-height:1.15;margin:0 0 22px;font-weight:700;letter-spacing:-0.5px}
      p{font-size:21px;line-height:1.5;margin:0;color:#c3ccf5}
      img{display:block;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,0.45)}
    </style>
    <div class="frame">
      <div class="words"><h1>${caption.heading}</h1><p>${caption.body}</p></div>
      <img src="data:image/png;base64,${png.toString('base64')}" width="${POPUP.width}" height="${POPUP.height}">
    </div>`);
  return canvasPage.locator('.frame').screenshot();
}

/**
 * @param {string} name
 * @param {Buffer} png
 */
async function emit(name, png) {
  const target = join(OUT, name);
  await writeFile(target, png);
  console.log(`  ${relative(repoRoot, target).split('\\').join('/')}  ${png.length} bytes`);
}

/* ------------------------------------------------------------------ the run */

async function main() {
  const { chromium } = await import('@playwright/test');
  await mkdir(OUT, { recursive: true });
  const userDataDir = await mkdtemp(join(tmpdir(), 'vaultamark-store-'));

  const context = await chromium.launchPersistentContext(userDataDir, {
    // The default headless build does not run extensions at all — see test/e2e/lock.spec.ts.
    channel: 'chromium',
    headless: true,
    viewport: SHOT,
    // Both halves of the language pin, for the reason test/e2e/harness.ts gives at length: `--lang`
    // picks which `_locales/<tag>/messages.json` Chrome renders and comes from the *operating
    // system* when unset, and `locale` is what a page gets back from `chrome.i18n.getUILanguage()`.
    // These are the English listing's pictures, and every selector below names an English word, so
    // on a Polish machine this script fails at the first `Next` — which is how the pin was missed.
    locale: LANGUAGE,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      `--lang=${LANGUAGE}`,
    ],
  });

  try {
    const worker = await serviceWorker(context);
    const extensionId = new URL(worker.url()).host;

    // ---------------------------------------------------------- favicons, best effort
    console.log('warming the local favicon cache');
    const warm = await context.newPage();
    for (const url of WARM) {
      try {
        await warm.goto(url, { waitUntil: 'domcontentloaded', timeout: 12_000 });
        // The icon is requested after the document, so returning at DOMContentLoaded is too early
        // for it to have been filed.
        await warm.waitForTimeout(1500);
      } catch {
        console.log(`  (skipped ${new URL(url).host})`);
      }
    }
    await warm.close();

    /* ------------------------------------------------------- 5. the no-recovery warning */
    // Taken first, because it is the one screen that only exists while there is no vault: step 2
    // of setup, where the warning is a sentence you have to type out. Dark mode, so the strip
    // shows both themes (STORE_LISTING §1).
    console.log('capturing the setup screen, before there is a vault to lose');
    const setup = await openExtensionPage(context, extensionId, 'manager.html?onboarding=1', SHOT, 'dark');
    await setup.getByRole('button', { name: 'Next' }).click();
    await setup.getByLabel('Master password').waitFor();
    await setup.waitForTimeout(400);
    await emit('screenshot-5-no-recovery.png', await setup.screenshot());
    await setup.close();

    // ---------------------------------------------------------- a vault
    console.log('creating the vault');
    const popup = await openExtensionPage(context, extensionId, 'popup.html', POPUP);
    await popup.getByLabel('Master password').fill(PASSWORD);
    await popup.getByLabel('Repeat the password').fill(PASSWORD);
    await popup.getByLabel('Type the phrase to confirm').fill(CONFIRM_PHRASE);
    await popup.getByRole('button', { name: 'Create vault' }).click();
    await popup.getByRole('button', { name: 'Add this page' }).waitFor();

    // Previews are off on the Chrome-sync tier by design (ARCHITECTURE §14.4). The screenshots
    // show what a Drive user sees, so the local-only opt-in is taken here as a user would.
    await popup.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'SET_SETTINGS',
        settings: { localThumbnails: true, thumbnailsOffered: true },
      }),
    );

    // ---------------------------------------------------------- folders and bookmarks
    console.log(`seeding ${SEED.length} bookmarks`);
    /** @type {Record<string, string>} */
    const folders = {};
    for (const name of [...new Set(SEED.map((item) => item.folder).filter(Boolean))]) {
      const created = await popup.evaluate(
        (title) => chrome.runtime.sendMessage({ type: 'CREATE_FOLDER', title }),
        name,
      );
      folders[/** @type {string} */ (name)] = created.id;
    }

    for (const item of SEED) {
      if (item.preview) {
        await grantActiveTab(worker, item, {
          ogTitle: item.preview.heading,
          ogDescription: item.preview.summary,
          imageUrl: `${new URL(item.url).origin}/og.jpg`,
          src: 'og',
          contentType: 'image/jpeg',
          image: await drawCard(popup, item.preview),
        });
        await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'ADD_ACTIVE_TAB' }));
      } else {
        await popup.evaluate(
          ([url, title]) => chrome.runtime.sendMessage({ type: 'ADD_URL', url, title }),
          /** @type {[string, string]} */ ([item.url, item.title]),
        );
      }
    }

    // Titles are unique in SEED, so this maps each back to the id the worker gave it.
    const listed = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'LIST_ITEMS', limit: 500 }),
    );
    /** @type {Map<string, string>} */
    const ids = new Map(listed.items.map((row) => [row.title, row.id]));
    console.log(`  ${ids.size} in the vault, ${Object.keys(folders).length} folders`);

    for (const item of SEED) {
      const id = ids.get(item.title);
      if (id === undefined) continue;
      if (item.folder) {
        await popup.evaluate(
          ([one, parentId]) =>
            chrome.runtime.sendMessage({ type: 'MOVE_ITEMS', ids: [one], parentId }),
          /** @type {[string, string]} */ ([id, folders[item.folder]]),
        );
      }
      if (item.tags?.length) {
        await popup.evaluate(
          ([one, add]) => chrome.runtime.sendMessage({ type: 'TAG_ITEMS', ids: [one], add }),
          /** @type {[string, string[]]} */ ([id, item.tags]),
        );
      }
      if (item.note) {
        await popup.evaluate(
          ([one, note]) =>
            chrome.runtime.sendMessage({ type: 'UPDATE_ITEM', id: one, patch: { note } }),
          /** @type {[string, string]} */ ([id, item.note]),
        );
      }
    }

    /* ------------------------------------------------------- 1. the vault list */
    console.log('capturing');
    const manager = await openExtensionPage(context, extensionId, 'manager.html', SHOT);
    await manager.locator('.vm-row').first().waitFor();
    // Everything is filed, so the root listing is mostly folders. "All bookmarks" is the flat view
    // — which is what the first shot is meant to show.
    await manager.getByRole('button', { name: 'All bookmarks' }).click();
    await manager.locator('.vm-row').filter({ hasText: 'Mushroom risotto' }).click();
    // The detail pane draws its preview inline, which is the whole point of the first shot. A
    // missing one is not worth failing the run over — the shot is still a vault list.
    await manager
      .locator('.vm-detail img')
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => console.log('  (no inline preview rendered)'));
    // Off the list, or the row under the cursor opens its floating preview card over the shot.
    await manager.mouse.move(1100, 120);
    await manager.waitForTimeout(600);
    await emit('screenshot-1-vault.png', await manager.screenshot());

    /* ------------------------------------------------------- 3. search, tags, folders */
    await manager.getByLabel('Search your vault').fill('tag:crypto');
    await manager.waitForTimeout(400);
    await emit('screenshot-3-search.png', await manager.screenshot());
    await manager.getByLabel('Search your vault').fill('');

    /* ------------------------------------------------------- 4. sync settings */
    await manager.getByRole('button', { name: 'Settings' }).click();
    await manager.getByRole('button', { name: 'Back to bookmarks' }).waitFor();
    await manager
      .locator('.vm-settings-section')
      .filter({ has: manager.getByRole('heading', { name: 'Sync', exact: true }) })
      .scrollIntoViewIfNeeded();
    await manager.waitForTimeout(400);
    await emit('screenshot-4-sync.png', await manager.screenshot());
    await manager.close();

    /* ------------------------------------------------------- 2. the add flow */
    // A vault with something in it, and the toolbar popup over it. The popup cannot read a tab
    // here (no toolbar click, so no activeTab), which is why the shot is of the list it shows.
    const shot2 = await openExtensionPage(context, extensionId, 'popup.html', POPUP);
    await shot2.locator('.vm-row').first().waitFor();
    await shot2.waitForTimeout(400);
    const popupPng = await shot2.screenshot();
    await shot2.close();

    const canvasPage = await context.newPage();
    await emit(
      'screenshot-2-add.png',
      await compose(canvasPage, popupPng, {
        heading: 'Save the page you are on, in one click',
        body: 'The toolbar button, the right-click menu, or a keyboard shortcut. '
          + 'Nothing is written to Chrome’s bookmarks, so nothing appears in the address bar.',
      }),
    );
    await canvasPage.close();
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
