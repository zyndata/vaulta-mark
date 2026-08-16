# VaultaMark — Security, Performance & Repository Audit

**Date:** 2026-08-15 · **Auditor:** automated senior DevOps/security review · **Scope:** full
working tree at `dev` (post-`phase-13-done`, post-publication), GitHub repository settings via API,
dependency tree, CI/CD workflows, and source-level security patterns.

Everything below was **measured against the actual repository**, not inferred from documentation:
git history was searched for secret-pattern files, `npm audit` was run both ways, GitHub settings
and rulesets were read back through the API, and source greps were run for the classic web-extension
failure modes (`innerHTML`, `eval`, weak randomness, unconfined `fetch`, unsealed credentials).

---

## 1. Executive Summary

This repository is in **unusually strong shape** — materially above industry norm for a solo
project. The security architecture is defense-in-depth and, more importantly, *enforced by
tooling* rather than convention: a frozen permissions lockfile, a byte-exact CSP asserted twice
independently, an absolute-URL allowlist scanned against the built `dist/`, `crypto.subtle`
confined to one directory by ESLint, zero runtime dependencies, and `npm audit` clean with and
without dev dependencies. GitHub-side, secret scanning, push protection, Dependabot security
updates, CodeQL (push + PR + weekly), private vulnerability reporting, and active rulesets on
`main`/`dev`/release tags are all verified **on**.

**No Critical or High findings.** What remains is supply-chain hardening in the release pipeline
(mutable action tags and an unpinned CLI in the job that holds Chrome Web Store credentials),
local-machine credential hygiene (a private key inside the working tree), and a handful of
workflow polish items. Performance is actively budgeted and measured in CI; the one real
optimization opportunity (the 147 KB PSL literal in the worker bundle) is already recorded in
PLAN.md with a designed solution and is not urgent while cold start measures ~50 ms.

| Area | Verdict |
| --- | --- |
| Dependency vulnerabilities | ✅ 0 advisories (`npm audit`, with and without `--omit=dev`) |
| Secrets in history | ✅ None — `*.pem` / `client_secret*` / `.env*` never committed (`.env.example` only) |
| Crypto parameters | ✅ PBKDF2-HMAC-SHA256 @ 600 000 = OWASP-recommended floor; minimum enforced on read |
| XSS surface | ✅ No `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write` anywhere in `src/` |
| Network confinement | ✅ `fetch` only in `src/sync/drive/**` (+ injected test seams), allowlist-scanned |
| CI/CD secrets handling | ⚠️ Correctly scoped, but the publish job's toolchain is not integrity-pinned |
| GitHub settings | ✅ Secret scanning, push protection, Dependabot, CodeQL, PVR all enabled |

---

## 2. Security Findings

### Critical

*None found.*

### High

*None found.*

### Medium

#### M0 — The `chrome-web-store` deployment environment does not exist yet

[release.yml:131](.github/workflows/release.yml#L131) gates the publish job on
`environment: chrome-web-store`, and the workflow comment (and RELEASE §6.5) describe it as
"configured with required reviewers, so a publish waits for a human." **Read back via the API,
the repository has only a `github-pages` environment** — `chrome-web-store` has never been
created. When a workflow references a nonexistent environment, GitHub creates it implicitly on
first run **with no protection rules**, so the documented human-approval gate would silently not
fire. Today this is latent (the `CWS_*` secrets presumably aren't configured either, and the
dispatch itself requires maintainer access), but it is exactly the kind of assumed-but-unmeasured
setting this repository's own docs warn about.

**Fix (before the first Store upload):** Settings → Environments → *New environment* →
`chrome-web-store` → enable **Required reviewers** (yourself) — and store the four `CWS_*`
secrets as **environment secrets** there rather than repository secrets, so they are only ever
exposed to runs that passed the review gate. Then read the protection rules back via
`gh api repos/zyndata/vaulta-mark/environments`.

#### M1 — GitHub Actions referenced by mutable tags in credential-bearing workflows

All `uses:` references are pinned to major tags (`actions/checkout@v7`,
`softprops/action-gh-release@v2`, `github/codeql-action@v4`, …), which are **mutable**: whoever
controls the action repository can move the tag. This matters most in
[release.yml](.github/workflows/release.yml), where the `publish` job's environment holds
`CWS_CLIENT_SECRET` and `CWS_REFRESH_TOKEN` — a standing credential over the Store listing —
and where `softprops/action-gh-release` is a third-party action with `contents: write`.

**Fix:** pin every `uses:` to a full commit SHA with the tag as a trailing comment, and let
Dependabot maintain the pins (it updates SHA pins and rewrites the comment):

```yaml
# before
- uses: softprops/action-gh-release@v2
# after (SHA is illustrative — take it from the tag you audit)
- uses: softprops/action-gh-release@01570a1f39cb168c169c802c3bceb9e93fb10974 # v2.1.0
```

The existing `github-actions` Dependabot ecosystem entry already covers pinned SHAs — no
config change needed beyond the pins themselves.

#### M2 — `chrome-webstore-upload-cli` installed unpinned at publish time

[release.yml:151](.github/workflows/release.yml#L151) runs
`npm install -g chrome-webstore-upload-cli@3` in the same job whose environment exposes all four
`CWS_*` secrets. `@3` floats across every future `3.x.y` — a compromised patch release of that
package (or any of its transitive dependencies, installed with lifecycle scripts enabled and no
lockfile) executes with the publishing credentials in `process.env`.

**Fix:** pin the exact version and disable lifecycle scripts:

```yaml
- run: npm install -g --ignore-scripts chrome-webstore-upload-cli@3.3.2
```

(Substitute the current audited version.) Longer-term, prefer calling the Store upload API
directly with `curl` — the surface is one `PUT` and one `POST` — which removes the npm
supply chain from the credential path entirely.

#### M3 — `workflow_dispatch` input interpolated directly into shell scripts

`${{ inputs.tag || github.ref_name }}` appears inside `run:` blocks in
[release.yml](.github/workflows/release.yml) (steps "Tag must be on main", "Version must match
the tag", "Release notes", and the publish job's guard). `github.ref_name` is constrained by the
tag filters, but `inputs.tag` is **free text** typed into the dispatch form. Expression
interpolation happens before the shell sees the script, so a value like `v1.0.0"; curl …` becomes
shell code. Exploitation requires dispatch permission (today: the maintainer), so this is
hardening rather than an open hole — but it is the canonical GHA injection pattern and costs
nothing to close.

**Fix:** route the value through an environment variable, which the shell then treats as data:

```yaml
- name: Version must match the tag
  env:
    TAG: ${{ inputs.tag || github.ref_name }}
  run: node scripts/check-version-sync.mjs "$TAG"
```

Apply the same pattern to each step that currently interpolates the expression into `run:`.

### Low

#### L1 — Private key and OAuth client file inside the working tree

`dev-unpacked.pem` (the development packing key) and
`client_secret_390386524922-….json` sit in the repository root. Both are gitignored, **verified
untracked, and verified never present anywhere in history** — and the client JSON was inspected
and confirmed to be the Chrome-extension client type, which carries no secret (client id only,
already public in the shipped manifest). The residual risk is process, not state: a private key
inside a published repo's directory is one `git add -f`, one `.gitignore` regression, or one
overzealous backup/copy away from disclosure, and push protection does not reliably flag PEM
material.

**Fix:** move `dev-unpacked.pem` outside the repository directory (e.g.
`%USERPROFILE%\.vaulta-mark\dev-unpacked.pem`) and reference it by path where needed; the
`client_secret_*.json` can simply be deleted — its one useful value (the client id) already
lives in `.env.local`.

#### L2 — `actions/checkout` persists the workflow token into the git config

`persist-credentials` defaults to `true`, writing the `GITHUB_TOKEN` into `.git/config` for the
rest of the job — where any subsequent step (including the npm-installed toolchain from M2's
scenario) can read it. No step in these workflows needs authenticated git after checkout.

**Fix:** add to every checkout:

```yaml
- uses: actions/checkout@<sha>
  with:
    persist-credentials: false
```

(`release.yml`'s checkout also passes `ref` and `fetch-depth: 0`; keep those.)

#### L3 — No egress restriction on CI runners

CI and release jobs can reach any host. An egress-audited runner
(`step-security/harden-runner` in `audit` mode first, then `block` with an allowlist of
`registry.npmjs.org`, `github.com`, Playwright's CDN, and — for publish —
`www.googleapis.com`/`accounts.google.com`) turns "a compromised dependency phones home" from
undetectable into blocked-and-logged. Optional; adopt after M1/M2 since it is itself a
third-party action and should be SHA-pinned like the rest.

#### L4 — Release artifacts carry checksums but no provenance attestation

The zip is deterministic and `SHA256SUMS` is published — good. GitHub's build provenance
attestation (`actions/attest-build-provenance`) would additionally bind the artifact to the
exact workflow run, commit, and builder, verifiable with `gh attestation verify`. This is the
current best practice for release pipelines and is free on public repositories.

**Fix:** in the `build` job, after `npm run zip`:

```yaml
permissions:
  contents: write
  id-token: write
  attestations: write
steps:
  # …
  - uses: actions/attest-build-provenance@<sha> # vX
    with:
      subject-path: release/vaulta-mark-*.zip
```

### Verified sound (no action)

These were checked explicitly and are recorded so the next audit doesn't re-derive them:

- **History hygiene:** `git log --all --diff-filter=A` over `*.pem`, `client_secret*`, `.env*`
  matches only `.env.example`. One committer identity throughout.
- **Key custody:** the Drive refresh token is sealed under a vault subkey before touching
  `storage.local`, and one that arrives while the vault is locked is *dropped*, not stored in the
  clear ([auth.ts:321-331](src/sync/drive/auth.ts#L321-L331)). The primary auth route
  (`getAuthToken`) never exposes a refresh token at all.
- **KDF:** 600 000 PBKDF2-SHA256 iterations meets the OWASP recommendation; a floor
  (`MIN_KDF_ITERATIONS`) is enforced when *reading* a vault header, so a downgraded header is
  rejected rather than obeyed. Revisit the number roughly annually (see action plan).
- **Randomness:** the only `Math.random` uses are retry jitter in
  [rate.ts:160](src/sync/rate.ts#L160) and [api.ts:93](src/sync/drive/api.ts#L93) — correct;
  key/IV/id material goes through WebCrypto.
- **DOM injection:** zero hits for `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`
  in `src/`; page-derived text (OG metadata) enters the DOM as text nodes with a hostile-input
  test feeding it markup.
- **Manifest:** exact CSP asserted in two independent places; `web_accessible_resources` empty;
  no host permissions at install; `oauth2` omitted entirely when unconfigured; permissions frozen
  by `build/permissions.lock.json` + `verify-manifest.mjs`.
- **Workflow permissions:** every workflow declares top-level `permissions: contents: read` and
  elevates per-job only where needed; release concurrency never cancels in progress; Store
  publish requires `workflow_dispatch` + explicit boolean + a reviewed environment, and refuses
  pre-release tags and tags not on `main`.
- **GitHub settings (read back via API, not assumed):** secret scanning ✅, push protection ✅,
  Dependabot security updates ✅, private vulnerability reporting ✅, rulesets active on `main`,
  `dev`, and `v*` tags (block deletion + force-push).

---

## 3. Performance Findings

Performance here is already engineered against *measured budgets* (bundle size, cold start, paint,
unlock time) that run in CI via `scripts/check-budgets.mjs`, which reads compressed sizes out of
the real zip rather than estimating. No leaks or unbounded growth were found; the write coalescer,
`apply` serialisation, memoised folder counts, and windowed list cover the classic traps. What
remains:

#### P1 — 147 KB PSL string literal dominates the worker bundle (planned, not urgent)

`background.js` is ~307 KB, of which ~147 KB is the Public Suffix List and ~6 KB the common-
passwords list, forcing a special-cased 340 KB chunk budget. Cold start is measured at ~50 ms, so
this is a *budget* problem, not a felt one. The designed fix is already recorded in PLAN.md:
ship the PSL as a package asset loaded via `fetch(chrome.runtime.getURL(…))` — an
extension-origin read, so INV-4 (no network) is unaffected — restoring a single-number chunk
budget. Do it when the worker next grows, not before.

#### P2 — Local wall-clock budget flakes on this machine

The 50 ms cold-start and 500-item-unlock budgets fail intermittently under the full parallel local
run (including at commits predating the code they gate) while `CI=1 npm run verify` is green.
The best-of-N sampling already applied to three tests is the right shape. **Recommendation:**
apply the `CI=1` budget tier automatically whenever the full parallel suite is running locally
(e.g. key the relaxed budget on `!process.env.VITEST_SINGLE_FILE` or a worker-count check), so a
red local `verify` always means something. A gate that cries wolf trains you to re-run it, which
is the failure mode the CodeQL comment in [codeql.yml](.github/workflows/codeql.yml) already
names.

#### P3 — Chrome-sync tier capacity (documented ceiling, no action)

Measured capacity is ~1,100 bookmarks (~100 KB quota, warning at 800); the published conservative
numbers stand. The bucketed layout already minimises rewrite amplification (one edit → one
bucket). Drive is the designed escape hatch. Nothing to do beyond keeping the warning thresholds.

#### P4 — Dev-dependency freshness

`npm outdated`: `@types/chrome` 0.2.5 → 0.2.6 (trivial patch, take it with the next Dependabot
group). TypeScript 7.0.2 is available but **must not be taken**: `typescript-eslint` refuses to
load under TS 7 (`typescript-eslint#10940`), which kills `npm run lint` and with it
`npm run verify` — the real gate, since CI cannot block a direct push. Dependabot PR #15 is
deliberately parked with the findings on it. Pre-stage the one-file fix
(`src/css.d.ts` with `declare module '*.css';` for the four `TS2882` side-effect CSS imports) so
the eventual bump is a same-day merge.

---

## 4. Repository & Workflow Review

#### R1 — Rulesets are minimal by design; record stands

`main`, `dev`, and `release-tags` rulesets each enforce only *block deletion* and
*block force-push*, with empty bypass lists. No required PRs or status checks — deliberate for a
solo repository (PLAN.md D32) and honestly documented in `docs/BRANCH_PROTECTION.md`, including
the measurement that "require linear history" would have rejected the `--no-ff` release merge.
**One addition worth making:** a ruleset restricting *who can create* `v*` tags adds nothing for
a solo maintainer today but becomes the control that matters the day a collaborator is added —
note it in BRANCH_PROTECTION.md as the trigger-condition item it is.

#### R2 — CI structure: sound; two small improvements

- The `e2e` job repeats checkout/install/build after `verify` already produced a `dist`
  artifact. Downloading the artifact instead would save ~a minute per run — but building from
  source in each job is also more hermetic. Keep as-is unless CI minutes become a concern; if
  changed, remember the upload/download major-version pairing constraint already noted in the
  workflows.
- `npm ci` runs without `--ignore-scripts` in all jobs. For a devDependency-only tree this is
  normal, but combined with L3 it is the main untrusted-code-execution point in CI. If
  harden-runner (L3) is adopted, this is covered; pinning via the lockfile (present, committed)
  is the existing mitigation.

#### R3 — Housekeeping

- `.gitignore` is comprehensive and correctly shaped (negated `.env.example`, fixture-scoped
  `.vmv` exception, editor/OS noise). No gaps found.
- `.nvmrc` (24) agrees with `engines.node >=24` and both CI `setup-node` calls read the file —
  consistent. Consider adding `"packageManager": "npm@<version>"` to `package.json` so Corepack
  pins the npm version the lockfile was written with.
- Local working tree carries `coverage/`, `test-results/`, `release/`, `dist/` — all ignored,
  all legitimately regenerable. No action.
- Dependabot config: weekly npm + monthly actions, grouped minors/patches, majors singly,
  targeting `dev` — matches how the repository actually works. No change.
- This file (`AUDIT_AND_ACTION_PLAN.md`) is currently untracked. It contains nothing sensitive
  (all paths and settings it names are either public or gitignored-local), so committing it is
  safe if you want the audit in-repo — your call per the repo's commit-only-when-asked rule.

---

## 5. Prioritized Action Plan

Ordered by (risk × effort). Items 1–4 are the substantive ones; everything after is polish or
deferred-by-design.

**Execution status as of 2026-08-15 evening.** Items 1–9 and 11 are done in four commits on `dev`
(`2869b23`, `60481bc`, `bd69fc7`, `da93c9b`), all pushed, `npm run verify` green before each.
Item 0 is the only one still open, and it is the only one that was never mine to do.

**Now (≤1 hour total):**

- [x] **0. Create the `chrome-web-store` environment with required reviewers, and move the
      `CWS_*` secrets into it** (M0). **Done 2026-08-16, and verified working rather than merely
      configured** — the environment gate held a run, the maintainer approved it, and
      `scripts/check-store-credentials.mjs` authenticated and read the Store item. That last part
      goes past what this audit asked for: the four secrets had no test that was not also a
      publish. Dispatching it is also what exposed a workflow that had never been runnable (see the
      note under item 1). Original finding, kept for the record:
      `gh api …/environments` lists only `github-pages`, and the IDE's own Actions extension flags
      `environment: chrome-web-store` as *"Value 'chrome-web-store' is not valid"*, which is a
      second independent confirmation. `docs/RELEASE.md` §6.5 now carries the step-by-step and the
      readback commands, and `docs/BRANCH_PROTECTION.md` §5 lists the environment as a setting with
      a state. Must precede the first Store upload.
- [x] **1. SHA-pin all `uses:` in the three workflows** (M1). Done — every SHA resolved through
      the GitHub API from the tag it claims. CodeQL has since run green on the pinned workflow.
- [x] **2. Pin `chrome-webstore-upload-cli` to an exact version with `--ignore-scripts`** (M2).
      Done at `3.5.0` (latest 3.x; 4.x exists and is a deliberate future decision, not a drive-by).
- [x] **3. Move `${{ inputs.tag … }}` interpolations behind `env:` indirection** (M3). Done, as a
      job-level `env: TAG:` covering all four steps, plus `AUTO_PUBLISH` chosen with a shell `if`.
      A scan asserts no `${{` remains in any `run:` block in any of the three workflows.
- [x] **4. Add `persist-credentials: false` to every checkout** (L2). Done — five checkouts.

**Soon (next working session):**

- [x] **5. Move `dev-unpacked.pem` out of the repository directory; delete the
      `client_secret_*.json`** (L1). Done. Both **moved** to `%USERPROFILE%\.vaulta-mark\` — the
      client JSON was moved rather than deleted, which meets the same goal without discarding
      something the maintainer may want. `scripts/dev-key.mjs` now writes there by default
      (`VM_DEV_KEY_DIR` overrides), so the file does not come back on the next `npm run dev-key`.
- [x] **6. Add build-provenance attestation to `release.yml`** (L4). Done, before 1.0.0 as advised.
- [x] **7. Take the `@types/chrome` 0.2.6 patch** (P4). Done directly rather than waiting for
      Dependabot; `npm outdated` now lists only the TypeScript bump that must not be taken.
- [x] **8. Pre-stage `src/css.d.ts`** (P4). Done. PR #15 stays parked.

**When convenient:**

- [x] **9. Auto-select the CI budget tier for full parallel local runs** (P2). Done, and the
      detection was measured across all six run modes rather than reasoned about. Note the cost,
      recorded in `test/helpers/budget.ts`: nothing holds the tight line unattended now.
- [ ] **10. Adopt `step-security/harden-runner` in audit mode** (L3). **Weighed and declined for
      now**, with the reasoning and the two reopening conditions written into `docs/RELEASE.md` §3 —
      zero runtime dependencies, a committed lockfile, and a credential-bearing install that is now
      pinned exact and `--ignore-scripts`, against an action that installs a privileged agent on
      every runner. Reopen on a runtime dependency or a second person with push access.
- [x] **11. Note the "restrict `v*` tag creation" ruleset** in `docs/BRANCH_PROTECTION.md` (R1).
      Done, in §4, framed as the trigger-condition item it is.

**Deferred by design (tracked, do not act now):**

- [ ] **12. PSL as a package asset** (P1) — recorded in PLAN.md; trigger is the worker chunk
      approaching its 340 KB budget, not the calendar.
- [ ] **13. Annual KDF-parameter review** — 600 000 PBKDF2-SHA256 iterations is the current
      OWASP floor; re-check the recommendation each year and remember a raise is a vault-header
      migration (`changePassword` path), not a constant edit.
- [ ] **14. TypeScript 7 migration** — blocked on `typescript-eslint#10940`; item 8 removes
      the only other known obstacle.

---

*Method note: settings marked ✅ were read back through the GitHub API after the fact, per the
repository's own lesson (BRANCH_PROTECTION.md §7): believe the readback, not the response.*
