#!/usr/bin/env node
/**
 * Renders the extension icons and the Store promo tile from the vector definitions below
 * (PLAN §9 Phase 13, STORE_LISTING §1).
 *
 * The PNGs are committed — this script is how they were made, not a build step. It runs on demand,
 * needs Playwright's Chromium, and is deliberately not wired into `npm run build`: an icon that
 * changes because someone's font stack changed is not a change anyone asked for.
 *
 * **Chromium is the renderer because it is the one that matters.** The alternative is a Node image
 * library, which would be a dependency and would rasterise the same SVG slightly differently from
 * the browser the icons are displayed in. Screenshotting an element sized in exact CSS pixels at
 * `deviceScaleFactor: 1` gives the browser's own rasterisation at the size it will be shown.
 *
 * **Two drawings, not one scaled drawing.** The keyhole's slot is 6 units wide out of 128; at 16px
 * that is three quarters of a pixel and resolves as grey mud that reads as a smudge on the
 * bookmark rather than as a hole. So 16 and 32 get the round part of the keyhole only, and the
 * slot appears at 48 and above. The silhouette is identical at every size, which is the part a
 * person recognises in a toolbar.
 *
 * Usage: node scripts/gen-brand-assets.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * `--vm-accent` (#2f4bc4) is the interface's blue; the badge runs a shade either side of it so the
 * icon has depth at 128px without becoming a different colour at 16px, where the gradient
 * collapses to about one flat tone.
 */
const BLUE_LIGHT = '#4a63d8';
const BLUE_DARK = '#22318f';

/**
 * The mark, on a 128-unit square. A bookmark ribbon with a keyhole cut through it: the two things
 * the extension is, in the order someone reads them — it is a bookmark, and it is locked.
 *
 * The keyhole is a mask rather than a shape painted in the background colour, so it is a real hole
 * with the gradient showing through. Painting it would go visibly wrong the moment the badge is
 * anything but flat.
 *
 * @param {{ slot: boolean }} options
 * @returns {string}
 */
function mark({ slot }) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="badge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BLUE_LIGHT}"/>
      <stop offset="1" stop-color="${BLUE_DARK}"/>
    </linearGradient>
    <mask id="keyhole">
      <rect width="128" height="128" fill="#fff"/>
      <circle cx="64" cy="53" r="13" fill="#000"/>
      ${slot ? '<path d="M60.5 62 h7 l2.5 20 h-12 Z" fill="#000"/>' : ''}
    </mask>
  </defs>
  <rect width="128" height="128" rx="27" fill="url(#badge)"/>
  <path d="M38 24 h52 a4 4 0 0 1 4 4 v78 l-30 -25 l-30 25 v-78 a4 4 0 0 1 4 -4 Z"
        fill="#ffffff" mask="url(#keyhole)"/>
</svg>`.trim();
}

/** The Store's own icon spec: a 128 canvas with the artwork at 96, transparently padded. */
function storeIcon() {
  return `<div style="width:128px;height:128px;display:grid;place-items:center">
    <div style="width:96px;height:96px">${mark({ slot: true })}</div>
  </div>`;
}

/**
 * 440 × 280 small promo tile. Text is set in whatever sans-serif the rendering machine has, which
 * is why the PNG is committed rather than regenerated: this is a drawing, and it is finished.
 */
function promoTile() {
  return `<div style="
      width:440px;height:280px;box-sizing:border-box;
      background:linear-gradient(135deg,#1a2668 0%,#0e1436 100%);
      display:flex;flex-direction:column;justify-content:center;gap:18px;padding:0 34px;
      font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#fff">
    <div style="display:flex;align-items:center;gap:16px">
      <div style="width:64px;height:64px;flex:none">${mark({ slot: true })}</div>
      <div style="font-size:38px;font-weight:700;letter-spacing:-0.5px">VaultaMark</div>
    </div>
    <div style="font-size:18px;line-height:1.4;color:#c3ccf5;text-wrap:balance">
      Encrypted bookmarks Chrome doesn't know about.
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:5px 16px;font-size:13px;color:#8a97d4">
      <span>Never in the omnibox</span>
      <span>Opens in incognito</span>
      <span>Synced through your own Drive</span>
    </div>
  </div>`;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} html
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Buffer>}
 */
async function shoot(page, html, width, height) {
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}
     svg{display:block;width:100%;height:100%}</style>
     <div id="target" style="width:${width}px;height:${height}px">${html}</div>`,
  );
  const target = page.locator('#target');
  return target.screenshot({ omitBackground: true });
}

/**
 * @param {string} path
 * @param {Buffer} png
 */
async function emit(path, png) {
  const target = resolve(repoRoot, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, png);
  console.log(`  ${relative(repoRoot, target).split('\\').join('/')}  ${png.length} bytes`);
}

async function main() {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  console.log('extension icons (public/icons/)');
  for (const size of [16, 32, 48, 128]) {
    const svg = mark({ slot: size >= 48 });
    await emit(`public/icons/icon${size}.png`, await shoot(page, svg, size, size));
  }

  console.log('store assets (docs/store/)');
  await emit('docs/store/icon-128.png', await shoot(page, storeIcon(), 128, 128));
  await emit('docs/store/promo-440x280.png', await shoot(page, promoTile(), 440, 280));

  await browser.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
