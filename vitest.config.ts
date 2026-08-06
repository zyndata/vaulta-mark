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
        // Phase 8. A bug in either loses data outright — an export nobody can open, or an import
        // that overwrites a vault — so they sit with crypto and storage rather than with the glue.
        'src/io/**': { lines: 90, branches: 85 },
        'src/import/**': { lines: 90, branches: 85 },
        // Phase 9. It decides which browsing-history entries get deleted, and being wrong means
        // erasing a site the user never asked about — the same class of consequence as losing a
        // bookmark, so the same gate. `public-suffix.ts` is generated data with no branches in it.
        'src/history/**': { lines: 90, branches: 85 },
        // Phase 11. `thumbs/**` is where everything a page handed us is treated as hostile, and a
        // hole in it is an SSRF or a decompression bomb rather than a missing picture — so it sits
        // with crypto. `content/**` is the code that runs inside somebody else's document, which is
        // the least trustworthy place anything we ship ever executes.
        'src/thumbs/**': { lines: 90, branches: 85 },
        'src/content/**': { lines: 90, branches: 85 },
      },
    },
  },
});
