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
 * Drive the plugin's `generateBundle` hook the way Rollup does, with a minimal plugin context.
 * `closeBundle` is deliberately not exercised here — it shells out to two real Vite builds, which
 * is what `npm run build` in `npm run verify` covers.
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
  void hook.call(context as never, {} as never, bundle as never, false);

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
    const { bundle } = runGenerateBundle({
      'src/popup/popup.html': { type: 'asset', fileName: 'src/popup/popup.html', source: '<html>' },
      'src/manager/manager.html': {
        type: 'asset',
        fileName: 'src/manager/manager.html',
        source: '<html>',
      },
      'assets/popup-a1b2.js': { type: 'chunk', fileName: 'assets/popup-a1b2.js' },
    });

    expect(Object.keys(bundle).sort()).toEqual([
      'assets/popup-a1b2.js',
      'manager.html',
      'popup.html',
    ]);
    expect(bundle['popup.html']?.fileName).toBe('popup.html');
  });

  it('leaves an already-flat document and every non-HTML output alone', () => {
    const { bundle } = runGenerateBundle({
      'popup.html': { type: 'asset', fileName: 'popup.html', source: '<html>' },
      'assets/popup-a1b2.css': { type: 'asset', fileName: 'assets/popup-a1b2.css', source: 'a{}' },
    });

    expect(Object.keys(bundle).sort()).toEqual(['assets/popup-a1b2.css', 'popup.html']);
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
});
