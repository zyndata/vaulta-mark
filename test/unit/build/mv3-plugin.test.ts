import { mv3 } from '../../../build/mv3-plugin';

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
function runGenerateBundle(bundle: Record<string, BundleEntry>): {
  emitted: EmittedFile[];
  bundle: Record<string, BundleEntry>;
} {
  const plugin = mv3({ version: '1.4.2' });
  const emitted: EmittedFile[] = [];
  const context = {
    emitFile: (file: EmittedFile) => emitted.push(file),
  };

  const hook = plugin.generateBundle;
  if (typeof hook !== 'function') throw new Error('generateBundle must be a plain hook');
  void hook.call(context as never, {} as never, bundle as never, false);

  return { emitted, bundle };
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
