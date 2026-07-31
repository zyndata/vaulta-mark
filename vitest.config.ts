import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // `all: true` counts files with no tests at all, which is the only way a coverage gate
      // catches "shipped untested" rather than "shipped untested and also unimported".
      all: true,
      include: ['src/**/*.ts', 'build/**/*.ts', 'scripts/**/*.mjs'],
      exclude: [
        // The page entry points: they run on import, wire listeners to a live `chrome` and a live
        // document, and have no seam a unit test can hold. The logic they would otherwise carry
        // lives in `src/ui/**` (gated below) and in the service worker; what is left here is
        // covered by the Playwright suite.
        'src/popup/**',
        'src/manager/**',
      ],
      thresholds: {
        // D33. Near-total where a bug loses user data, moderate on glue. The per-path gates
        // are added as each module lands (Phase 2: crypto, Phase 3: vault + storage,
        // Phase 4: background + shared + ui, Phase 7: sync) — Vitest fails on a glob that
        // matches no file, so they cannot be written ahead of the code. Ratchet up, never down.
        lines: 70,
        branches: 60,
        'src/crypto/**': { lines: 90, branches: 85 },
        'src/vault/**': { lines: 90, branches: 85 },
        'src/storage/**': { lines: 90, branches: 85 },
        'src/background/**': { lines: 90, branches: 85 },
        'src/shared/**': { lines: 90, branches: 85 },
        'src/ui/**': { lines: 90, branches: 85 },
        'src/sync/**': { lines: 90, branches: 85 },
      },
    },
  },
});
