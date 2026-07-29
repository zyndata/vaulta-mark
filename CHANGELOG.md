# Changelog

All notable changes to VaultaMark are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is maintained **by hand**, in the same commit as the change it describes. It is written for
users; commit subjects are written for whoever reads the history. See
[docs/RELEASE.md §1](docs/RELEASE.md#1-branching-model) for how commit types map to the sections
below.

## [Unreleased]

### Added

- The extension now builds and loads: `npm run build` produces a Manifest V3 package in `dist/`
  that Chrome accepts via **Load unpacked**. It does nothing yet — a placeholder popup that reports
  the build version and whether the background service is running, an empty manager page, and a
  service worker that answers a heartbeat. The vault, the UI and sync arrive in later phases.
- Toolchain: TypeScript (strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`),
  Vite 5 with an in-repo MV3 build plugin, ESLint 9 with type-aware rules, Prettier, Vitest with
  coverage gates, and a Playwright harness. **Zero runtime dependencies**, as designed.
- `manifest.json` is generated from a typed source (`build/manifest.ts`): the six required
  permissions and no host permissions at install time, optional `identity`/`history`/`bookmarks`/
  `idle`, `incognito: "spanning"`, the strict CSP, the three keyboard shortcuts, no content scripts,
  and nothing exposed to web pages.
- Invariant scanners that run against the real build output, not the source: `verify-manifest.mjs`
  (Manifest V3, exact CSP, permission set diffed against `build/permissions.lock.json`) and
  `verify-no-remote-code.mjs` (`eval`, the `Function` constructor, remote or computed `import()`,
  `importScripts`, WASM, `sendBeacon`, `XMLHttpRequest`, `blob:`/`data:` script URLs, and any
  absolute URL outside `build/url-allowlist.json`). Both run in `npm run verify` and in CI, and the
  same bans are enforced at the source level by ESLint.
- `npm run zip` packages `dist/` into `release/vaulta-mark-<version>.zip` — deterministic, so a
  published zip can be hash-compared against a local build — excluding source maps, and printing
  the archive's SHA-256.
- A `chrome.*` test mock that enforces `chrome.storage.sync`'s real limits: per-item and total byte
  quotas, item count, and both write-rate ceilings, against an injectable clock.
- `.github/workflows/ci.yml` — lint, type-check, test with coverage, build, and the invariant
  scanners on every push to `dev`/`main` and on every pull request.
- `.github/workflows/codeql.yml` — CodeQL for JavaScript/TypeScript. Code scanning generally needs
  GitHub Advanced Security on a private repository, so this may not run until the repository is
  public (see `docs/BRANCH_PROTECTION.md` §5).
- `docs/DEVELOPMENT.md` — how to build, load the extension in Chrome, run each test tier, and what
  the invariant scanners check.
- `LICENSE` — GPL-3.0-only, the verbatim license text.
- `CONTRIBUTING.md` — branching model, Conventional Commits, DCO sign-off, how to run the test
  suite, the zero-runtime-dependencies rule, and the crypto-changes-need-an-issue-first rule.
- `SECURITY.md` — private reporting via GitHub Security Advisories, 90-day coordinated disclosure,
  what is in and out of scope, the no-warranty statement, and the no-password-recovery statement.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- Issue templates for bug reports and feature requests, a pull-request checklist, and an issue-chooser
  that routes security reports to the private advisory form instead of a public issue.
- `.github/dependabot.yml` — weekly npm and monthly GitHub Actions updates, minor and patch bumps
  grouped into one pull request per ecosystem.
- `docs/PRIVACY.md` — privacy policy: nothing is collected, no server exists, and the only network
  traffic is to the user's own Google Drive once they connect it.
- `docs/STORE_LISTING.md` — Chrome Web Store drafts: descriptions, single-purpose statement,
  per-permission justifications, data-usage answers, and the asset checklist.
- `docs/BRANCH_PROTECTION.md` — the branch, tag, and repository settings a maintainer applies by
  hand, and the reason CI cannot block a direct push.

### Changed

- Documentation now states that the repository is **private for now** and that publishing the source
  is a later decision — including what that blocks (GitHub Pages for the privacy-policy URL, private
  vulnerability reporting, the Store listing's repository link) and a checklist for the day it
  changes.
- `README.md` — filled in: the five differentiators, how the encryption works, what the vault does
  and does not protect against, the two sync tiers, the permission table, and the no-recovery
  warning. Screenshots and install instructions follow the first release. The Development section
  now points at `docs/DEVELOPMENT.md` and describes a toolchain that exists.

<!-- Sections are added as they are needed: Added · Changed · Deprecated · Removed · Fixed · Security -->

[Unreleased]: https://github.com/zyndata/vaulta-mark/commits/dev
