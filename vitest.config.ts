import { defineConfig } from 'vitest/config';

/**
 * Which wall-clock budget tier this run is held to — see `test/helpers/budget.ts`.
 *
 * Two tests assert a stopwatch reading: the worker's cold start and a 500-item unlock. Both are
 * real budgets from ARCHITECTURE §7.2 and both were measured to fail intermittently under the full
 * ~95-file parallel run on a development machine — including at commits predating the code they
 * gate — while `CI=1 npm run verify` stayed green. A gate that is red for a reason other than the
 * code teaches you to re-run it, which is the same failure the note at the top of `codeql.yml`
 * describes; a budget nobody believes is not a budget.
 *
 * So the tight number applies when the run is *targeted* — a file or a name filter on the command
 * line, which is what you type when you are actually measuring — and the relaxed CI number applies
 * to the whole-suite run, where the measurement is of the scheduler as much as of the code.
 *
 * Detection is by CLI filter rather than by worker count, because the count is identical either way
 * and `VITEST_POOL_ID` / `VITEST_WORKER_ID` describe *one file's* placement, not the size of the
 * run — a budget file that happens to land first sees `0` in a 95-file run. The one sharp edge:
 * a flag written as `--reporter basic` leaves a bare `basic` here and reads as a filter. Prefer
 * `--reporter=basic`, or set `VM_BUDGET_TIER` explicitly.
 */
function budgetTier(): 'tight' | 'relaxed' {
  const explicit = process.env['VM_BUDGET_TIER'];
  if (explicit === 'tight' || explicit === 'relaxed') return explicit;
  if (process.env['CI'] !== undefined) return 'relaxed';

  const subcommands = new Set(['run', 'watch', 'dev', 'related', 'bench', 'list', 'init']);
  const targeted = process.argv
    .slice(2)
    .some((arg) => !arg.startsWith('-') && !subcommands.has(arg));
  return targeted ? 'tight' : 'relaxed';
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    env: { VM_BUDGET_TIER: budgetTier() },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // Files with no tests at all are counted, which is the only way a coverage gate catches
      // "shipped untested" rather than "shipped untested and also unimported". Vitest 4 removed
      // the `all` flag that used to say so: everything matched by `include` is now reported
      // whether or not a test imported it, which is the behaviour this project always wanted.
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
