# Branch protection — settings a human must apply

Branch protection cannot be configured from repository contents. This file is the checklist a
maintainer clicks through once, on <https://github.com/zyndata/vaulta-mark>. It mirrors
[RELEASE §2](RELEASE.md#2-branch-protection-settings); if the two ever disagree, RELEASE.md is the
source and this file is the thing to fix.

Everything below takes about ten minutes and is done from the repository's **Settings** tab. You need
admin rights on the repository.

> **The repository is private for now** ([PLAN.md §2.5, D36](../PLAN.md#25-project--process)). The
> branch, tag, and Actions rules in §1–§4 apply unchanged — they protect against accidents, and
> accidents do not care who can see the repository. Several of the **code-security** features in §5
> are gated on a public repository or a paid plan; each one is marked. Re-run §5 the day the
> repository is published, because features that were unavailable become available and are **off by
> default**.

---

## The shape of it, first

**This is a solo repository.** There is deliberately **no pull-request requirement and no approval
gate** — they would gate a reviewer who does not exist, and the ceremony costs more than it catches.

The rules that remain exist for one purpose: **preventing accidents that cannot be undone.** Losing a
branch, rewriting published history, force-pushing over work. Everything else is left off on purpose.

What replaces the PR gate:

- **`npm run verify` locally before every push.** This is the actual gate — same lint, type-check,
  test, build, and invariant scan CI runs.
- **CI as the backstop**, catching what your machine's state hid.
- **A `phase-N-done` tag** as the "finished and green" marker.

---

## 1. Ruleset for `main`

**Settings → Rules → Rulesets → New ruleset → New branch ruleset.**

| Field | Value |
| --- | --- |
| Ruleset name | `main` |
| Enforcement status | **Active** |
| Bypass list | *(empty — do not add yourself; the point is to stop your own accidents)* |
| Target branches | Add target → **Include by pattern** → `main` |

Rules to enable:

| Rule | State | Why |
| --- | --- | --- |
| **Restrict deletions** | ✅ | `main` is what gets tagged, built, and shipped. It should not be deletable. |
| **Block force pushes** | ✅ | Published history stays published. A release tag must keep pointing at real, reachable code. |
| **Require linear history** | ✅ | Release merges use `--no-ff` from `dev`, which stays linear in the first-parent sense and keeps `git log --first-parent main` readable as a release list. |
| **Require signed commits** | Optional | Worth it for a crypto tool *if you already have commit signing set up.* Turning it on without a working key just blocks you at an inconvenient moment. |
| **Require a pull request before merging** | ❌ | No second reviewer exists. Turn this on the day a collaborator joins. |
| **Require status checks to pass** | ❌ | Only enforceable on pull requests — see [§3](#3-the-tradeoff-you-are-accepting). |
| Everything else | ❌ | |

## 2. Ruleset for `dev`

**Settings → Rules → Rulesets → New ruleset → New branch ruleset.**

| Field | Value |
| --- | --- |
| Ruleset name | `dev` |
| Enforcement status | **Active** |
| Bypass list | *(empty)* |
| Target branches | Add target → **Include by pattern** → `dev` |

| Rule | State | Why |
| --- | --- | --- |
| **Restrict deletions** | ✅ | `dev` is the whole project's working history. |
| **Block force pushes** | ✅ | The important one. When `dev` breaks, **fix forward** — never rewrite it. |
| Everything else | ❌ | Direct commits are the workflow here, not an exception to it. |

Do **not** protect `feat/*`. Those branches are meant to be rewritten and deleted.

## 3. The tradeoff you are accepting

GitHub can only **require** a status check as a *merge condition on a pull request*. With no PR
requirement, **CI runs on every push but cannot block one.** A red commit can land on `dev`.

That is a deliberate trade, and it is fine only because the replacement gate is real:

1. **Run `npm run verify` before every push.** Not "usually". Every push.
2. **Watch the CI run afterwards.** It catches what your machine hid — a stale `node_modules`, a file
   you forgot to commit, a platform difference. Advisory, but not optional to read.
3. **Fix forward on `dev`.** Never force-push to unbreak it; that is what the force-push block is for.
4. **`main` is different.** It only ever receives a `--no-ff` merge from a `dev` commit whose CI is
   **green**. That check is manual and it is the one you must not skip — `main` is what gets tagged,
   built, and shipped to users.

**If a collaborator ever joins:** turn on *Require a pull request before merging* (1 approval) and
*Require status checks to pass* with the `verify` and `e2e` checks, **for `main` first**, then for
`dev` once the habit sticks. Nothing else about the model has to change.

## 4. Tag protection

**Settings → Rules → Rulesets → New ruleset → New tag ruleset.**

| Field | Value |
| --- | --- |
| Ruleset name | `release-tags` |
| Enforcement status | **Active** |
| Target tags | Include by pattern → `v*` and `phase-*-done` |
| **Restrict deletions** | ✅ |
| **Block force pushes** | ✅ |

Tags are the immutable record of what was built and what was released. A moved `v1.0.0` tag means the
published SHA-256 in the release notes no longer proves anything.

## 5. Repository settings to turn on

**Settings → Code security** (some are under **Settings → General → Features**):

| Setting | State | Available while private? | Why |
| --- | --- | --- | --- |
| **Private vulnerability reporting** | ✅ | ❌ **public repositories only** | This is the channel `SECURITY.md` and the issue templates point at. **Turn it on the moment the repository is made public** — until then that link works only for accounts with repository access, which `SECURITY.md` now states. |
| **Dependabot alerts** | ✅ | ✅ | |
| **Dependabot security updates** | ✅ | ✅ | |
| **Dependabot version updates** | ✅ | ✅ | Configured by [`.github/dependabot.yml`](../.github/dependabot.yml) — weekly npm, monthly actions. |
| **Secret scanning** | ✅ | ⚠️ check your plan | Free on public repositories; on a private repository it depends on the plan (Advanced Security). The Chrome Web Store credentials in [RELEASE §6](RELEASE.md#6-chrome-web-store-setup-and-the-four-secrets) are exactly the kind of thing that gets pasted into a commit by accident. |
| **Secret scanning push protection** | ✅ | ⚠️ check your plan | Blocks the paste *before* it enters the history — and history is what gets published later, in full. If this is unavailable, the mitigation is manual: never paste a credential into a file, and keep them in Actions secrets only. |
| **CodeQL / code scanning** | ✅ | ⚠️ check your plan | Free on public repositories; on a private repository it generally requires Advanced Security. The workflow arrives in Phase 1 — if code scanning cannot run, keep the workflow file and expect the run to fail or be skipped rather than deleting it. |
| **Discussions** | ✅ | ✅ (visible only to people with access) | The issue-template config routes questions there. |
| **Wiki, Projects** | ❌ | — | Unused; documentation lives in the repository. |

**Settings → Actions → General:**

| Setting | Value |
| --- | --- |
| Workflow permissions | **Read repository contents** (read-only `GITHUB_TOKEN`) |
| Allow GitHub Actions to create and approve pull requests | ❌ |

The release workflow requests `contents: write` explicitly in its own file, which is the correct
granularity — the default token stays read-only.

**Settings → General → Pull Requests:** allow merge commits (release merges are `--no-ff`), and
enable *Automatically delete head branches* so `feat/*` branches clean themselves up.

## 6. Verifying it took effect

From a clean clone, these must all fail:

```bash
git push --force origin dev          # blocked: force push
git push origin --delete dev         # blocked: deletion
git push --force origin main         # blocked: force push
git push --force origin v1.0.0       # blocked: tag ruleset (once a v* tag exists)
```

And this must still work, because direct commits on `dev` are the workflow:

```bash
git commit -m "docs: ..." && git push origin dev
```

If a force push succeeds, the ruleset is either **Disabled**, targeting the wrong pattern, or you are
in its bypass list. Check enforcement status first — a ruleset saved in **Evaluate** mode reports
what it *would* have done and blocks nothing.

## 7. If the repository is ever made public

Publishing is one click and is **irreversible in practice**: the entire history, every branch, and
every tag become readable at once, and anything that was ever committed is assumed cloned. Before
flipping it:

1. **Audit the whole history, not the working tree.** `git log --all --stat` and
   `git log -p -- '*.env*' '*.pem'`. A secret deleted in a later commit is still in the history.
2. **Confirm the assistant-tooling files never entered it** ([PLAN.md §8.1](../PLAN.md#81-files-that-are-never-committed)):
   `git log --all --oneline -- CLAUDE.md CLAUDE.local.md .claude .mcp.json` must print nothing.
3. **Check for real vault data or personal URLs** in fixtures and test files. Fixtures must be
   synthetic.
4. **Decide on the committer email** you have been using — it becomes public with every commit.

Then, immediately after publishing:

- Turn on **private vulnerability reporting** (§5) — `SECURITY.md` and the issue chooser both point
  at a form that does not exist until you do.
- Re-check **secret scanning**, **push protection**, and **CodeQL**; they may have become available,
  and they are off by default.
- Restore the `push` and `pull_request` triggers in
  [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml). They were removed while the
  repository was private because the upload step failed on every single push, and a permanently red
  check is worse than no check. On a public repository the upload works, and analysing each change
  as it lands is the entire point — weekly alone would let a bad commit sit for six days.
- Update the "repository is private" notes in `README.md`, `SECURITY.md`, `CONTRIBUTING.md`,
  `docs/PRIVACY.md`, `docs/STORE_LISTING.md`, and decision **D36** in `PLAN.md`.
- If PRs from outsiders are now possible, revisit §3: turning on *require a pull request* +
  required `verify` / `e2e` checks for `main` is the moment's one real decision.
