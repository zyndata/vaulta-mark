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
        // UI entry points are DOM glue with no branching logic; they are covered by the
        // Playwright suite instead (Phase 4 onward). Remove these two lines when the real UI
        // kit lands in src/ui/ — that code is unit-testable and must be gated.
        'src/popup/**',
        'src/manager/**',
      ],
      thresholds: {
        // D33. Near-total where a bug loses user data, moderate on glue. The per-path gates
        // are added as each module lands (Phase 2: crypto, Phase 3: vault + storage,
        // Phase 7: sync) — Vitest fails on a glob that matches no file, so they cannot be
        // written ahead of the code. Ratchet up, never down.
        lines: 70,
        branches: 60,
        'src/crypto/**': { lines: 90, branches: 85 },
        'src/vault/**': { lines: 90, branches: 85 },
        'src/storage/**': { lines: 90, branches: 85 },
      },
    },
  },
});
