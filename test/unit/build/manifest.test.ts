import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildManifest,
  EXTENSION_PAGES_CSP,
  MINIMUM_CHROME_VERSION,
} from '../../../build/manifest';

const lock = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../build/permissions.lock.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, string[]>;

const manifest = buildManifest('1.2.3');

describe('generated manifest', () => {
  it('is Manifest V3 with a module service worker', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
  });

  it('pins the CSP to the exact expected string (INV-2)', () => {
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self'; object-src 'self'; frame-ancestors 'none'",
    });
    expect(EXTENSION_PAGES_CSP).not.toMatch(/unsafe-eval|unsafe-inline|wasm-unsafe-eval|https?:/);
  });

  it('matches build/permissions.lock.json exactly (INV-9)', () => {
    expect(manifest.permissions).toEqual(lock['permissions']);
    expect(manifest.optional_permissions).toEqual(lock['optional_permissions']);
    expect(manifest.optional_host_permissions).toEqual(lock['optional_host_permissions']);
  });

  it('requests no host permissions at install time (D25)', () => {
    expect(manifest.host_permissions).toBeUndefined();
    expect(lock['host_permissions']).toEqual([]);
  });

  it('declares no content scripts — everything is injected under activeTab', () => {
    expect(manifest.content_scripts).toBeUndefined();
  });

  it('exposes nothing to web pages', () => {
    expect(manifest.web_accessible_resources).toEqual([]);
  });

  it('spans incognito so one unlocked session serves incognito windows (D29)', () => {
    expect(manifest.incognito).toBe('spanning');
  });

  it('declares the three keyboard commands', () => {
    expect(Object.keys(manifest.commands ?? {}).sort()).toEqual([
      'add-current-tab',
      'open-manager',
      'panic-lock',
    ]);
  });

  it('takes its version from package.json and floors Chrome at 116', () => {
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.minimum_chrome_version).toBe(MINIMUM_CHROME_VERSION);
    expect(buildManifest('1.2.0-rc.1').version).toBe('1.2.0.1');
  });

  it('takes its name and description from _locales', () => {
    expect(manifest.name).toBe('__MSG_extName__');
    expect(manifest.description).toBe('__MSG_extDescription__');
    expect(manifest.default_locale).toBe('en');
  });
});
