# Branch protection — settings a human must apply

Branch protection cannot be configured from repository contents. This file is the checklist a
maintainer clicks through once, on <https://github.com/zyndata/vaulta-mark>. It mirrors
[RELEASE §2](RELEASE.md#2-branch-protection-settings); if the two ever disagree, RELEASE.md is the
source and this file is the thing to fix.

Everything below takes about ten minutes and is done from the repository's **Settings** tab. You need
admin rights on the repository.

> ## §1–§4 are applied. They were not always applicable.
>
> **This section is history, kept because the reason matters.** While the repository was private on
> a Free plan, **branch protection was refused outright** — it is a paid *or* public-repository
> feature. Measured 2026-08-14, both routes answered identically:
>
> ```
> $ gh api repos/zyndata/vaulta-mark/rulesets
> 403  Upgrade to GitHub Pro or make this repository public to enable this feature.
> $ gh api repos/zyndata/vaulta-mark/branches/main/protection
> 403  Upgrade to GitHub Pro or make this repository public to enable this feature.
> ```
>
> The Settings tab did not offer them either — the API and the UI are the same feature gate. So for
> the whole build, from Phase 0 to 1.0.0, **the accident protection was a habit rather than a rule**:
> nothing stopped a force-push over `main`, nothing stopped deleting either branch. §1–§4 were kept
> in full anyway, so that the day the repository was published they would be a ten-minute checklist
> rather than something to reconstruct.
>
> **The repository was made public on 2026-08-15** ([PLAN.md §2.5, D36](../PLAN.md#25-project--process)),
> and that day arrived. §1–§4 below are applied, not aspirational; §6 is how to check that for
> yourself rather than taking this paragraph's word for it. The habit stays anyway — a rule that
> stops a force-push is not a reason to reach for one.
>
> Two things are worth carrying forward from the private years. **§5's code-security features were
> gated the same way and are *off by default* when they become available** — being eligible is not
> being enabled. And the earlier version of this note claimed §1–§4 "apply unchanged" while private;
> that was an assumption nobody had tested, and it was wrong. Neither the API nor the UI was
> consulted before it was written down. **Measure the setting; do not reason about the plan.**

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
| **Require linear history** | ❌ | **This was listed as ✅ from Phase 0 to 2026-08-15, and it was wrong.** The stated reason — that a `--no-ff` merge "stays linear in the first-parent sense" — describes `git log --first-parent`, not the setting. GitHub's *Require linear history* rejects any push introducing a commit with **more than one parent**, and a `--no-ff` release merge is exactly that. Turning it on would block [§4 step 5](RELEASE.md#4-cutting-a-release) — every future release — and the error would arrive on release day, on `main`, with the tag already written. It was never applied, because it was never applicable; the claim went untested for the whole build for the same reason §1–§4 did. |
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

**Not enabled, and the trigger for enabling it is a person, not a date: *Restrict creations* on
`v*`.** The ruleset above stops a tag being moved or deleted; it does not stop one being *created*.
For a solo repository that is no protection at all — the only account with push access is the one
the rule would restrict. It becomes the control that matters the day a second contributor gains
push access, because pushing a `v*` tag is what starts the release workflow, and that workflow is
the path to the Chrome Web Store. **When you add a collaborator, come back and tick *Restrict
creations* with a bypass for yourself**, in the same sitting as granting the access. It is recorded
here rather than left to be rediscovered, because the moment it becomes necessary is precisely the
moment nobody is thinking about tag rulesets.

## 5. Repository settings to turn on

**Settings → Code security** (some are under **Settings → General → Features**):

All of these are free on a public repository. Every one of them is **off by default** — becoming
eligible for a feature does not switch it on.

| Setting | State | Why |
| --- | --- | --- |
| **Private vulnerability reporting** | ✅ | This is the channel `SECURITY.md` and the issue templates point at, and it is **public-repositories-only** — for the whole private period those links went to a form that only accounts with repository access could reach, which `SECURITY.md` said out loud. Switching it on was the first thing done after publication. |
| **Dependabot alerts** | ✅ | |
| **Dependabot security updates** | ✅ | |
| **Dependabot version updates** | ✅ | Configured by [`.github/dependabot.yml`](../.github/dependabot.yml) — weekly npm, monthly actions. |
| **Secret scanning** | ✅ | Free on public repositories; on the private Free plan it needed Advanced Security. The Chrome Web Store credentials in [RELEASE §6](RELEASE.md#6-chrome-web-store-setup-and-the-four-secrets) are exactly the kind of thing that gets pasted into a commit by accident. |
| **Secret scanning push protection** | ✅ | Blocks the paste *before* it enters the history. That mattered more when publication was still ahead; now that the history is public, it is the difference between a close call and a rotation. |
| **CodeQL / code scanning** | ✅ | Free on public repositories, and the upload step that failed on every push while private now works — which is why [`codeql.yml`](../.github/workflows/codeql.yml) analyses each push and pull request again rather than only running weekly. |
| **Discussions** | ✅ | The issue-template config routes questions there. |
| **Wiki, Projects** | ❌ | Unused; documentation lives in the repository. |
| **Secret scanning — non-provider patterns** | ❌ **unavailable** | Generic private keys and connection strings, as opposed to recognised vendor tokens. Part of the paid **Secret Protection** product, and not available on this repository. Measured 2026-08-15, twice: `PATCH /repos/…` **accepts the field and returns it still `disabled`** — a silent no-op, not a `403` — and **Settings → Advanced Security** ends at *Push protection*, with no such control on the page. The API's silence is the trap: it reads as success. |
| **Secret scanning — validity checks** | ❌ **unavailable** | Whether a leaked token is still live, which is the first question after a leak. Same product, same silent no-op, absent from the same page. |

Those last two are the third instance of this file's own lesson, and the first where the API lied
rather than refused: a `403` is a fact, while a `200` that changes nothing is a claim. **Read the
setting back after writing it, and believe the readback over the response.** They are also the
reason `dev-unpacked.pem` no longer lives in the working tree at all
([RELEASE §5.4](RELEASE.md#54-stable-extension-id-for-local-development)): the scanner that would
have caught a PEM on its way into a commit is the one this plan does not include, so the file was
moved somewhere a commit cannot reach rather than trusted to a `.gitignore` line.

**Settings → Environments:**

| Environment | Protection | Why |
| --- | --- | --- |
| `github-pages` | GitHub-managed | Created by the Pages deployment; serves the privacy policy. |
| `chrome-web-store` | **Required reviewers = the owner** | The gate the release workflow's `publish` job waits on, and where the four `CWS_*` secrets live so they exist only for an approved run. See [RELEASE §6.5](RELEASE.md#65-store-the-secrets) — including *why it must be created before the first dispatch*: a workflow naming an environment that does not exist does not fail, it creates one **with no rules**, and the documented human gate silently never fires. |

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

Without pushing anything, this asks GitHub which rules it will actually evaluate for a ref — which is
a stronger answer than reading your own ruleset definitions back, since it resolves patterns, bypass
lists and enforcement mode the way a real push will:

```bash
gh api repos/zyndata/vaulta-mark/rules/branches/main
gh api repos/zyndata/vaulta-mark/rules/branches/dev
```

Both must list `deletion` and `non_fast_forward`. An empty array means nothing is protecting that
branch, whatever the Rulesets page appears to say.

## 7. Publication — what was audited, 2026-08-15

Publishing is one click and is **irreversible in practice**: the entire history, every branch, and
every tag become readable at once, and anything that was ever committed is assumed cloned. This
section was written in advance as a pre-flight checklist; it is kept as the record of what was
actually run, because "we checked" is not a finding and a future fork deserves the evidence.

The audit, over all 91 commits on every branch and tag:

| Check | Result |
| --- | --- |
| Secrets ever committed — `*.pem`, `.env*`, `client_secret_*.json`, `*.crx` | Only `.env.example`. A secret deleted in a later commit still sits in the history, so this was run over `--all`, not the working tree. |
| Credential material by content — the OAuth client id, `GOCSPX`, `BEGIN PRIVATE KEY`, refresh-token prefixes | `git log --all -S` finds nothing for any of them. |
| Assistant tooling ([PLAN.md §8.1](../PLAN.md#81-files-that-are-never-committed)) | `git log --all --oneline -- CLAUDE.md CLAUDE.local.md .claude .mcp.json` prints nothing. The rule held from the first commit. |
| Real vault data or personal URLs in fixtures | `test/fixtures/` uses `example.com`/`.net`/`.org` only. No `*.vmv` outside the synthetic fixture. |
| Local absolute paths | No `C:\Users\…` or `D:\Work\…` in the tree or in any commit. |
| Committer identity — it becomes public with every commit | All 91 commits are `zyndata <8853758+zyndata@users.noreply.github.com>`. GitHub's noreply address throughout; no personal email is exposed. |

Applied immediately after the flip, in this order:

1. **Private vulnerability reporting** (§5) — `SECURITY.md` and the issue chooser had been pointing
   at a form that could not exist until this was on.
2. **Secret scanning, push protection, CodeQL** — all newly available, all off by default. Their
   two sub-toggles are *not* available on this plan; §5 records how that was established, because
   the API reports success for both.
3. **The `push` and `pull_request` triggers in
   [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml)**, restored. They had been
   removed while private because the upload step failed on every single push, and a permanently red
   check is worse than no check. On a public repository the upload works, and analysing each change
   as it lands is the entire point — weekly alone lets a bad commit sit for six days.
4. **§1–§4's rulesets**, which had been unapplicable for the whole build — three of them, `main`,
   `dev` and `release-tags`, each with an **empty bypass list**, because a rule you can bypass does
   not stop your own accident. Applying them is also what caught the *Require linear history* error
   in §1: a setting nobody could turn on was a setting nobody had checked.
5. **Pages** — Settings → Pages → Deploy from a branch → `main` / `docs`, which is what finally
   answers the Store's privacy-policy URL ([RELEASE §8](RELEASE.md#8-store-listing-checklist)). It
   serves from `main`, so it is empty until a release merge lands there.
6. The "repository is private" notes in `README.md`, `SECURITY.md`, `CONTRIBUTING.md`,
   `docs/PRIVACY.md`, `docs/STORE_LISTING.md` and **D36** in `PLAN.md`, all rewritten — in the
   commit *before* the flip, so the repository was never publicly claiming to be private.

**The one real decision at this moment was §3's**, and it was taken deliberately: *require a pull
request* stays **off**. Outside PRs are now possible, but there is still exactly one maintainer, and
a PR gate with a self-approval is ceremony that catches nothing. Revisit it when a second person has
commit rights — not when the first outside PR arrives.
