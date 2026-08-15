# VaultaMark — Release Runbook

Branching, CI/CD, tagging, and Chrome Web Store publishing. Implemented in
[Phase 13 of PLAN.md](../PLAN.md#phase-13--release-engineering--100); the CI gate is implemented in
Phase 1.

**Contents**

1. [Branching model](#1-branching-model)
2. [Branch protection settings](#2-branch-protection-settings)
3. [CI](#3-ci)
4. [Cutting a release](#4-cutting-a-release)
5. [Google Cloud & OAuth setup](#5-google-cloud--oauth-setup)
6. [Chrome Web Store setup and the four secrets](#6-chrome-web-store-setup-and-the-four-secrets)
7. [The release workflow](#7-the-release-workflow)
8. [Store listing checklist](#8-store-listing-checklist)
9. [Hotfixes](#9-hotfixes)
10. [Rollback](#10-rollback)

---

## 1. Branching model

```
main    ──●────────────────────────●────────────────────────●──►   release-only, protected
          │ v1.0.0                 │ v1.1.0                 │ v1.1.1
          │ --no-ff merge          │                        │
dev     ──●──●──●──●──●──●──●──●───●──●──●──●──●──●──●──●───●──►   all development happens here
             ↑        ↑                    ↑        ↑
        phase-2-done  phase-3-done   feat/phase-7   phase-8-done
                                     (risky work only)
```

**This is a solo repository.** There are deliberately **no pull-request or approval requirements** —
they gate a reviewer who does not exist, and the ceremony costs more than it catches. What replaces
them: `npm run verify` locally before every push, CI as the backstop, and a `phase-N-done` tag as the
"this is finished and green" marker.

| Branch | Rules |
| --- | --- |
| `main` | Release-only. Receives a `--no-ff` merge from `dev` at release time and nothing else (except hotfix branches, §9). Never commit to it directly. Force pushes and deletions blocked; linear history required. |
| `dev` | Where all development happens. Direct commits, one per logical unit. Always green, always installable. Force pushes and deletions blocked. |
| `feat/*` | **Optional**, for work risky enough to want a clean revert point — Phase 7 (the sync merge engine) is the one phase that uses one. Merged back with `--no-ff`, then deleted. |
| PRs | Not required for the maintainer, but fully available: the repository is public, so outside contributions arrive as PRs targeting `dev` and CI gates them automatically. |

**Phase tags.** Each completed phase gets an annotated tag on `dev`:

```bash
git tag -a phase-7-done -m "Phase 7: ChromeSyncProvider, merge engine, conflict UI"
git push origin phase-7-done
```

These give bisect and revert points across a 14-phase build without PR overhead, and make
"which commit was the last known-good state of Phase 6" a one-command question.

**Commit convention:** [Conventional Commits](https://www.conventionalcommits.org/). The type prefix
drives the CHANGELOG section a change lands in:

| Prefix | CHANGELOG section |
| --- | --- |
| `feat:` | Added |
| `fix:` | Fixed |
| `perf:`, `refactor:` | Changed |
| `docs:`, `test:`, `chore:`, `ci:`, `build:` | (not listed unless user-visible) |
| `feat!:` / `BREAKING CHANGE:` | Changed, flagged, and forces a major bump |

`CHANGELOG.md` is maintained **by hand** under `## [Unreleased]`, updated in the same commit as any
user-visible change. We do not auto-generate it from commits: a changelog is written for users, and
commit subjects are written for whoever is reading the history. The release workflow only *extracts*
the relevant section.

---

## 2. Branch protection settings

Set in **Settings → Rules → Rulesets** (or Settings → Branches). These cannot be configured from
repository contents, so `docs/BRANCH_PROTECTION.md` (Phase 0) mirrors them for discoverability.

> **In force since 2026-08-15.** Branch protection is gated on a public repository or a paid plan,
> and for the whole build this one was private on Free: both the rulesets API and the classic
> branch-protection API answered `403 Upgrade to GitHub Pro or make this repository public`
> (measured 2026-08-14, Phase 13). Publishing the repository (PLAN.md D36) unblocked it, and the
> settings below are applied rather than merely correct. The audit that preceded the flip, and how
> to verify the rules took effect, are in
> [BRANCH_PROTECTION.md](BRANCH_PROTECTION.md#7-publication--what-was-audited-2026-08-15).

**Solo repository: no PR requirement, no approvals, no conversation resolution.** The only rules that
remain are the ones that prevent accidents — losing a branch, rewriting published history.

### `main`

| Setting | Value |
| --- | --- |
| Block force pushes | ✅ |
| Restrict deletions | ✅ |
| Require linear history | ✅ — with `--no-ff` release merges this stays true and keeps `git log --first-parent` readable |
| Require signed commits | Optional; worth it for a crypto tool if you already have signing set up |
| Require a pull request | ❌ |
| Require status checks | ❌ — see the note below |

### `dev`

| Setting | Value |
| --- | --- |
| Block force pushes | ✅ |
| Restrict deletions | ✅ |
| Everything else | ❌ |

### The tradeoff you are accepting

GitHub can only **require** a status check as a merge condition on a pull request. With no PR
requirement, **CI runs on every push but cannot block one.** A broken commit can land on `dev`.

That is a deliberate trade, and it is fine as long as the replacement gate is real:

- **`npm run verify` locally before every push.** This is the actual gate. It runs the same lint,
  type-check, test, build, and invariant scan that CI does.
- **CI is the backstop**, not the gate — it catches what your machine's state hid (a stale
  `node_modules`, an uncommitted file, a platform difference).
- **Fix forward on `dev`.** Never force-push to unbreak it; that is what the force-push block is for.
- **`main` is different.** It only ever receives a merge from a `dev` commit whose CI is green — that
  check is manual and it is the one you must not skip, because `main` is what gets tagged, built,
  and shipped to users.

If a collaborator ever joins, turn on "require a pull request" + required checks `verify` and `e2e`
for `main` at that moment. Nothing else about the model has to change.

### Repository settings

- **Private vulnerability reporting: ✅ enabled** (Settings → Code security). `SECURITY.md` points at
  it and issue templates route security reports there instead of to public issues.
- **Dependabot alerts + security updates: ✅**
- **Secret scanning + push protection: ✅** (matters: the Store secrets in §6 are exactly the kind of
  thing that gets pasted into a commit by accident)
- **CodeQL: ✅** (workflow added in Phase 1)
- **Actions permissions:** read-only `GITHUB_TOKEN` by default; the release workflow requests
  `contents: write` explicitly for creating the Release.

---

## 3. CI

`.github/workflows/ci.yml`. It runs on pushes to `dev`/`main` (your own work) **and** on pull
requests (outside contributions, once the repo is public).

```yaml
name: ci
on:
  push:         { branches: [dev, main] }
  pull_request: { branches: [dev, main] }
permissions: { contents: read }
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:                      # the gate for PRs; advisory (but watch it) for direct pushes
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc', cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run type-check
      - run: npm run test                     # runs with coverage; thresholds gate here
      - run: npm run build
      - run: npm run verify:invariants     # INV-1, 2, 3, 8, 9 against real dist/
      - run: node scripts/check-budgets.mjs --report release/bundle-report.md   # Phase 12
      - uses: actions/upload-artifact@v4
        with: { name: dist, path: dist/, retention-days: 7 }
      - uses: actions/upload-artifact@v4
        with: { name: coverage, path: coverage/, retention-days: 7 }

  e2e:
    runs-on: ubuntu-latest
    needs: verify
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc', cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run build
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: playwright-report/ }
```

**Coverage gates** (enforced by `vitest.config.ts`, not by a separate step):

| Path | Lines | Branches |
| --- | --- | --- |
| `src/crypto/**` | 90 % | 85 % |
| `src/vault/**` | 90 % | 85 % |
| `src/storage/**` | 90 % | 85 % |
| `src/sync/**` | 90 % | 85 % |
| global | 70 % | 60 % |

A commit that drops any threshold fails `verify` — locally as well as in CI, since `npm run verify`
runs the same command. Thresholds are ratcheted upward as modules land; never lowered without a
`chore:` commit saying why.

---

## 4. Cutting a release

1. **Confirm `dev` is green.** Run `npm run verify` **and** check that CI passed on the latest pushed
   `dev` commit. This is the one manual check that must not be skipped — with no required status
   checks (§2), nothing else stops a broken commit from reaching `main`.
2. **Bump the version** on `dev`: `npm version <major|minor|patch> --no-git-tag-version`, which
   updates `package.json` and `package-lock.json`. The manifest version is derived at build time
   (see [ARCHITECTURE §2](ARCHITECTURE.md#version-mapping-buildversionts)) — never edit it by hand.
3. **Finalize the CHANGELOG.** Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a fresh
   empty `## [Unreleased]`, update the link refs at the bottom.
4. **Commit and push `dev`:** `chore(release): v1.2.3`. Wait for CI to go green on it.
5. **Merge into `main`:**
   ```bash
   git checkout main && git pull
   git merge --no-ff dev -m "release: v1.2.3"
   git push origin main
   ```
   `--no-ff` keeps one identifiable release merge per version, so `git log --first-parent main`
   reads as a clean list of releases.
6. **Tag on `main`:**
   ```bash
   git tag -a v1.2.3 -m "VaultaMark v1.2.3"
   git push origin v1.2.3
   ```
   The annotated tag on `main` is what triggers the release workflow.
7. **Verify the GitHub Release** — the zip is attached, the checksum is printed, the notes match the
   CHANGELOG section.
8. **Publish to the Store** — a *separate, manual* `workflow_dispatch` run with `publish: true`
   (§7). The tag push alone never publishes.

**Semantic versioning for this project:**

| Change | Bump |
| --- | --- |
| A vault schema change that older versions cannot read | **major** |
| A new user-facing feature; a schema change older versions *can* still read | **minor** |
| Bug fixes, performance, copy changes | **patch** |
| A crypto parameter change (e.g. iteration count) | **minor** (with a migration) or **major** (without) |
| A new *required* permission | **major** — Chrome disables the extension pending re-consent, which is a breaking event for users |

---

## 5. Google Cloud & OAuth setup

Needed for Drive sync (Phase 10). Do this once, under the `zyndata` Google account.

### 5.1 Create the project

1. <https://console.cloud.google.com/> → **New Project** → name `vaultamark` → Create.
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.

### 5.2 Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen** → User type **External** → Create.
2. App name `VaultaMark`; user support email; developer contact email.
3. App domain: the GitHub Pages URL for `docs/PRIVACY.md`, plus the repo URL as the homepage.
4. **Scopes → Add or remove scopes** → add **only**
   `https://www.googleapis.com/auth/drive.file`. Do **not** add `drive` or `drive.readonly` —
   those are Restricted scopes and trigger the annual CASA Tier-2 security assessment
   (see [ARCHITECTURE §13.1](ARCHITECTURE.md#131-scope-choice)).
5. Add yourself under **Test users** while in Testing mode.
6. **Publish app** — move the consent screen from *Testing* to *In production*.

**There is no verification to submit, and that is not an oversight.** `drive.file` is
**non-sensitive** — the only Drive scope that is — and an app whose scopes are all non-sensitive is
exempt from OAuth app verification. No demo video, no review, no "Google hasn't verified this app"
interstitial. Do not add `drive` or `drive.readonly` to make something work; they are Restricted, and
that is the annual paid CASA Tier-2 assessment ([ARCHITECTURE §13.1](ARCHITECTURE.md#131-scope-choice)).

**Publishing is still required, for a different reason.** An app left in *Testing* is capped at 100
test users, and — the part that actually bites us — **refresh tokens issued to a Testing app expire
after 7 days**. That hits exactly one code path, and hits it invisibly: the PKCE fallback in
`src/sync/drive/auth.ts`, used by profiles not signed into Chrome, is the only route that holds a
refresh token (sealed under `k_items`). `chrome.identity.getAuthToken` profiles would be unaffected,
so the symptom is *some* users reporting that Drive disconnects every week. Publish before anyone but
you installs the build.

### 5.3 Create the extension OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type **Chrome Extension** (if unavailable in your console, use **Chrome App**).
3. **Item ID** = your extension ID. Get it from:
   - the Chrome Web Store item URL after the first manual upload, **or**
   - a stable unpacked ID during development (§5.4).
4. Put the client ID in **`.env.local`** as `VM_OAUTH_CLIENT_ID` (see §5.5) — not in
   `build/manifest.ts`, which reads it from there. There is **no client secret** for this client
   type; the client id is public and nothing sensitive ships in the package. It is kept out of the
   repository because it names one particular Google Cloud project, not because it is secret.

### 5.4 Stable extension ID for local development

An unpacked extension's ID is derived from the folder it was loaded from, so it changes when the
folder moves and differs on every machine — which breaks the OAuth client binding, because a client
is registered against one specific ID.

```bash
npm run dev-key
```

That is the whole step. It generates an RSA key pair, writes `VM_MANIFEST_KEY` into `.env.local`
leaving every other line alone, drops the private half in `dev-unpacked.pem`, and prints the
extension ID the key produces — so there is no need to load the extension and read the ID off
`chrome://extensions` before registering the OAuth client.

**Regenerating is destructive in a non-obvious way**, so an existing key is never replaced without
`--force`. A new key is a new ID, and the OAuth client registered against the old one silently stops
matching: Drive fails to authorise, and nothing anywhere says that an *ID* is the reason. If you do
use `--force`, update the client's Item ID (§5.3) to the ID it prints.

<details>
<summary>What this replaced, and why the old way also worked</summary>

Until 2026-08-10 this section prescribed `chrome.exe --pack-extension` to produce a key pair,
followed by `openssl rsa -pubout -outform DER | openssl base64 -A` to extract the public half. Both
steps exist only to obtain an RSA key and its SPKI DER encoding, which Node does natively — Chrome's
`key` field has always been exactly base64 SPKI DER, so the bytes are identical. The old route needed
Chrome and OpenSSL on `PATH`, produced a `.crx` that was immediately thrown away, and left a `.pem`
in the repository root under a name that reads like build output.

</details>

The key reaches the manifest's `"key"` field
for **development builds only** — `build/mv3-plugin.ts` passes it through when the Vite mode is
`development` and never for `npm run build`, because the Store assigns the real ID and shipping a
`key` that disagrees with it breaks the upload. That also means `npm run build` does **not** give you
a stable unpacked ID; use `npm run dev`, or `npx vite build --mode development` for a one-shot.

`dev-unpacked.pem` is a signing key. It never goes in the repository (`.gitignore` covers `*.pem`),
and loading unpacked does not need it at all — Chrome derives the ID from the public key in the
manifest. Keep it only if you might pack a `.crx` with the same ID. If you lose it, you get a new
development ID and update the OAuth client's Item ID — no user impact, since production IDs come from
the Store.

**The running extension shows all of this on screen.** A build with no `VM_OAUTH_CLIENT_ID` renders
the steps below, its own extension ID, and the scope string in **Settings → Sync → Google Drive**,
each with a Copy button. That panel and this section say the same thing on purpose; the panel knows
the ID of the build actually in front of you, which is the value people misread here.

### 5.5 `.env.local` — where both values live

Copy the template and fill in what you have:

```bash
cp .env.example .env.local
```

```dotenv
VM_OAUTH_CLIENT_ID=000000000000-xxxxxxxxxxxx.apps.googleusercontent.com
VM_MANIFEST_KEY=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...
```

Then rebuild. `dist/manifest.json` should carry an `oauth2` block with your client id, and — after a
`npm run dev` — a `key`.

**Both are optional.** With the file absent, `npm run build` produces a package that installs, runs
and syncs through Chrome sync exactly as it should; the `oauth2` block is omitted **entirely** rather
than emitted empty (Chrome treats a malformed one as a manifest error and refuses to load the
extension at all), `DriveAuth.configured` is `false`, and Settings → Sync says the build has no
Google project configured. That is the correct behaviour for a source build, and
`test/e2e/manager.spec.ts` asserts it.

**How it reaches the build, and the trap that is worth knowing.** `vite.config.ts` calls Vite's
`loadEnv(mode, process.cwd(), 'VM_')` and passes the result to the plugin as an option. That call is
load-bearing and was missing until after Phase 11: **Vite does not put `.env` files into
`process.env`** — it loads them into `import.meta.env`, and only the `VITE_`-prefixed keys at that.
The plugin read `process.env['VM_OAUTH_CLIENT_ID']` directly, so a correctly written `.env.local` was
read by nothing, the manifest came out with no `oauth2` block, and the settings screen truthfully
reported a build with no Google project. Nothing was broken; the wiring between the documented file
and the build had simply never existed. `loadEnv` reads the files **and** folds in matching variables
already exported in the shell, so CI can set them as environment variables instead, with a local file
winning on a laptop. The `VM_` prefix is the allowlist — it is what stops an unrelated environment
variable finding its way into a shipped artifact.

---

## 6. Chrome Web Store setup and the four secrets

### 6.1 Developer account and the first upload

1. Register at <https://chrome.google.com/webstore/devconsole> — **one-time $5 USD fee**.
2. Complete the publisher profile (a verified email and, for some regions, an address).
3. **Upload the first version manually.** The Chrome Web Store API can only *update* an existing
   item; it cannot create one. So `v1.0.0` goes up by hand through the dashboard, and every release
   after that can use the automation.
4. Note the **extension ID** from the dashboard URL — that is `EXTENSION_ID`.

### 6.2 Enable the Chrome Web Store API

In the same Google Cloud project as §5:
**APIs & Services → Library → "Chrome Web Store API" → Enable.**

### 6.3 Create a Web-application OAuth client for publishing

This is a **second, different** OAuth client from §5.3 — that one is for the extension's Drive access,
this one is for CI to talk to the Store API.

1. **Credentials → Create credentials → OAuth client ID → Web application.**
2. Name it `vaultamark-cws-publisher`.
3. **Authorized redirect URIs:** add `http://localhost:8818` (any local port; it just needs to match
   what you use in §6.4).
4. Save. You now have `CLIENT_ID` and `CLIENT_SECRET`.
5. Add your own Google account under **Test users** on the consent screen if the app is still in
   Testing mode, otherwise the token request will be refused.

### 6.4 Generate the refresh token

The Store API uses the scope `https://www.googleapis.com/auth/chromewebstore`.

**Step 1 — get an authorization code.** Open this URL in a browser (substitute your client id) and
approve:

```
https://accounts.google.com/o/oauth2/auth
  ?response_type=code
  &scope=https://www.googleapis.com/auth/chromewebstore
  &client_id=YOUR_CLIENT_ID
  &redirect_uri=http://localhost:8818
  &access_type=offline
  &prompt=consent
```

`access_type=offline` **and** `prompt=consent` are both required — without them Google returns no
refresh token. You will land on a dead `localhost:8818` page; the `code=` parameter in the address
bar is what you need.

**Step 2 — exchange it for a refresh token** (the code is single-use and expires in minutes):

```bash
curl -s https://oauth2.googleapis.com/token \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=THE_CODE_FROM_STEP_1" \
  -d "grant_type=authorization_code" \
  -d "redirect_uri=http://localhost:8818"
```

The response contains `refresh_token` — that is `REFRESH_TOKEN`. It does not expire unless revoked,
the account's password changes, or the app stays in Testing mode (in which case Google expires it
after 7 days — **publish the consent screen** to avoid a mysteriously breaking release pipeline).

### 6.5 Store the secrets

**Settings → Secrets and variables → Actions → New repository secret:**

| Secret | Source | Notes |
| --- | --- | --- |
| `CWS_EXTENSION_ID` | §6.1 step 4 | Not secret in practice, but kept here for symmetry |
| `CWS_CLIENT_ID` | §6.3 | |
| `CWS_CLIENT_SECRET` | §6.3 | |
| `CWS_REFRESH_TOKEN` | §6.4 | The one that actually matters — treat as a publishing credential |

Put them in a GitHub **Environment** named `chrome-web-store` with **required reviewers = the repo
owner**. The release workflow's publish job references that environment, which means a publish cannot
proceed without a human approving the deployment — a second gate on top of the `workflow_dispatch`
input.

**If `CWS_REFRESH_TOKEN` leaks**, an attacker can publish an update to your extension to every user.
Revoke it immediately at <https://myaccount.google.com/permissions>, then regenerate via §6.4.

---

## 7. The release workflow

[`.github/workflows/release.yml`](../.github/workflows/release.yml), built in Phase 13. This section
is the normative part — what must be true, and in what order — and the file is the mechanics. It is
deliberately no longer a copy of the YAML: §3 held a copy of `ci.yml` that was silently a step out of
date within one phase, and a spec that disagrees with the thing it specifies is worse than a pointer.

**Triggers.** A tag matching `v*.*.*` (or `v*.*.*-*`), or a `workflow_dispatch` taking `tag`,
`publish` and `auto_publish`. Concurrency is grouped per tag and **never** cancels in progress: a
half-finished Store upload is worse than a queued one.

**The `build` job, in order.** Each of the first three is placed where it is so that the cheap
refusals happen before the expensive work:

1. Check out the tag with full history — `fetch-depth: 0`, which also brings `origin/main`.
2. **The tag must be an ancestor of `main`.** A tag on `dev` would build green and ship code that
   never went through a release merge.
3. **`check-version-sync.mjs`** — the tag and `package.json` must agree.
4. **`release-notes.mjs`** — the CHANGELOG section must exist and be non-empty. Extracted *before*
   the build, because an unfinalized changelog is a mistake to catch before six minutes of tests
   rather than after the Release exists.
5. `npm run lint`, `type-check`, `test` (coverage thresholds gate here), `build`,
   `verify:invariants`, `check-budgets`.
6. **`check-version-sync.mjs --built`** — now the manifest leg too, which needs a `dist/` to read.
7. `npx playwright install --with-deps chromium`, then `npm run test:e2e`.
8. `npm run zip`, then `sha256sum *.zip > SHA256SUMS`.
9. `softprops/action-gh-release@v2` with the zip, the checksums and the extracted notes;
   `prerelease` when the tag carries a `-`.
10. The whole `release/` directory is kept as an artifact, which is what the `publish` job consumes.

**The `publish` job** runs only on a `workflow_dispatch` with `publish: true`, in the
`chrome-web-store` environment, and refuses a pre-release tag outright before touching anything.
`chrome-webstore-upload-cli@3` reads the four secrets from the environment and uploads a draft
unless `auto_publish` was also ticked.

<details>
<summary>Two shell details that are load-bearing, and were wrong in the Phase-0 sketch</summary>

The default shell for a `run` step is `bash -e` **without** `pipefail`. So
`node scripts/release-notes.mjs … | tee release/NOTES.md` reports *tee's* exit code, and a refused
extraction — the whole point of that script — would be swallowed and the release would be published
with an empty body. Both places that produced a file through a pipe now redirect and then `cat`.

`git merge-base --is-ancestor` says everything in its exit code and nothing in its output, so it is
wrapped in an `if` that prints what failed and why. A bare invocation fails the job with no line
saying which of the two conditions was not met.

</details>

**The three gates before anything reaches users:**

1. A tag push builds and creates a GitHub Release, but the `publish` job is skipped
   (`inputs.publish` is unset on a tag push).
2. Publishing requires a deliberate `workflow_dispatch` with `publish: true`.
3. The `chrome-web-store` environment requires a human to approve the deployment.

And `auto_publish` defaults to false, so even an approved publish uploads a **draft** that you submit
for review by hand from the dashboard. Turn it on only once you trust the pipeline.

**Pre-releases** (`v1.2.0-rc.1`) create a GitHub pre-release with the zip attached and are **never**
uploaded to the Store — see [ARCHITECTURE §2](ARCHITECTURE.md#version-mapping-buildversionts) for why.

**Reproducibility.** The workflow prints the zip's SHA-256 and attaches `SHA256SUMS`. A user who
builds the tagged source with the same Node version should get a functionally identical bundle;
byte-identity is not promised (the minifier and timestamps do not guarantee it), and the README says so
plainly rather than claiming a reproducible build we have not engineered.

---

## 8. Store listing checklist

Drafts live in `docs/STORE_LISTING.md` (Phase 0) and are finalized in Phase 13.

| Asset | Spec | Status |
| --- | --- | --- |
| Icon | 128×128 PNG, artwork at 96×96 with transparent padding | ✅ `docs/store/icon-128.png` |
| Screenshots | 1280×800, **1–5**: vault list with favicons, add flow, search/tags, sync settings, the no-recovery warning | ✅ `docs/store/screenshot-{1..5}-*.png` |
| Small promo tile | 440×280 PNG | ✅ `docs/store/promo-440x280.png` |
| Marquee promo tile | 1400×560 (optional, only for featuring) | Not produced; optional |
| Short description | ≤ 132 chars | ✅ 131, STORE_LISTING §2 |
| Detailed description | Leads with the five differentiators; states the no-recovery warning; explains the two sync tiers | ✅ STORE_LISTING §3 |
| Category | Productivity | — |
| Language | English | — |
| Privacy policy URL | a publicly reachable URL serving `docs/PRIVACY.md` | **Blocked on a decision — see below** |
| Single-purpose statement | "Store, organize, and open bookmarks from a password-encrypted vault that is kept separate from Chrome's own bookmarks." | ✅ STORE_LISTING §4 |
| Data-usage disclosures | **No data collected.** No data sold, no data used for anything beyond the single purpose, no data transferred except to the user's own Google Drive at their instruction. | ✅ STORE_LISTING §6 |

The images are regenerated by `scripts/gen-brand-assets.mjs` and
`scripts/capture-store-screenshots.mjs`; the submission-day order is
[STORE_LISTING §9](STORE_LISTING.md#9-submission-day-in-order).

**Permission justifications** (each field has a character limit; keep them one or two sentences):

| Permission | Justification |
| --- | --- |
| `storage` | Stores the encrypted vault and user settings locally and syncs the encrypted vault across the user's own Chrome profiles. |
| `activeTab` | Reads the title and URL of the current tab when the user explicitly saves it, and reads that page's Open Graph preview image at that moment. |
| `scripting` | Injects a single script into the current tab, only when the user saves it, to read the page's Open Graph preview metadata. |
| `contextMenus` | Adds a "Save to VaultaMark" right-click entry. |
| `alarms` | Locks the vault automatically after the user's configured idle timeout. |
| `favicon` | Displays each bookmark's site icon from Chrome's local favicon cache, so no icon request is sent to a third party. |
| `identity` *(optional)* | Only when the user enables Google Drive sync: obtains an OAuth token for the `drive.file` scope so the encrypted vault can be stored in their own Drive. |
| `https://www.googleapis.com/*` *(optional)* | Only when the user enables Google Drive sync: uploads and downloads the encrypted vault file. |
| `history` *(optional)* | Only when the user runs the history-cleanup tool, enables clearing on lock, or enables quick-close: removes history entries so vaulted URLs stop appearing in address-bar autocomplete. |
| `bookmarks` *(optional)* | Only when the user imports existing Chrome bookmarks into the vault, and optionally deletes the originals afterwards at their request. |
| `idle` *(optional)* | Only when the user enables locking on system idle. |

**The privacy-policy URL was the last release blocker, and it is settled:**

> <https://zyndata.github.io/vaulta-mark/PRIVACY>

The document itself has been finished and publishable since Phase 9 (`docs/PRIVACY.md`); what was
missing was somewhere to serve it, because the Store requires a **publicly reachable** URL and this
repository was private. Three ways out were on the table — publish the repository, pay for Pages on a
private one, or host the policy elsewhere. **Option 1 was taken on 2026-08-15**
([PLAN.md §2.5, D36](../PLAN.md#25-project--process)): Settings → Pages → Deploy from a branch →
`main` / `docs`, which costs nothing on a public repository and puts the policy in the same commit as
the code it describes.

Two properties of that choice are load-bearing:

- **It serves from `main`, not `dev`.** So the URL is only live once a release merge has landed, and
  it always shows the policy as of the last release rather than as of the latest commit — which is
  the version the Store was told about. A `dev`-branch blob URL would have been neither stable nor
  release-aligned.
- **The URL must stay stable across releases.** It is now a value in a published Store listing;
  moving it means editing the listing, and a listing pointing at a 404 is a policy violation. Do not
  rename `docs/PRIVACY.md`, and do not switch the Pages source without updating the listing in the
  same sitting.

Pages renders `docs/PRIVACY.md` through Jekyll, so both `/PRIVACY` and `/PRIVACY.html` resolve; the
extensionless form is the one in the listing. The rest of `docs/` is served alongside it, which is
harmless — it is all published in the repository anyway — and gives the architecture and threat-model
documents a readable URL for free.

**Remote code:** answer **"No, I am not using remote code."** Every byte of executable code is in the
package; [INV-1/INV-2](../PLAN.md#4-hard-invariants) are CI-enforced and the verification scripts are
in the repository, which is a useful thing to point at if a reviewer asks.

---

## 9. Hotfixes

For a critical bug in a released version when `dev` has moved on:

```bash
git checkout -b hotfix/1.2.4 v1.2.3          # branch from the tag, not from dev
# fix, test, bump patch version, update CHANGELOG
git checkout main
git merge --no-ff hotfix/1.2.4 -m "release: v1.2.4"   # the one case where main takes a non-dev merge
git push origin main
git tag -a v1.2.4 -m "VaultaMark v1.2.4" && git push origin v1.2.4
git branch -d hotfix/1.2.4

git checkout dev && git merge main            # back-merge so dev keeps the fix
```

Never cherry-pick a hotfix into `dev` without back-merging `main` — divergence between the two
branches is how a fix gets silently reverted by the next release.

---

## 10. Rollback

The Chrome Web Store has **no rollback**. Once a version is published, the only remedy is publishing a
higher version number. Therefore:

1. **Do not enable `auto_publish` until several releases have gone through cleanly.** A draft upload
   that you submit by hand is a real safety net.
2. If a bad build reaches users: fix on a `hotfix/` branch (§9), bump the patch version, and publish
   as fast as review allows. You cannot un-publish to existing users.
3. **You can un-publish the listing** (dashboard → "Unpublish"), which stops *new* installs but does
   not remove or downgrade existing ones.
4. For a data-loss-class bug, ship a version that **refuses to write** and shows a recovery message
   before it ships the actual fix — the priority is stopping the damage, not fixing it elegantly.
5. GitHub Releases can be deleted or marked as drafts, but assume anything published was downloaded.

**Pre-release rehearsal:** before the first real publish, run the release workflow on a
`v0.0.0-test` tag with `publish: false` to prove the build, zip, checksum, notes, and Release steps
all work. The publish path can only be proven once the Store item exists (§6.1).

---

*See also: [PLAN.md](../PLAN.md) · [ARCHITECTURE.md](ARCHITECTURE.md)*
