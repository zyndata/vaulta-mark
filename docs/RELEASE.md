# VaultaMark — Release Runbook

Branching, CI/CD, tagging, and Chrome Web Store publishing. Implemented in
[Phase 13 of PLAN.md](../PLAN.md#phase-13--release-engineering--100); the PR gate is implemented in
Phase 1.

**Contents**

1. [Branching model](#1-branching-model)
2. [Branch protection settings](#2-branch-protection-settings)
3. [CI: the PR gate](#3-ci-the-pr-gate)
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
          │                        │                        │
dev     ──●──●──●──●──●──●──●──●───●──●──●──●──●──●──●──●───●──►   integration
             ↑     ↑     ↑            ↑     ↑     ↑
        feat/phase-5  feat/phase-6  fix/…  feat/…  docs/…          short-lived, squash-merged
```

| Branch | Rules |
| --- | --- |
| `main` | Release-only. Receives merges from `dev` at release time and nothing else (except hotfix branches, §9). Protected, linear history. Every commit on `main` is a released or releasable state. |
| `dev` | The integration branch. All feature work merges here via PR. Always green, always installable. |
| `feat/*`, `fix/*`, `docs/*`, `chore/*` | Short-lived, branched from `dev`, squash-merged back, deleted on merge. Phase branches are named `feat/phase-<N>-<slug>`. |

**Commit convention:** [Conventional Commits](https://www.conventionalcommits.org/). The type prefix
drives the CHANGELOG section a change lands in:

| Prefix | CHANGELOG section |
| --- | --- |
| `feat:` | Added |
| `fix:` | Fixed |
| `perf:`, `refactor:` | Changed |
| `docs:`, `test:`, `chore:`, `ci:`, `build:` | (not listed unless user-visible) |
| `feat!:` / `BREAKING CHANGE:` | Changed, flagged, and forces a major bump |

`CHANGELOG.md` is maintained **by hand** under `## [Unreleased]` in every PR (the PR template has a
checkbox). We do not auto-generate it from commits: a changelog is written for users, and commit
subjects are written for reviewers. The release workflow only *extracts* the relevant section.

---

## 2. Branch protection settings

These cannot be set from repository contents — a human clicks them in
**Settings → Branches → Add branch ruleset**. Also mirrored in `docs/BRANCH_PROTECTION.md`
(created in Phase 0) so the requirement is discoverable from the repo.

### `main`

| Setting | Value |
| --- | --- |
| Require a pull request before merging | ✅ |
| Required approvals | 1 (on a solo repo, enable **"Allow specified actors to bypass"** for the owner, or set 0 and rely on the status checks — document which you chose) |
| Dismiss stale approvals on new commits | ✅ |
| Require status checks to pass | ✅ — **`verify`** (the CI job name) and **`e2e`** |
| Require branches to be up to date before merging | ✅ |
| Require conversation resolution | ✅ |
| **Require linear history** | ✅ |
| Require signed commits | Optional but recommended for a security tool |
| Block force pushes | ✅ |
| Restrict deletions | ✅ |
| Allowed merge methods | **Merge commit** for `dev → main` release PRs (so the release PR is one identifiable merge), squash disabled |

### `dev`

| Setting | Value |
| --- | --- |
| Require a pull request before merging | ✅ |
| Required approvals | 0 (solo) / 1 (with collaborators) |
| Require status checks to pass | ✅ — `verify`, `e2e` |
| Allowed merge methods | **Squash only** |
| Automatically delete head branches | ✅ (repo-level setting) |
| Block force pushes | ✅ |

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

## 3. CI: the PR gate

`.github/workflows/ci.yml`, on `pull_request` → `dev`/`main` and `push` → `dev`.

```yaml
name: ci
on:
  pull_request: { branches: [dev, main] }
  push:         { branches: [dev] }
permissions: { contents: read }
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:                      # ← the required status check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc', cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run type-check
      - run: npm run test -- --coverage
      - run: npm run build
      - run: npm run verify:invariants     # INV-1, 2, 3, 8, 9 against real dist/
      - uses: actions/upload-artifact@v4
        with: { name: dist, path: dist/, retention-days: 7 }
      - uses: actions/upload-artifact@v4
        with: { name: coverage, path: coverage/, retention-days: 7 }

  e2e:                         # ← also a required status check
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

A PR that drops any threshold fails `verify`. Thresholds are ratcheted upward as modules land — they
are never lowered without a note in the PR description.

---

## 4. Cutting a release

1. **Freeze `dev`.** Confirm CI is green and no PR is mid-review.
2. **Bump the version.** On a branch off `dev`: `npm version <major|minor|patch> --no-git-tag-version`,
   which updates `package.json` and `package-lock.json`. The manifest version is derived at build
   time (see [ARCHITECTURE §2](ARCHITECTURE.md#version-mapping-buildversionts)) — never edit it by hand.
3. **Finalize the CHANGELOG.** Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a fresh
   empty `## [Unreleased]`, update the link refs at the bottom.
4. **PR the bump into `dev`**, merge.
5. **Open the release PR: `dev → main`.** Title `release: vX.Y.Z`. Merge with a **merge commit** (not
   squash) so `main`'s history shows one identifiable release merge per version.
6. **Tag on `main`:**
   ```bash
   git checkout main && git pull
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
6. When ready, **Publish app** and submit for verification. `drive.file` is *Sensitive*, not
   *Restricted*: verification needs the consent-screen details, a privacy-policy URL, and a demo
   video showing the OAuth flow and what the app does with the scope. Expect days-to-weeks.
   **Start this during Phase 10, not at release time.** Until verified, the unverified-app screen
   caps you at 100 users — fine for a beta.

### 5.3 Create the extension OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type **Chrome Extension** (if unavailable in your console, use **Chrome App**).
3. **Item ID** = your extension ID. Get it from:
   - the Chrome Web Store item URL after the first manual upload, **or**
   - a stable unpacked ID during development (§5.4).
4. Copy the client ID into `build/manifest.ts` under `oauth2.client_id`. There is **no client secret**
   for this client type — nothing sensitive ships in the package.

### 5.4 Stable extension ID for local development

Unpacked extensions get a new ID on each load, which breaks the OAuth client binding.

```bash
# One time: pack the extension to generate a key pair
chrome.exe --pack-extension="D:\Work\vaulta-mark\vaulta-mark\dist"
# produces dist.crx and dist.pem  → keep dist.pem OUT of git (.gitignore covers *.pem)

# Extract the public key as base64 (one line, no headers)
openssl rsa -in dist.pem -pubout -outform DER | openssl base64 -A
```

Put that string in the manifest's `"key"` field for development builds only. `build/manifest.ts`
reads it from a gitignored `.env.local` (`VM_MANIFEST_KEY=...`) and **omits it from production
builds** — the Store assigns the real ID, and shipping a `key` that disagrees with the Store's ID
breaks the upload.

The `.pem` is a signing key. It never goes in the repository. If you lose it, you get a new
development ID and update the OAuth client's Item ID — no user impact, since production IDs come from
the Store.

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

`.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    tags: ['v[0-9]+.[0-9]+.[0-9]+', 'v[0-9]+.[0-9]+.[0-9]+-*']
  workflow_dispatch:
    inputs:
      tag:          { description: 'Tag to publish (e.g. v1.2.3)', required: true }
      publish:      { description: 'Upload to the Chrome Web Store', type: boolean, default: false }
      auto_publish: { description: 'Also submit for review (otherwise upload as draft)',
                      type: boolean, default: false }

permissions: { contents: read }

jobs:
  build:
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
        with: { ref: '${{ inputs.tag || github.ref }}', fetch-depth: 0 }

      - name: Tag must be on main
        run: git merge-base --is-ancestor HEAD origin/main

      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc', cache: npm }
      - run: npm ci

      - name: Version must match the tag
        run: node scripts/check-version-sync.mjs "${{ inputs.tag || github.ref_name }}"

      - run: npm run lint
      - run: npm run type-check
      - run: npm run test -- --coverage
      - run: npm run build
      - run: npm run verify:invariants
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e

      - run: npm run zip                       # → release/vaulta-mark-<version>.zip
      - name: Checksums
        run: |
          cd release
          sha256sum *.zip | tee SHA256SUMS
      - name: Release notes
        run: node scripts/release-notes.mjs "${{ inputs.tag || github.ref_name }}" > release/NOTES.md

      - uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ inputs.tag || github.ref_name }}
          body_path: release/NOTES.md
          files: |
            release/*.zip
            release/SHA256SUMS
          draft: false
          prerelease: ${{ contains(inputs.tag || github.ref_name, '-') }}

      - uses: actions/upload-artifact@v4
        with: { name: package, path: release/ }

  publish:
    needs: build
    if: ${{ inputs.publish == true }}          # never runs on a bare tag push
    runs-on: ubuntu-latest
    environment: chrome-web-store              # ← requires a human approval
    steps:
      - uses: actions/download-artifact@v4
        with: { name: package, path: release/ }
      - run: npm install -g chrome-webstore-upload-cli@3
      - name: Upload to the Chrome Web Store
        env:
          EXTENSION_ID:  ${{ secrets.CWS_EXTENSION_ID }}
          CLIENT_ID:     ${{ secrets.CWS_CLIENT_ID }}
          CLIENT_SECRET: ${{ secrets.CWS_CLIENT_SECRET }}
          REFRESH_TOKEN: ${{ secrets.CWS_REFRESH_TOKEN }}
        run: |
          chrome-webstore-upload upload \
            --source release/vaulta-mark-*.zip \
            ${{ inputs.auto_publish && '--auto-publish' || '' }}
```

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
byte-identity is not promised (esbuild and timestamps do not guarantee it), and the README says so
plainly rather than claiming a reproducible build we have not engineered.

---

## 8. Store listing checklist

Drafts live in `docs/STORE_LISTING.md` (Phase 0) and are finalized in Phase 13.

| Asset | Spec | Status |
| --- | --- | --- |
| Icon | 128×128 PNG, no alpha padding issues | Phase 13 |
| Screenshots | 1280×800 or 640×400, **1–5**, showing: vault list with favicons, add flow, search/tags, sync settings, thumbnail preview | Phase 13 |
| Small promo tile | 440×280 PNG | Phase 13 |
| Marquee promo tile | 1400×560 (optional, only for featuring) | Optional |
| Short description | ≤ 132 chars | Phase 0 draft |
| Detailed description | Leads with the five differentiators; states the no-recovery warning; explains the two sync tiers | Phase 0 draft |
| Category | Productivity | — |
| Language | English | — |
| Privacy policy URL | GitHub Pages URL for `docs/PRIVACY.md` | Phase 9 |
| Single-purpose statement | "Store, organize, and open bookmarks from a password-encrypted vault that is kept separate from Chrome's own bookmarks." | Phase 0 draft |
| Data-usage disclosures | **No data collected.** No data sold, no data used for anything beyond the single purpose, no data transferred except to the user's own Google Drive at their instruction. | Phase 13 |

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
| `history` *(optional)* | Only when the user runs the history-cleanup tool: removes history entries for domains they have vaulted, so those URLs stop appearing in address-bar autocomplete. |
| `bookmarks` *(optional)* | Only when the user imports existing Chrome bookmarks into the vault, and optionally deletes the originals afterwards at their request. |
| `idle` *(optional)* | Only when the user enables locking on system idle. |

**Remote code:** answer **"No, I am not using remote code."** Every byte of executable code is in the
package; [INV-1/INV-2](../PLAN.md#4-hard-invariants) are CI-enforced and the verification scripts are
in the repository, which is a useful thing to point at if a reviewer asks.

---

## 9. Hotfixes

For a critical bug in a released version when `dev` has moved on:

```bash
git checkout -b hotfix/1.2.4 v1.2.3          # branch from the tag, not from dev
# fix, test, bump patch version, update CHANGELOG
git push origin hotfix/1.2.4
# PR hotfix/1.2.4 → main   (this is the one case where a non-dev branch may target main)
# after merge: tag v1.2.4 on main, run the release workflow
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
