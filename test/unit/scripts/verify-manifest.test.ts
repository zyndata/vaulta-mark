import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildManifest } from '../../../build/manifest';
import { checkManifest, EXPECTED_CSP } from '../../../scripts/verify-manifest.mjs';

const lock = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../build/permissions.lock.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown>;

const good = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(buildManifest('1.0.0'))) as Record<string, unknown>;

describe('manifest scanner (INV-2, INV-9)', () => {
  it('accepts the manifest this repository actually builds', () => {
    expect(checkManifest(good(), lock)).toEqual([]);
  });

  it('asserts the CSP independently of build/manifest.ts', () => {
    expect(EXPECTED_CSP).toBe("script-src 'self'; object-src 'self'; frame-ancestors 'none'");
  });

  it('rejects a downgraded manifest version', () => {
    const manifest = { ...good(), manifest_version: 2 };
    expect(checkManifest(manifest, lock).join('\n')).toMatch(/manifest_version must be 3/);
  });

  it('rejects a relaxed CSP', () => {
    for (const csp of [
      "script-src 'self' 'unsafe-eval'; object-src 'self'; frame-ancestors 'none'",
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; frame-ancestors 'none'",
      "script-src 'self' https://cdn.example.com; object-src 'self'; frame-ancestors 'none'",
      "script-src 'self'; object-src 'self'",
    ]) {
      const manifest = { ...good(), content_security_policy: { extension_pages: csp } };
      expect(checkManifest(manifest, lock).length).toBeGreaterThan(0);
    }
  });

  it('rejects a CSP key we did not expect', () => {
    const manifest = {
      ...good(),
      content_security_policy: { extension_pages: EXPECTED_CSP, sandbox: "script-src 'self'" },
    };
    expect(checkManifest(manifest, lock).join('\n')).toMatch(/unexpected content_security_policy/);
  });

  it('rejects a permission the lock file does not list', () => {
    const manifest = good();
    manifest['permissions'] = [...(manifest['permissions'] as string[]), 'tabs'];
    expect(checkManifest(manifest, lock).join('\n')).toMatch(/permissions grew.*tabs/s);
  });

  it('rejects a host permission requested at install time', () => {
    const manifest = { ...good(), host_permissions: ['https://www.googleapis.com/*'] };
    expect(checkManifest(manifest, lock).join('\n')).toMatch(/host_permissions grew/);
  });

  it('notices a permission that silently disappeared from the manifest', () => {
    const manifest = good();
    manifest['permissions'] = (manifest['permissions'] as string[]).filter((p) => p !== 'favicon');
    expect(checkManifest(manifest, lock).join('\n')).toMatch(/permissions shrank/);
  });

  it('rejects declared content scripts and exposed resources', () => {
    expect(
      checkManifest({ ...good(), content_scripts: [{ matches: ['<all_urls>'] }] }, lock).join('\n'),
    ).toMatch(/content_scripts is declared/);
    expect(
      checkManifest({ ...good(), web_accessible_resources: [{ resources: ['x.js'] }] }, lock).join(
        '\n',
      ),
    ).toMatch(/web_accessible_resources must be empty/);
  });

  it('rejects a non-spanning incognito mode and a classic-script worker', () => {
    expect(checkManifest({ ...good(), incognito: 'split' }, lock).join('\n')).toMatch(
      /incognito must be "spanning"/,
    );
    expect(
      checkManifest({ ...good(), background: { service_worker: 'background.js' } }, lock).join(
        '\n',
      ),
    ).toMatch(/background must be/);
  });
});
