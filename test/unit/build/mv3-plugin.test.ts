import { mv3, type Mv3PluginOptions } from '../../../build/mv3-plugin';

interface EmittedFile {
  type: 'asset';
  fileName: string;
  source: string;
}

interface BundleEntry {
  type: 'asset' | 'chunk';
  fileName: string;
  source?: string;
}

/**
 * Drive the plugin's `generateBundle` hook the way **Rolldown** does, with a minimal plugin context.
 * `closeBundle` is deliberately not exercised here — it shells out to two real Vite builds, which
 * is what `npm run build` in `npm run verify` covers.
 *
 * The bundle is a Proxy that throws on assignment, and that is the whole point of it. Rollup let a
 * plugin move an output by deleting one key and writing another; Rolldown — which is what Vite 8
 * builds with — honours the delete and *ignores the write*, with a warning on stderr and a zero
 * exit code. The plugin did exactly that, so the first Vite 8 build produced a `dist/` containing
 * no HTML at all and an extension Chrome would refuse to load, while this file stayed green
 * against a plain object that accepted the write. A mock that is more permissive than the real
 * thing is how a build breaks with the suite passing.
 */
function runGenerateBundle(
  bundle: Record<string, BundleEntry>,
  options: { env?: Mv3PluginOptions['env']; mode?: string } = {},
): {
  emitted: EmittedFile[];
  bundle: Record<string, BundleEntry>;
  manifest: Record<string, unknown>;
} {
  const plugin = mv3({ version: '1.4.2', ...(options.env === undefined ? {} : { env: options.env }) });
  const emitted: EmittedFile[] = [];
  const context = {
    emitFile: (file: EmittedFile) => emitted.push(file),
  };

  const guarded = new Proxy(bundle, {
    set(_target, key) {
      throw new Error(
        `the plugin assigned to bundle[${String(key)}]; Rolldown ignores that — use this.emitFile`,
      );
    },
  });

  // `mode` is the only thing this hook reads off the resolved config that changes the manifest, and
  // it is what gates the development-only `key`. Skipping it leaves the plugin's default, which is
  // production — the safe direction, and what the pre-existing cases here rely on.
  if (options.mode !== undefined) {
    const configResolved = plugin.configResolved;
    if (typeof configResolved !== 'function') throw new Error('configResolved must be a plain hook');
    void configResolved.call(plugin as never, {
      root: '.',
      mode: options.mode,
      build: { outDir: 'dist', minify: 'esbuild' },
    } as never);
  }

  const hook = plugin.generateBundle;
  if (typeof hook !== 'function') throw new Error('generateBundle must be a plain hook');
  void hook.call(context as never, {} as never, guarded as never, false);

  const manifest = emitted.find((file) => file.fileName === 'manifest.json');
  if (manifest === undefined) throw new Error('no manifest was emitted');

  return { emitted, bundle, manifest: JSON.parse(manifest.source) as Record<string, unknown> };
}

describe('mv3 build plugin', () => {
  it('emits a manifest built from the version it was given', () => {
    const { emitted } = runGenerateBundle({});
    const manifest = emitted.find((file) => file.fileName === 'manifest.json');
    expect(manifest).toBeDefined();

    const parsed = JSON.parse(manifest!.source) as Record<string, unknown>;
    expect(parsed['version']).toBe('1.4.2');
    expect(parsed['manifest_version']).toBe(3);
    expect(manifest!.source.endsWith('\n')).toBe(true);
  });

  it('flattens HTML entries to the package root, where the manifest points', () => {
    const { bundle, emitted } = runGenerateBundle({
      'src/popup/popup.html': {
        type: 'asset',
        fileName: 'src/popup/popup.html',
        source: '<html>popup</html>',
      },
      'src/manager/manager.html': {
        type: 'asset',
        fileName: 'src/manager/manager.html',
        source: '<html>manager</html>',
      },
      'assets/popup-a1b2.js': { type: 'chunk', fileName: 'assets/popup-a1b2.js' },
    });

    // The nested originals are gone — a delete is the one bundle mutation Rolldown honours...
    expect(Object.keys(bundle).sort()).toEqual(['assets/popup-a1b2.js']);

    // ...and the flat documents come back as emitted files, carrying the same bytes. Asserting the
    // source is what separates "a document is emitted" from "the right document is emitted": the
    // manifest points at these two names and Chrome loads whatever is behind them.
    const html = emitted.filter((file) => file.fileName.endsWith('.html'));
    expect(html.map((file) => file.fileName).sort()).toEqual(['manager.html', 'popup.html']);
    expect(html.find((file) => file.fileName === 'popup.html')?.source).toBe('<html>popup</html>');
    expect(html.find((file) => file.fileName === 'manager.html')?.source).toBe(
      '<html>manager</html>',
    );
  });

  it('leaves an already-flat document and every non-HTML output alone', () => {
    const { bundle, emitted } = runGenerateBundle({
      'popup.html': { type: 'asset', fileName: 'popup.html', source: '<html>' },
      'assets/popup-a1b2.css': { type: 'asset', fileName: 'assets/popup-a1b2.css', source: 'a{}' },
    });

    expect(Object.keys(bundle).sort()).toEqual(['assets/popup-a1b2.css', 'popup.html']);
    // Re-emitting a document that is already where it belongs would be a duplicate-name collision.
    expect(emitted.filter((file) => file.fileName.endsWith('.html'))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the two build-time secrets */

/**
 * `VM_OAUTH_CLIENT_ID` and `VM_MANIFEST_KEY` (RELEASE §5), which arrive as plugin options.
 *
 * They arrive as options *because* of the bug these tests exist to keep out. The plugin used to read
 * `process.env` directly while the docs said to put them in a gitignored `.env.local` — and Vite
 * does not load env files into `process.env`, only into `import.meta.env`, and only the
 * `VITE_`-prefixed keys at that. So the documented setup produced a manifest with no `oauth2` block,
 * silently, and Settings → Sync correctly reported that this build had no Google project. Nothing
 * was broken; the wiring between the file and the build had simply never existed.
 * `vite.config.ts` now calls `loadEnv` and passes the result in.
 */
describe('the OAuth client id and the development key', () => {
  it('emits the oauth2 block from the client id it was given, with drive.file alone', () => {
    const { manifest } = runGenerateBundle({}, { env: { clientId: 'abc.apps.googleusercontent.com' } });
    expect(manifest['oauth2']).toEqual({
      client_id: 'abc.apps.googleusercontent.com',
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
  });

  it('omits the oauth2 block entirely when no client id was configured', () => {
    // Not an empty client id: Chrome treats a malformed `oauth2` as a manifest error and refuses to
    // load the extension, so a plain source build has to come out installable and Drive-less.
    const { manifest } = runGenerateBundle({}, { env: {} });
    expect(manifest['oauth2']).toBeUndefined();
    expect(manifest['manifest_version']).toBe(3);
  });

  it('pins the unpacked id in a development build and never in a production one', () => {
    const env = { clientId: 'abc.apps.googleusercontent.com', key: 'BASE64PUBLICKEY' };
    expect(runGenerateBundle({}, { env, mode: 'development' }).manifest['key']).toBe(
      'BASE64PUBLICKEY',
    );
    // The Store assigns the real id, and a `key` that disagrees with it breaks the upload — so
    // `npm run build` must drop it however the environment is set.
    expect(runGenerateBundle({}, { env, mode: 'production' }).manifest['key']).toBeUndefined();
  });

  /*
   * A Chrome-extension OAuth client authorises exactly one Item ID, so the Store id and a stable
   * unpacked id need two clients — and picking between them is the same question as `key`: a build
   * that pins the unpacked id must present the client registered against it. Registering the Store
   * id on 2026-08-15 is what surfaced this; it *replaced* the development id, and the failure is
   * `Error 400: redirect_uri_mismatch` out of the PKCE fallback, which names none of the above.
   */
  it('prefers the development client id in a development build, and never in a production one', () => {
    const env = {
      clientId: 'store.apps.googleusercontent.com',
      clientIdDev: 'unpacked.apps.googleusercontent.com',
    };
    expect(runGenerateBundle({}, { env, mode: 'development' }).manifest['oauth2']).toMatchObject({
      client_id: 'unpacked.apps.googleusercontent.com',
    });
    // The Store package must carry the client registered against the Store-assigned id, whatever a
    // laptop's `.env.local` says — this is the one of the two that a wrong answer publishes.
    expect(runGenerateBundle({}, { env, mode: 'production' }).manifest['oauth2']).toMatchObject({
      client_id: 'store.apps.googleusercontent.com',
    });
  });

  it('falls back to the one client id when no development-only one is configured', () => {
    // The single-client setup every source build and every CI run has, and the setup this repository
    // itself had until a Store id existed to disagree with.
    const env = { clientId: 'abc.apps.googleusercontent.com' };
    expect(runGenerateBundle({}, { env, mode: 'development' }).manifest['oauth2']).toMatchObject({
      client_id: 'abc.apps.googleusercontent.com',
    });
  });
});
