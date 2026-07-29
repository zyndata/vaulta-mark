# End-to-end tests

Empty on purpose. `playwright.config.ts` is configured and `npm run test:e2e` runs green with no
tests; the first real specs arrive with the popup in **Phase 4**, and the full user-journey suite in
**Phase 12** (PLAN.md §9).

When writing the first spec, remember:

- Playwright's default `browser` fixture cannot load an extension. Launch a **persistent context**
  (`chromium.launchPersistentContext`) with `--disable-extensions-except=<dist>` and
  `--load-extension=<dist>`, against a **built** `dist/` — run `npm run build` first.
- The extension id is not known ahead of time. Read it from the service-worker URL
  (`context.serviceWorkers()[0].url()`), or set a `key` in the manifest for a stable id
  (docs/RELEASE.md §5.4).
- INV-4 is an E2E assertion: route-intercept every request the extension context makes and assert
  the "browse the vault" scenario records **zero** of them.
