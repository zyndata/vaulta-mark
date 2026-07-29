/**
 * The in-repo MV3 build plugin (D2 — we deliberately do not use `@crxjs/vite-plugin`).
 *
 * It does exactly four things, all of them small enough to audit:
 *   1. emits `manifest.json` from the typed source in `build/manifest.ts`
 *   2. flattens the HTML entries so they land at `dist/popup.html`, not `dist/src/popup/popup.html`
 *   3. builds the service worker as one un-split ES module (`dist/background.js`)
 *   4. builds the content script as one self-contained IIFE (`dist/og-capture.js`)
 *
 * (3) and (4) are separate Rollup passes because a single pass cannot mix output formats, and
 * because a service worker that code-splits will eventually try to `import()` after the worker
 * was terminated — a failure mode that is invisible in development and fatal in the field.
 * See docs/ARCHITECTURE.md §2 "Entry configuration".
 */

import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';

import { buildManifest } from './manifest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const BACKGROUND_ENTRY = resolve(repoRoot, 'src/background/index.ts');
const CONTENT_ENTRY = resolve(repoRoot, 'src/content/og-capture.ts');

const TARGET = 'chrome116';

export interface Mv3PluginOptions {
  /** `package.json` version, mapped to a Chrome version by `build/version.ts`. */
  version: string;
}

export function mv3(options: Mv3PluginOptions): Plugin {
  let outDir = 'dist';
  let minify: boolean | 'esbuild' | 'terser' = 'esbuild';

  return {
    name: 'vaultamark:mv3',
    apply: 'build',
    // Vite's own HTML plugin emits the documents in `generateBundle`; ours has to run after it
    // to rename them.
    enforce: 'post',

    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      minify = config.build.minify;
    },

    generateBundle(_options, bundle) {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(buildManifest(options.version), null, 2)}\n`,
      });

      // Vite names HTML outputs by their path relative to `root`; the manifest wants them at the
      // package root. Script and style references are absolute (`/assets/…`), which resolves
      // against the extension origin, so moving the document does not break them.
      for (const [key, output] of Object.entries(bundle)) {
        if (output.type !== 'asset' || !key.endsWith('.html')) continue;
        const flattened = basename(key);
        if (flattened === key) continue;
        Reflect.deleteProperty(bundle, key);
        output.fileName = flattened;
        bundle[flattened] = output;
      }
    },

    async closeBundle() {
      await buildSingleFile({
        entry: BACKGROUND_ENTRY,
        fileName: 'background.js',
        format: 'es',
        outDir,
        minify,
      });

      // Phase 11 adds the OG-capture content script. Until then there is nothing to inject, and
      // shipping an empty file would be dead weight in the package.
      if (existsSync(CONTENT_ENTRY)) {
        await buildSingleFile({
          entry: CONTENT_ENTRY,
          fileName: 'og-capture.js',
          format: 'iife',
          outDir,
          minify,
        });
      }
    },
  };
}

interface SingleFileBuild {
  entry: string;
  fileName: string;
  format: 'es' | 'iife';
  outDir: string;
  minify: boolean | 'esbuild' | 'terser';
}

async function buildSingleFile({
  entry,
  fileName,
  format,
  outDir,
  minify,
}: SingleFileBuild): Promise<void> {
  await build({
    configFile: false,
    // `public/` is copied by the parent build; copying it again would race with it.
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: false,
      target: TARGET,
      minify,
      sourcemap: 'hidden',
      lib: {
        entry,
        formats: [format],
        name: 'vaultaMark',
        fileName: () => fileName,
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
    },
  });
}
