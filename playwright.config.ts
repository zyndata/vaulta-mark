import { defineConfig } from '@playwright/test';

/**
 * E2E harness configuration. There are no E2E tests yet — the first ones arrive with the popup
 * in Phase 4, and the full journey suite in Phase 12 — but the configuration lands here so the
 * shape of the harness is settled before anyone writes a test against it.
 *
 * An MV3 extension cannot be tested through the normal browser fixture: it needs a **persistent
 * context** launched with `--disable-extensions-except` and `--load-extension` pointing at a
 * *built* `dist/`, and headless Chromium only runs extensions in the new headless mode. So the
 * suite always runs against a real build, single-worker (one browser profile, one vault), with
 * no retries locally so a flake is visible rather than papered over.
 */
export default defineConfig({
  testDir: 'test/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'on-first-retry',
    video: 'off',
    screenshot: 'only-on-failure',
  },
});
