<!--
  Security vulnerability? Do NOT open a pull request.
  Report it privately: https://github.com/zyndata/vaulta-mark/security/advisories/new
-->

## What this changes

<!-- One paragraph. What behaviour is different afterwards, and why. -->

## Phase

<!-- Which phase of PLAN.md §9 this belongs to, or "outside the phase plan" with a reason. -->

Phase:

Related issue(s): <!-- Fixes #NNN — required for anything touching src/crypto/** or the vault format -->

## Checklist

- [ ] **Scope** — this does one thing, and nothing outside the phase's scope.
- [ ] **Tests** — added or updated, including the test that would have caught the bug being fixed.
- [ ] **`npm run verify` is green locally** (lint + type-check + test + build + invariant scan).
- [ ] **Invariants** — unaffected, or re-verified if touched. See
      [PLAN.md §4](https://github.com/zyndata/vaulta-mark/blob/dev/PLAN.md#4-hard-invariants).
- [ ] **Permissions** — unchanged. If they changed: `build/permissions.lock.json` is updated in this
      PR *and* there is a CHANGELOG entry saying what and why.
- [ ] **Runtime dependencies** — still zero. If one was added: linked issue with the written case and
      a bundle-size measurement, plus a note in `docs/ARCHITECTURE.md` §Dependencies.
- [ ] **CHANGELOG.md** — updated under `## [Unreleased]` for any user-visible change.
- [ ] **Docs** — `docs/ARCHITECTURE.md` / `README.md` / `docs/RELEASE.md` updated where behaviour
      they describe has changed.
- [ ] **Crypto / vault format** — untouched. If touched: linked issue, spec updated first,
      `SCHEMA_VERSION` bumped, migration + fixture included, known-answer tests added.
- [ ] **No secrets, no real vault data, no plaintext logging** in the diff.
- [ ] **Commits** follow Conventional Commits and are signed off (`git commit -s`, DCO 1.1).

## How this was tested

<!-- Automated tests, plus what you clicked in a real browser if anything is user-facing.
     Chrome version and OS, if relevant. -->

## Notes for review

<!-- Tradeoffs made, alternatives rejected, anything you want a second opinion on. Delete if none. -->
