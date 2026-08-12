import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

import { mv3 } from './build/mv3-plugin';
import pkg from './package.json';

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig(({ mode }) => {
  /*
   * The two build-time secrets (RELEASE §5), read the way the docs have always claimed they were.
   *
   * `loadEnv` is required and is easy to leave out: Vite reads `.env*` into `import.meta.env`, not
   * into `process.env`, and only the `VITE_`-prefixed keys at that — so a plugin reading
   * `process.env['VM_OAUTH_CLIENT_ID']` saw nothing however carefully `.env.local` was written, and
   * produced a manifest with no `oauth2` block. `loadEnv` reads the files *and* folds in matching
   * `process.env` entries, so an exported shell variable (CI) and a gitignored file (a laptop) both
   * work, with the file winning locally.
   *
   * The `VM_` prefix is what allows these to be read at all — the prefix argument is precisely the
   * allowlist that stops an unrelated environment variable ending up in a shipped artifact.
   */
  const env = loadEnv(mode, process.cwd(), 'VM_');

  return {
    // Copied verbatim into dist/: icons and _locales.
    publicDir: 'public',

    plugins: [
      mv3({
        version: pkg.version,
        env: { clientId: env['VM_OAUTH_CLIENT_ID'], key: env['VM_MANIFEST_KEY'] },
      }),
    ],

    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'chrome116',
      minify: 'esbuild',
      // Maps are built and uploaded as a CI artifact for debugging, and excluded from the store
      // zip by scripts/zip.mjs. "hidden" keeps the `//# sourceMappingURL` comment out of dist/.
      sourcemap: 'hidden',
      // Nothing here is served over a network; a hundred kilobytes inlined as base64 would only
      // make the invariant scanners' job harder.
      assetsInlineLimit: 0,
      // Chrome 116 supports modulepreload natively, and the polyfill is one more emitted script
      // in a package whose whole selling point is that you can read all of it.
      modulePreload: false,
      rollupOptions: {
        input: {
          popup: src('src/popup/popup.html'),
          manager: src('src/manager/manager.html'),
        },
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
