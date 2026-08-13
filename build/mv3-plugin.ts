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
import { build, type Plugin, type ResolvedConfig } from 'vite';

import { buildManifest } from './manifest.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const BACKGROUND_ENTRY = resolve(repoRoot, 'src/background/index.ts');
const CONTENT_ENTRY = resolve(repoRoot, 'src/content/og-capture.ts');

const TARGET = 'chrome116';

/**
 * Whatever the installed Vite calls a minifier, taken from Vite rather than spelled out here.
 * The set is not stable across majors — Vite 8 added `'oxc'` to `boolean | 'esbuild' | 'terser'` —
 * and the only thing this plugin does with the value is hand the parent build's choice to the two
 * child builds unchanged, so it has no business having an opinion about the members.
 */
type Minify = ResolvedConfig['build']['minify'];

export interface Mv3PluginOptions {
  /** `package.json` version, mapped to a Chrome version by `build/version.ts`. */
  version: string;
  /**
   * The Google OAuth client id and the development-only manifest `key` (RELEASE §5).
   *
   * Passed in rather than read from `process.env` here, and that is the fix for a real trap: the
   * docs have always said these live in a gitignored `.env.local`, but **Vite does not put env
   * files into `process.env`** — it loads them into `import.meta.env`, and only the `VITE_`-prefixed
   * ones at that. So the documented setup silently produced a manifest with no `oauth2` block, and
   * the only thing that ever worked was exporting a real shell variable. `vite.config.ts` now calls
   * `loadEnv`, which reads the files *and* folds in matching `process.env` entries, so both work.
   */
  env?: {
    readonly clientId?: string | undefined;
    readonly key?: string | undefined;
  };
}

export function mv3(options: Mv3PluginOptions): Plugin {
  let outDir = 'dist';
  let minify: Minify = 'esbuild';
  let development = false;

  return {
    name: 'vaultamark:mv3',
    apply: 'build',
    // Vite's own HTML plugin emits the documents in `generateBundle`; ours has to run after it
    // to rename them.
    enforce: 'post',

    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      minify = config.build.minify;
      development = config.mode !== 'production';
    },

    generateBundle(_options, bundle) {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(
          buildManifest(options.version, {
            // Both from the environment (RELEASE §5), because neither belongs in the repository:
            // the client id is public but is per-Google-project, and the key pins a *development*
            // extension id and must never reach a Store build — hence the mode check.
            clientId: options.env?.clientId,
            ...(development ? { key: options.env?.key } : {}),
          }),
          null,
          2,
        )}\n`,
      });

      /*
       * Vite names HTML outputs by their path relative to `root`; the manifest wants them at the
       * package root. Script and style references are absolute (`/assets/…`), which resolves
       * against the extension origin, so moving the document does not break them.
       *
       * Re-emitting rather than moving the entry inside `bundle` is not a style choice. Vite 8
       * bundles with **Rolldown**, which refuses assignment to `bundle` outright ("This plugin
       * assigns to bundle variable … This will be ignored") while still honouring the delete — so
       * the previous delete-then-reassign pair silently shipped a `dist/` with **no HTML at all**
       * and an extension that would not load. `this.emitFile` is the supported path and is what
       * the Rolldown error message itself points at.
       */
      for (const [key, output] of Object.entries(bundle)) {
        if (output.type !== 'asset' || !key.endsWith('.html')) continue;
        const flattened = basename(key);
        if (flattened === key) continue;
        Reflect.deleteProperty(bundle, key);
        this.emitFile({ type: 'asset', fileName: flattened, source: output.source });
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
  minify: Minify;
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
        // One file, always: `codeSplitting: false` is Rolldown's name for what Rollup called
        // `inlineDynamicImports`, which Vite 8 still accepts and warns about. The requirement it
        // encodes has not changed — a service worker that splits will eventually `import()` a
        // chunk after the worker was torn down, which never reproduces in development.
        output: { codeSplitting: false },
      },
    },
  });
}
