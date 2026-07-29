import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { mv3 } from './build/mv3-plugin';
import pkg from './package.json';

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Copied verbatim into dist/: icons and _locales.
  publicDir: 'public',

  plugins: [mv3({ version: pkg.version })],

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
});
