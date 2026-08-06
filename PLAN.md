# VaultaMark — Implementation Plan

> **Product:** VaultaMark — a privacy-first Chrome (MV3) extension that keeps bookmarks in an
> encrypted vault, entirely outside `chrome.bookmarks`, so vaulted URLs never surface in the
> omnibox. Unlocked with a master password, optionally synced through the user's **own Google
> Drive**, and always opened in an incognito window.
>
> **Repository:** <https://github.com/zyndata/vaulta-mark> · **Org:** zyndata · **Package:** `vaulta-mark`

**Status:** planning complete, implementation not started.
**This file is authoritative.** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) holds the deep technical
specs (crypto, vault format, sync/merge algorithm, threat model);
[docs/RELEASE.md](docs/RELEASE.md) holds the branching/CI/CD/Chrome-Web-Store runbook.

---

## 0. How to execute a phase in a fresh conversation

Each phase below is written to be executed by a *fresh* Claude conversation that has **no memory of
the planning session** — only this repository and the phase's own section.

**Paste this into the new conversation:**

```
Implement Phase <N> from PLAN.md.

Read, in this order:
  1. PLAN.md  — sections 1–8 (context), then the "Phase <N>" section in full
  2. docs/ARCHITECTURE.md — the sections that Phase <N> lists under "Specs to read"
  3. The existing repository state (previous phases are already merged into `dev`)

Rules:
  - Do only what Phase <N> scopes. Do not start later phases.
  - Work on `dev` with direct commits, one commit per logical unit. Never commit to `main`.
  - Write the tests named in the phase; all of them must pass before you call it done.
  - The phase is done only when every item in its "Definition of done" is true.
  - `npm run verify` (lint + type-check + test + build + invariant scan) must be green.
  - Update CHANGELOG.md under `## [Unreleased]`.
  - When done: push `dev`, confirm CI is green, then tag `phase-<N>-done` and push the tag.
```

**Rules that apply to every phase (the fresh conversation must honour these):**

| Rule | Detail |
| --- | --- |
| No remote code, ever | See [§4 Hard invariants](#4-hard-invariants). Every dependency is bundled by Vite. |
| No new runtime network calls | Only `https://www.googleapis.com/*` + Google OAuth, only when Drive sync is on. |
| No `chrome.bookmarks` for vault items | Only for *importing* native bookmarks (Phase 8), never for storage. |
| Strict TS | `strict: true`, `noUncheckedIndexedAccess: true`. No `any` without an inline justification comment. |
| Crypto changes are spec-first | If a phase changes crypto or the vault format, update `docs/ARCHITECTURE.md` **and** bump `SCHEMA_VERSION` with a migration. |
| Conventional Commits | `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, `ci:`. |
| Every phase ends green | `dev` is always installable, testable, and non-broken. |
| Dependency advisories | Run `npm audit` at the end of the phase. Patch and minor security bumps can be merged any time. **Never merge a Dependabot PR that bumps a major** — majors are batched into Phase 12 and several of them contradict a settled decision (§2.1 D2, D5, D6). See [R11](#risks). |

---

## 1. Goals & non-goals

### Goals

1. Bookmarks that **cannot leak through the omnibox**, because Chrome never learns they are bookmarks.
2. **Zero-knowledge at rest**: every title, URL, folder name, tag, note and thumbnail is encrypted
   with a key derived from a master password that is never stored or transmitted.
3. **Zero-config sync** out of the box (`chrome.storage.sync`), with an **optional upgrade to the
   user's own Google Drive** for bigger vaults and thumbnails.
4. **Incognito-only opening**, with a guided flow when the required permission is missing.
5. **Reviewable and publishable**: minimal permissions, all code in the package, MV3-clean.
6. **Auditable, and buildable as open source**: GPLv3, documented crypto, reproducible build,
   CI-enforced invariants. The repository is private for now and whether the source is published is a
   later decision (D36) — the code is written to survive publication regardless.

### Non-goals (explicitly out of scope for 1.0)

- Any first-party server, account system, telemetry, analytics, or crash reporting.
- Password recovery, key escrow, or account recovery of any kind.
- Firefox / Safari / Edge-specific ports (the code should not gratuitously block them, but no port is planned).
- Sharing vaults between users, multi-user vaults, or team features.
- Full-page archiving, screenshots, or read-later article extraction.
- Protecting against a compromised OS, a keylogger, or a malicious extension with debugger access
  (see [§7 Threat model](#7-threat-model-summary)).

---

## 2. Assumptions & Decisions

Every choice made on the user's behalf. Each is overridable — flag it before Phase 1 if you disagree.

### 2.1 Stack

| # | Decision | Reasoning |
| --- | --- | --- |
| D1 | **TypeScript 5.x, strict** | Non-negotiable for a crypto/sync codebase. |
| D2 | **Vite 5 + a small in-repo MV3 plugin**, *not* `@crxjs/vite-plugin` | `@crxjs/vite-plugin` v2 is still beta and has had maintenance gaps; a build tool going stale would block Store releases. Our needs are modest (multi-entry build, manifest emit, static asset copy, content-script IIFE bundle). We ship ~80 lines in `build/mv3-plugin.ts` that we own and can audit, plus a `scripts/dev-reload.mjs` watcher. **Deviation from the suggested stack — justified here.** |
| D3 | **Vanilla TS UI, no framework** | As requested. A tiny reactive helper (`src/ui/dom.ts`, ~150 LOC: `h()`, signal-ish store, list diffing) is written in-repo instead of pulling a runtime dependency. Keeps the popup under a 1-frame paint budget and keeps the reviewer's diff small. |
| D4 | **Zero runtime npm dependencies** in the shipped bundle (target) | Everything we need exists in the platform: WebCrypto, `CompressionStream`, `OffscreenCanvas`, `createImageBitmap`, `structuredClone`. Every added runtime dep is supply-chain risk in a security tool. Dev dependencies are unrestricted. Exception process: any proposed runtime dep needs a note in `docs/ARCHITECTURE.md` §Dependencies. |
| D5 | **Vitest** (unit/integration) + **Playwright** with a persistent-context Chromium extension harness (E2E) | As suggested. `@vitest/coverage-v8`, `fake-indexeddb` not needed; a hand-written `chrome.*` mock lives in `test/mocks/chrome.ts`. |
| D6 | **ESLint 9 flat config + Prettier + `tsc --noEmit`** | Standard. Plus custom ESLint rules banning `eval`, `new Function`, `chrome.bookmarks` outside the import module, and remote URLs. |
| D7 | **npm** (not pnpm/yarn) | Widest CI/action support, lockfile v3, no corepack friction for contributors. |
| D8 | **Node 24 LTS** in CI, `.nvmrc` pinned to `24` | Node 20 reached end-of-life in **April 2026** — no further security patches. Pinning a dead runtime in a security-focused project is indefensible, however convenient. Node 24 is Active LTS until October 2026 and supported through April 2028, and satisfies Vite 5. CI reads the version from `.nvmrc` (`node-version-file`), so bumping the runtime is a one-line change in one file. |

### 2.2 Crypto

| # | Decision | Reasoning |
| --- | --- | --- |
| D9 | **PBKDF2-HMAC-SHA256, 600,000 iterations**, not Argon2id | Argon2id would need a WASM library, and MV3 WASM requires relaxing CSP with `'wasm-unsafe-eval'` — a strictly worse posture and a worse Store review story, for a threat model where the attacker is not a well-funded offline cracker. 600k SHA-256 iterations is the OWASP 2023+ floor and runs in ~350–700 ms on target hardware. **Revisit post-1.0** (backlog B7) if a vetted, small, audited Argon2id build appears; the KDF is already versioned in the vault header so migration is a param change, not a format break. |
| D10 | **Two-level key hierarchy**: password → `KEK` (PBKDF2) → unwraps a random 256-bit `DEK` (AES-GCM) → per-purpose subkeys via HKDF-SHA256 | Password change re-wraps one 32-byte key instead of re-encrypting the whole vault. Thumbnail keys and the bucket-integrity HMAC key are HKDF-separated from the DEK so no key is used for two purposes. |
| D11 | **AES-256-GCM**, 96-bit random IV per encryption, 128-bit tag, versioned AAD | WebCrypto-native, authenticated. AAD binds ciphertext to `{schemaVersion, purpose, bucketId}` so a bucket cannot be replayed into another slot. |
| D12 | **No password verifier blob.** Wrong password = `DEK` unwrap fails the GCM tag check. | One less oracle, one less thing to store. |
| D13 | **Plaintext is gzip-compressed (`CompressionStream`) then padded to a 256-byte boundary before encryption** | Compression roughly triples the practical `storage.sync` capacity; padding blunts the "how many bookmarks / how long is that URL" size side-channel. |
| D14 | **Unlocked `DEK` lives in `chrome.storage.session`** (memory-only, cleared on browser exit, not on disk, not reachable from content scripts) with an `unlockedUntil` stamp | MV3 service workers are killed after ~30 s idle; holding the key only in SW memory would force a password prompt every few minutes. `storage.session` is the platform-sanctioned answer. Tradeoff documented in the threat model and surfaced in Settings ("Keep vault unlocked across background restarts"). Setting **"Require password after every browser restart"** is on by default and is free — `storage.session` clears anyway. |

### 2.3 Storage & sync

| # | Decision | Reasoning |
| --- | --- | --- |
| D15 | **Bucketed sync layout**: items are sharded into `B` buckets by `SHA-256(itemId) % B` (B starts at 16), each bucket independently compressed+encrypted and written to one or more `chrome.storage.sync` items | A single blob would mean every edit rewrites every chunk (random IV ⇒ all ciphertext changes), burning the 120-writes/minute quota. Bucketing means one edit rewrites one bucket. |
| D16 | **Documented ceiling: ~600 bookmarks comfortable, ~1,000 hard** on `chrome.storage.sync` | Derived in [ARCHITECTURE §5.3](docs/ARCHITECTURE.md#53-capacity-math). Warn at 70 % of quota, hard-block new adds at 95 % with a "connect Drive" CTA. |
| D17 | **`storage.local` is the working copy; `storage.sync` is the transport.** The app reads/writes `storage.local` and a debounced replicator pushes to the active provider | Keeps UI latency off the sync path and gives us a stable local snapshot for merges. |
| D18 | **3-way merge with a persisted merge base** (`vm.base`, encrypted, in `storage.local`) | True 3-way merge is impossible without a base. Per-item `updatedAt` + per-item `rev` + vault-level monotonic `rev` + `lastSyncedRev` makes resolution deterministic and provider-agnostic. |
| D19 | **Auto-merge rules**: disjoint field edits merge silently; `tags` merge as a set union with tombstoned removals; **same field diverged on both sides ⇒ conflict UI**, never a silent overwrite | Matches the requirement. Set-union tag merge is a deliberate, documented bias toward not losing data. |
| D20 | **Deletes are tombstones** (`deleted: true, deletedAt`), purged after 90 days | Without tombstones, a delete on device A is undone by a stale device B. |
| D21 | **Drive scope: `drive.file` only** | Full `drive`/`drive.readonly` are Restricted scopes requiring an annual CASA Tier-2 security assessment (real money, real calendar time) plus a much heavier OAuth verification. `drive.file` is a Sensitive-but-not-Restricted scope: verification is a form + a demo video, and the app can only touch files it created — which is also a genuinely better privacy story. Cost: we cannot adopt a vault file the user moved/recreated by hand outside our flow; recovery path is Import (Phase 8). |
| D22 | **Drive auth via `chrome.identity.getAuthToken`**, with `launchWebAuthFlow` as a documented fallback | `getAuthToken` is one call and needs no client secret in the package. It requires a Chrome profile signed into Google; profiles that are not get the `launchWebAuthFlow` path (PKCE, no secret). |
| D23 | **Drive freshness check is metadata-only**: `GET /files/{id}?fields=modifiedTime,version,md5Checksum,appProperties` with `appProperties.vmRev` as the authoritative revision | Costs ~1 KB and no decryption; full download only when `vmRev`/`md5Checksum` differs from local. |
| D24 | **Thumbnails are one Drive file per item** (`t_<itemId>.vmt`), not one archive | Lets a device fetch only the previews it is about to render, and makes deletes cheap. |

### 2.4 Permissions & privacy

| # | Decision | Reasoning |
| --- | --- | --- |
| D25 | **Required permissions: `storage`, `activeTab`, `scripting`, `contextMenus`, `alarms`, `favicon`.** No host permissions at install time. | `activeTab` is granted by *all four* of our entry points (toolbar click, context-menu click, keyboard command, popup action), so OG capture never needs `<all_urls>`. This is the single biggest Store-review win available to us. |
| D26 | **Optional permissions, requested in-context at first use:** `identity` + `https://www.googleapis.com/*` (Drive), `history` (history cleanup / quick-close), `bookmarks` (native import), `idle` (lock-on-idle) | Nobody should have to grant history access to use a bookmark manager. |
| D27 | **OG image bytes are fetched *by the content script*, in the page's own context, at add-time only** | The page's origin already served the user that image; no *new* party learns anything, and it uses the page's HTTP cache. This preserves the hard invariant that the *extension* makes no third-party requests. If the page's CSP/CORS blocks it, there is simply no thumbnail. An opt-in setting (**off by default**) allows an extension-origin fetch for users who prefer coverage over strictness. |
| D28 | **Favicons via `chrome-extension://<id>/_favicon/?pageUrl=…` + the `favicon` permission** | Local cache lookup, zero network. Documented caveat: a site never visited in this profile shows the generic globe. |
| D29 | **`"incognito": "spanning"`** | The service worker (and thus the unlocked session) is shared with incognito windows, which is what makes "open in incognito" work at all. `split` would need a second, separately-unlocked instance. |
| D30 | **No telemetry, no analytics, no error reporting, no update pings.** CI-enforced. | Non-negotiable for the product's premise. |

### 2.5 Project & process

| # | Decision | Reasoning |
| --- | --- | --- |
| D31 | **License: GPL-3.0-only** | (a) A security tool's users benefit from forks staying auditable; GPL prevents a closed, subtly-backdoored repackage of this exact code. (b) The prior art in this niche is largely GPLv3, so we can read it without contamination worry. (c) GPLv3 is fully compatible with Chrome Web Store distribution (the Store's Developer Agreement does not require sublicensing rights that GPLv3 withholds). **Cost:** no proprietary reuse of our modules, which is a non-goal anyway. **Override note:** if you want maximum adoption of the crypto/sync modules as a library, say so and I will switch to Apache-2.0 (which also grants an explicit patent licence). Default stands at GPL-3.0-only. |
| D32 | **Branching: all development on `dev`; `main` is release-only** | Solo repository, so **no PR requirement and no approval gates** — they add ceremony without adding a reviewer. Phases commit directly to `dev` and are marked complete with a `phase-N-done` tag, which gives clean revert/bisect points without PR overhead. `main` receives a `--no-ff` merge from `dev` only at a release; an annotated `vX.Y.Z` tag on `main` triggers the release workflow. Short-lived `feat/*` branches stay available for risky work (Phase 7 uses one) and PRs remain available for outside contributors once the repo is public. |
| D33 | **Coverage gates: 90 % lines / 85 % branches on `src/crypto/**`, `src/vault/**`, `src/sync/**`; 70 % lines global** | Pragmatic: near-total on the parts where a bug loses user data, moderate on UI glue. |
| D34 | **Store upload is gated behind `workflow_dispatch` input `publish: true`** | A tag push builds and creates a GitHub Release with the zip attached, but never publishes to the Store by itself. |
| D35 | **Versioning: SemVer**, `manifest.json` version generated from `package.json` at build time | Chrome versions must be `1.2.3` numeric-only; pre-release tags (`1.2.0-rc.1`) map to `1.2.0.1` via a documented rule in `build/version.ts`. |
| D36 | **Repository visibility: private for now.** Publishing the source is a separate decision, taken later. | Licensing and publishing are different things: GPL-3.0-only (D31) governs the terms under which the code is distributed *if and when* it is, and obliges nothing while the repository is private. Nothing in the build, the test suite, or the invariant scanners depends on the repository being public. **Consequences to respect while it stays private:** (a) several GitHub features the docs assume are public-repo or paid-plan features — private vulnerability reporting, CodeQL/code scanning, secret-scanning push protection, and GitHub Pages for the privacy-policy URL — so re-check each before relying on it (see [docs/BRANCH_PROTECTION.md](docs/BRANCH_PROTECTION.md) §5); (b) the Chrome Web Store listing must not link to a repository nobody can open; (c) §8.1 becomes **more** important, not less — history published later is published in full, so nothing that must never be public may enter it now. |

---

## 3. Architecture overview

Full detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Summary:

### 3.1 Components

| Component | Path | Responsibility |
| --- | --- | --- |
| Service worker | `src/background/` | Message hub, session/lock lifecycle, alarms, context menus, commands, incognito opener, sync scheduler. The **only** component that touches keys. |
| Popup UI | `src/popup/` | Unlock, quick-add active tab, recent/search list, open-in-incognito. |
| Manager page | `src/manager/` | Full vault UI: folders, search, tags, notes, bulk ops, settings, conflict resolution, import/export, onboarding. |
| Crypto | `src/crypto/` | KDF, key hierarchy, envelope encrypt/decrypt, HKDF subkeys, secure wipe helpers. No storage knowledge. |
| Vault model | `src/vault/` | Item schema, schema versioning + migrations, tree/index operations, search index. Pure, side-effect free. |
| Storage | `src/storage/` | `storage.local` working copy, bucketing, codec, quota accounting, `storage.session` key custody. |
| Sync | `src/sync/` | `SyncProvider` interface, `ChromeSyncProvider`, `DriveSyncProvider`, the merge engine, revision/lineage bookkeeping. |
| Thumbnails | `src/thumbs/` | OG/Twitter extraction (content script), URL validation, downscale/recompress, encrypt, heavy-tier store. |
| Favicon | `src/ui/favicon.ts` | `_favicon/` URL builder + fallback. |
| Incognito | `src/background/incognito.ts` | Access detection, guided prompt, `windows.create`. |
| History | `src/background/history.ts` | Vaulted-domain history cleanup, quick-close. |
| Onboarding | `src/manager/onboarding/` | The three non-obvious facts + provider choice. |

### 3.2 Data flow

```
                    ┌──────────────────────────────────────────────┐
   master password  │            SERVICE WORKER (MV3)              │
        │           │                                              │
        ▼           │  crypto/  ──PBKDF2(600k)──►  KEK             │
  ┌──────────┐      │                               │ unwrap       │
  │ Unlock UI│─────►│                               ▼              │
  └──────────┘      │                        DEK (256-bit) ────────┼──► chrome.storage.session
                    │                          │                   │      { dek, unlockedUntil }
                    │            ┌─────────────┼──────────────┐    │      (memory only, alarm-wiped)
                    │            │ HKDF        │              │    │
                    │            ▼             ▼              ▼    │
                    │        k_items       k_thumbs       k_hmac   │
                    └────────────┼─────────────┼──────────────┼────┘
                                 │             │              │
   ┌─────────────────────────────┼─────────────┼──────────────┘
   │                             │             │
   │   ══ LIGHT TIER ══          │             │   ══ HEAVY TIER ══
   │   items: url,title,tags,    │             │   thumbnails (WebP ≤40 KB)
   │   note,folder,timestamps    │             │
   │                             ▼             ▼
   │                    ┌────────────────┐   ┌──────────────────────┐
   │                    │ storage.local  │   │ storage.local        │
   │                    │  vm.buckets.*  │   │  vm.thumbs.<id>      │  ← cache
   │                    │  vm.base       │   └──────────┬───────────┘
   │                    └───────┬────────┘              │
   │                            │ debounced replicate   │ (Drive only)
   │                ┌───────────┴───────────┐           │
   │                ▼                       ▼           ▼
   │   ┌────────────────────┐   ┌───────────────────────────────────┐
   │   │ ChromeSyncProvider │   │ DriveSyncProvider (opt-in)        │
   │   │ chrome.storage.sync│   │ drive.file scope                  │
   │   │  vm.s.meta         │   │  /VaultaMark/vaultamark-vault.vmv │
   │   │  vm.s.b0.0 …       │   │  /VaultaMark/thumbs/t_<id>.vmt    │
   │   │  LIGHT TIER ONLY   │   │  LIGHT + HEAVY                    │
   │   └────────────────────┘   └───────────────────────────────────┘
   │            ▲                            ▲
   │            └──────── merge engine ──────┘   3-way: local ⊕ base ⊕ remote
   │                       (src/sync/merge.ts)   → auto-merge or Conflict UI
   │
   └──► Popup / Manager UI  ──► open item ──► chrome.windows.create({incognito:true})
                                          └─► favicon via _favicon/ (local, no network)
```

**Add-a-bookmark flow (with thumbnail):**

```
user gesture (toolbar + / ctx-menu / Ctrl+Shift+S / popup)
  └─► activeTab granted for this tab
      └─► scripting.executeScript → content script
            reads og:image | twitter:image, og:title, og:description
            fetch(imageUrl) IN PAGE CONTEXT  ← the only third-party byte transfer, and the
                                                page's own origin already served it
            └─► ArrayBuffer → SW
                  ├─ validate: https, ≤5 MB, content-type image/*, decodable
                  ├─ createImageBitmap → OffscreenCanvas → ≤320 px → WebP q0.75 → ≤40 KB
                  ├─ AES-GCM with k_thumbs
                  └─ heavy tier (storage.local + Drive).  No Drive ⇒ discarded, favicon only.
```

### 3.3 Vault format (summary)

Full spec: [ARCHITECTURE §3–§5](docs/ARCHITECTURE.md#3-vault-format).

```jsonc
// vm.meta — PLAINTEXT header (storage.local, and mirrored to the provider)
{
  "magic": "VAULTAMARK",
  "schemaVersion": 2,
  "kdf": { "alg": "PBKDF2-HMAC-SHA256", "iterations": 600000, "salt": "<b64 32B>" },
  "wrappedDek": { "iv": "<b64 12B>", "ct": "<b64 48B>" },   // AES-256-GCM(KEK, DEK)
  "vaultRev": 137,                       // monotonic, bumped on every committed change
  "bucketCount": 16,
  "buckets": [ { "i": 0, "rev": 132, "parts": 1, "tag": "<b64 8B truncated HMAC>" }, … ],
  "createdAt": 1750000000000,
  "updatedAt": 1750000000000
}
```

```jsonc
// bucket plaintext, before gzip+pad+AES-GCM
{ "items": [ {
    "id": "b1f2…",  "type": "bookmark", "parentId": "root",
    "title": "…", "url": "https://…", "note": "…", "tags": ["a","b"],
    "createdAt": 0, "updatedAt": 0, "openedAt": 0, "openCount": 0,
    "order": "a0m",                                   // fractional index
    "og": { "title": "…", "description": "…" },
    "thumb": { "sha256": "…", "w": 320, "h": 168, "bytes": 21044, "src": "og", "at": 0 },
    "rev": 132
  } ] }
```

Header is plaintext by necessity (we must know the KDF params to derive the key). It leaks
*existence and approximate size* of a vault, nothing about contents. Stated in the threat model.

---

## 4. Hard invariants

These are enforced by CI (`npm run verify:invariants`), not just by convention. Each has a test.

| ID | Invariant | Enforced by |
| --- | --- | --- |
| **INV-1** | No remote code. Built `dist/` contains no `<script src="http…">`, no remote `import()`, no `eval(`, no `new Function(`, no `data:`/`blob:` script URLs. | `scripts/verify-no-remote-code.mjs` (AST + text scan of every emitted file) |
| **INV-2** | Manifest CSP is exactly `script-src 'self'; object-src 'self'; frame-ancestors 'none'` and contains no `unsafe-eval`/`unsafe-inline`/`wasm-unsafe-eval`/remote origins. | `scripts/verify-manifest.mjs` |
| **INV-3** | The only absolute URLs in the bundle are on an explicit allowlist (`googleapis.com`, `accounts.google.com`, plus documentation links that are never fetched). | `scripts/verify-no-remote-code.mjs` (allowlist in `build/url-allowlist.json`) |
| **INV-4** | No network request originates from the extension except Drive/OAuth, and none at all when Drive is off. | Playwright E2E: route-intercept every request from the extension context; the "browse the vault" scenario must record **zero** requests. |
| **INV-5** | `chrome.bookmarks` is never used to store vault items. | ESLint `no-restricted-properties` outside `src/import/native-bookmarks.ts` + unit test asserting no writes. |
| **INV-6** | No plaintext vault content ever reaches `storage.local`, `storage.sync`, or Drive. | Integration test: run a full add/edit/sync cycle against the chrome mock, then assert that no stored value contains any known plaintext token. |
| **INV-7** | Locked state holds no plaintext: after `lock()`, `storage.session` is empty and no SW-module-scope variable holds the DEK or decrypted items. | Unit test on the session module + a heap-shape assertion helper. |
| **INV-8** | No telemetry/analytics. Zero references to analytics SDKs, `navigator.sendBeacon`, or non-allowlisted `fetch`. | Same scan as INV-1/INV-3. |
| **INV-9** | Required permission set never grows without an explicit changelog entry. | `scripts/verify-manifest.mjs` diffs against `build/permissions.lock.json`. |

---

## 5. Feature inventory — core vs. optional

| Feature | Tier | Phase |
| --- | --- | --- |
| Encrypted vault, master password, PBKDF2+AES-GCM | **Core** | 2 |
| Auto-lock (idle timeout, default 10 min) + manual lock shortcut | **Core** | 4 |
| Add active tab: popup button, toolbar `+`, context menu, keyboard shortcut | **Core** | 5 |
| Open in incognito + `isAllowedIncognitoAccess` detection & guided prompt + fallback | **Core** | 5 |
| Favicons via `_favicon/` | **Core** | 5 |
| Tags + notes on every bookmark | **Core** | 6 |
| Full-text search over title/URL/tags/note | **Core** | 6 |
| Nested folders, breadcrumbs, folder counts | **Core** | 6 |
| Sorting (added / alphabetical / recently opened) | **Core** | 6 |
| Bulk multi-select move & delete | **Core** | 6 |
| `ChromeSyncProvider` + quota guard + 3-way merge + conflict UI | **Core** | 7 |
| Encrypted export / import (`.vmv`) | **Core** | 8 |
| Import from Chrome native bookmarks + offer to delete natives | **Core** | 8 |
| Onboarding: incognito, no-recovery, sync-tier tradeoff | **Core** | 9 |
| Clear browsing history for vaulted domains (one click) | **Core** | 9 |
| Onboarding: URL-prediction reminder + deep link to `chrome://settings` | **Core** | 9 |
| `DriveSyncProvider` (opt-in), provider migration both ways | **Core** | 10 |
| OG-image thumbnails: capture, encrypt, eye-icon + hover, manual refresh, graceful absence | **Core** | 11 |
| Quick-close (close tab + wipe that domain's history) | Optional | 9 (behind a setting, off by default) |
| Auto-lock on browser blur | Optional | 9 (setting) |
| Panic-lock shortcut | **Core** | 4 (cheap; it's just `lock()` on a command) |
| Drag-and-drop reordering / re-parenting | Optional | 12 |
| QR code for a vaulted URL | Optional | Post-1.0 (B1) |
| Disguise mode (camouflaged icon/title) | Optional | Post-1.0 (B2) |
| Argon2id KDF option | Optional | Post-1.0 (B7) |

**Post-1.0 backlog** (tracked as GitHub issues at the end of Phase 13, not as phases):
B1 QR codes · B2 disguise/panic camouflage · B3 keyboard-driven command palette ·
B4 vault-in-vault (second hidden vault under a different password) · B5 duplicate detection &
dead-link check (explicit action only) · B6 per-folder auto-lock · B7 Argon2id ·
B8 Firefox port evaluation · B9 optional local-only WebDAV provider.

---

## 6. Sync, versioning & conflict model (summary)

Full algorithm and worked examples: [ARCHITECTURE §6](docs/ARCHITECTURE.md#6-sync-and-merge).

- Every item carries `updatedAt` (ms) and `rev` (the `vaultRev` at which it last changed).
- The vault carries `vaultRev`, incremented on every committed local change.
- `storage.local` holds `lastSyncedRev` and an encrypted **merge base** — the exact item set as of
  the last successful sync.
- On sync: fetch remote header. If `remote.vaultRev === lastSyncedRev` → push local (fast path).
  If local unchanged since base → pull (fast path). Otherwise **3-way merge**:
  - item present in one side only, absent from base → **add**
  - item deleted on one side, untouched on the other → **delete** (tombstone wins)
  - item changed on one side only → **take that side**
  - both changed, **disjoint fields** → merge field-wise
  - both changed, **same field, different values** → **conflict** → queue for the Conflict UI;
    nothing is discarded until the user chooses (both versions are retained in `vm.conflicts`)
  - `tags`: set union, minus tags tombstoned on either side
- The merged result gets `vaultRev = max(local, remote) + 1`, is written locally, pushed, and
  becomes the new base.
- **`SyncProvider` interface** (`src/sync/provider.ts`) — the merge engine and the app talk only to
  this; neither knows which backend is live:

```ts
export interface SyncProvider {
  readonly id: 'chrome' | 'drive';
  readonly capabilities: { heavyTier: boolean; maxLightBytes: number };
  init(): Promise<void>;
  /** Metadata-only freshness probe. Must not download the payload. */
  peek(): Promise<RemoteStamp | null>;          // { vaultRev, contentHash, modifiedAt }
  pullLight(): Promise<EncryptedVault | null>;
  pushLight(v: EncryptedVault, expect: RemoteStamp | null): Promise<RemoteStamp>; // CAS
  getThumb(itemId: string): Promise<Uint8Array | null>;   // heavyTier only
  putThumb(itemId: string, blob: Uint8Array): Promise<void>;
  deleteThumb(itemId: string): Promise<void>;
  usage(): Promise<{ usedBytes: number; quotaBytes: number }>;
  disconnect(): Promise<void>;
}
```

- **Migration** `chrome → drive`: push the current light tier to Drive, verify, mark Drive active,
  optionally clear the `storage.sync` copy, and start capturing thumbnails from the next add.
  **`drive → chrome`**: check the light tier fits the quota (block with a clear message if not),
  push, keep thumbnails in the local cache but stop syncing them, and warn that other devices will
  lose thumbnail access.

---

## 7. Threat model (summary)

Full version: [ARCHITECTURE §8](docs/ARCHITECTURE.md#8-threat-model).

**Protects against:** someone browsing your machine or your Chrome profile; omnibox/address-bar
autocomplete revealing vaulted URLs while you type; anyone reading `chrome.storage` on disk or in a
profile backup; Google or anyone with your Drive contents reading the vault; a stolen exported
backup file; other Chrome-profile sync consumers reading the synced blob.

**Does NOT protect against:** a compromised OS or user account while the vault is unlocked; a
keylogger; another extension with `debugger`/devtools access to our pages; a weak master password
(we show a strength meter and a hard floor of 10 chars, but cannot fix it); an attacker who already
has your unlocked machine; traffic analysis of Drive API calls (reveals *that* you sync, and the
approximate size/timing, not the contents); the fact that a vault *exists* on the device.

**Known accepted leaks (documented in the UI):** the plaintext vault header; ciphertext length
(mitigated by 256-byte padding); Drive file existence/name/timestamps; the sites you *visit* after
opening a bookmark (mitigated by incognito-only opening + history cleanup).

---

## 8. Repository layout (target, end of Phase 13)

```
vaulta-mark/
├─ .github/
│  ├─ workflows/ci.yml               # push gate: lint, type-check, test, build, invariants
│  ├─ workflows/release.yml          # tag-triggered: verify, zip, GitHub Release, gated CWS upload
│  ├─ workflows/codeql.yml
│  ├─ ISSUE_TEMPLATE/{bug_report.yml,feature_request.yml,security.md,config.yml}
│  ├─ PULL_REQUEST_TEMPLATE.md
│  └─ dependabot.yml
├─ build/                            # in-repo Vite MV3 plugin, manifest source, version mapping
├─ docs/{ARCHITECTURE.md,RELEASE.md,PRIVACY.md,STORE_LISTING.md,THREAT_MODEL.md}
├─ public/{icons/,_locales/en/messages.json}
├─ scripts/{verify-no-remote-code.mjs,verify-manifest.mjs,zip.mjs,dev-reload.mjs}
├─ src/
│  ├─ background/  crypto/  vault/  storage/  sync/  thumbs/  import/
│  ├─ popup/  manager/  ui/  shared/
│  └─ content/og-capture.ts
├─ test/{unit,integration,e2e,mocks,fixtures}
├─ CHANGELOG.md  CONTRIBUTING.md  LICENSE  README.md  SECURITY.md  CODE_OF_CONDUCT.md
├─ eslint.config.js  vite.config.ts  vitest.config.ts  playwright.config.ts
└─ package.json  tsconfig.json  .nvmrc
```

### 8.1 Files that are never committed

The repository is **private for now** and may be published later (D36). Git history is published in
full or not at all, so the rule is written for the moment of publication, not for today: anything
that must never be public must never enter the history in the first place. Assistant tooling is a
local development detail, not part of the product, and it stays out of the tree and out of the
history either way.

```gitignore
# assistant tooling — local only, never committed
CLAUDE.md
CLAUDE.local.md
.claude/
.mcp.json
```

**The rule is narrow and about *kind*, not authorship.** `PLAN.md`, `docs/**`, `README.md`,
`CHANGELOG.md`, `CONTRIBUTING.md`, and `SECURITY.md` are project deliverables and **are** committed,
regardless of how they were drafted. The distinction is *tooling configuration* vs. *project
documentation*.

Consequences every phase must respect:

- No committed file may link to `CLAUDE.md` or `.claude/` — contributors will not have them.
- Never `git add -A` or `git add .` without checking what was picked up.
- No assistant attribution or co-author trailers in commit messages in this repository.
- Alongside these: `node_modules/`, `dist/`, `release/`, `coverage/`, `playwright-report/`, `*.pem`
  (extension signing keys), `.env*` except `.env.example`, and any real vault fixture are also
  never committed.

---

# 9. The phased plan

Fourteen phases, 0 → 13. Each ends on a green `dev`, tagged `phase-N-done`. One focused conversation
per phase.

**Dependency graph:**

```
0 ─► 1 ─► 2 ─► 3 ─► 4 ─► 5 ─► 6 ─► 7 ─► 8 ─► 9 ─► 10 ─► 11 ─► 12 ─► 13
                          └────────────────► (9 needs only 5)
                                    7 ──────► 10 (merge engine reused)
                                   10 ──────► 11 (heavy tier needs Drive)
```

---

## Phase 0 — Repository foundation & governance

**Goal:** a public, well-governed, legally clear repository. No application code.

**Specs to read:** this file §2.5, §8; [docs/RELEASE.md](docs/RELEASE.md) §1–§2.

**In scope**
- `LICENSE` — GPL-3.0-only, full text, copyright line `Copyright (C) 2026 zyndata`.
- `README.md` — fill the outline in [§10](#10-readme-outline). Lead with the five differentiators.
- `CHANGELOG.md` — Keep a Changelog 1.1.0 format, `## [Unreleased]` section only.
- `CONTRIBUTING.md` — branching model (`dev` vs `main`), Conventional Commits, DCO-style sign-off
  statement, how to run the test suite, the "no runtime dependencies without a written case" rule,
  and an explicit "do not open PRs that touch `src/crypto/**` without a linked issue" note.
- `SECURITY.md` — supported versions, private reporting via GitHub Security Advisories (**not**
  public issues), 90-day coordinated disclosure, explicit **no-warranty** paragraph, and a plain
  statement that there is no password recovery and the maintainers cannot recover a vault.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- `.github/PULL_REQUEST_TEMPLATE.md` — checkboxes for: phase number, tests added, invariants
  unaffected/re-verified, permissions unchanged, CHANGELOG updated, docs updated.
- `.github/ISSUE_TEMPLATE/` — `bug_report.yml`, `feature_request.yml`, `config.yml` routing security
  reports to the advisory form.
- `.github/dependabot.yml` — weekly npm + monthly github-actions, grouped minor/patch.
- `.gitignore`, `.gitattributes` (`* text=auto eol=lf`), `.editorconfig`, `.nvmrc` (`24`).
  The `.gitignore` **must** include `node_modules/`, `dist/`, `release/`, `coverage/`,
  `playwright-report/`, `*.pem`, `.env*` (except `.env.example`), **and the assistant-tooling block
  below** — see [§8.1](#81-files-that-are-never-committed).
- `docs/` placeholders: this repo already ships `ARCHITECTURE.md` and `RELEASE.md`; add
  `PRIVACY.md` (privacy-policy stub, hostable via GitHub Pages) and `STORE_LISTING.md`
  (asset checklist: 128×128 icon, 1280×800 or 640×400 screenshots ×5, small promo tile 440×280,
  short description ≤132 chars, detailed description, category `Productivity`, single-purpose
  statement, per-permission justification strings — drafted, not final).
- `docs/BRANCH_PROTECTION.md` — the exact settings a human must click (see below), since branch
  protection cannot be set from the repo contents.

**Already present** (written during planning, do not recreate): `PLAN.md`, `docs/ARCHITECTURE.md`,
`docs/RELEASE.md`, `README.md` (stub). Phase 0 fills the README stub and adds everything else listed
above. There is also an untracked `CLAUDE.md` — gitignored per [§8.1](#81-files-that-are-never-committed),
never staged; update its "Current state" line at the end of every phase.

**Out of scope:** any `package.json`, any TS, any workflow YAML (Phase 1).

**Branch-protection settings to document (human action).** This is a solo repository, so there are
**no PR or approval requirements** — those gate a reviewer who does not exist. The rules that remain
exist only to prevent accidents. For `main`: block force pushes, restrict deletions, require linear
history. For `dev`: block force pushes, restrict deletions. Nothing else.

Record the real tradeoff in `docs/BRANCH_PROTECTION.md`: GitHub can only *require* status checks on a
pull request, so with no PR requirement **CI runs but does not block a push**. The gate is therefore
local — `npm run verify` before every push — and CI is the backstop that catches what the local run
missed. If a collaborator ever joins, turn PR requirements on for `main` at that point.

**Tests:** none (no code). CI does not exist yet.

**Definition of done**
- [ ] Every file above exists and is internally consistent (no dead relative links — verify by eye).
- [ ] `LICENSE` is the verbatim GPL-3.0 text; `package.json` will later declare `"license": "GPL-3.0-only"`.
- [ ] `README.md` states the product name, repo URL, and the five differentiators.
- [ ] `docs/BRANCH_PROTECTION.md` is actionable without further research.

**Git:** direct commits on `dev`. When every Definition-of-done item is true, tag `phase-0-done` and
push.

> **Already done — do not redo.** The repository is initialized, `main` and `dev` both exist and are
> pushed to `origin`, and the planning docs are committed. `main` is at the initial planning commit
> and **must not be touched again until the v1.0.0 release**. Phase 0 adds the governance and
> licensing files listed above, on `dev`, like every other phase.

---

## Phase 1 — Toolchain, MV3 skeleton, CI gate, invariant scanners

**Goal:** `npm run build` produces a loadable, empty-but-working MV3 extension; `npm run verify` is
green; CI runs on every push to `dev`.

**Depends on:** Phase 0.
**Specs to read:** §2.1, §4 (all invariants), [ARCHITECTURE §2](docs/ARCHITECTURE.md#2-build-system).

**In scope**
- `package.json` — scripts: `dev`, `build`, `zip`, `test`, `test:watch`, `test:e2e`, `lint`,
  `format`, `type-check`, `verify:invariants`, `verify` (= lint && type-check && test && build &&
  verify:invariants). Zero runtime `dependencies`.
- `tsconfig.json` — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `verbatimModuleSyntax`, `moduleResolution: "bundler"`, `types: ["chrome", "vitest/globals"]`.
- `vite.config.ts` + `build/mv3-plugin.ts` — multi-entry build (`background`, `popup`, `manager`,
  `content/og-capture` as a single-file IIFE), manifest emit from `build/manifest.ts`, asset copy,
  `esbuild` target `chrome116`, no code-splitting for the SW entry.
- `build/manifest.ts` — typed manifest source producing:
  - `manifest_version: 3`, name/description from `_locales`, version from `package.json`
  - `background: { service_worker: "background.js", type: "module" }`
  - `permissions: ["storage","activeTab","scripting","contextMenus","alarms","favicon"]`
  - `optional_permissions: ["identity","history","bookmarks","idle"]`
  - `optional_host_permissions: ["https://www.googleapis.com/*"]`
  - `content_security_policy.extension_pages: "script-src 'self'; object-src 'self'; frame-ancestors 'none'"`
  - `incognito: "spanning"`, `action`, `commands` (add / lock / open-manager), `options_page`
  - **no** `content_scripts` block (we inject via `scripting` + `activeTab` only)
- `build/permissions.lock.json` — the frozen permission set for INV-9.
- `build/url-allowlist.json` — `["https://www.googleapis.com/", "https://accounts.google.com/"]`.
- `scripts/verify-no-remote-code.mjs`, `scripts/verify-manifest.mjs`, `scripts/zip.mjs`.
- `eslint.config.js` — typescript-eslint strict-type-checked, plus custom `no-restricted-syntax`
  rules for `eval`, `new Function`, `Function(` , `chrome.bookmarks` (allowlist one path),
  `sendBeacon`, and literal `http(s)://` outside the allowlist file.
- `.prettierrc`, `vitest.config.ts` (coverage thresholds per D33, initially applied only to existing
  files — raise as modules land), `playwright.config.ts` (harness stub; no tests yet).
- `test/mocks/chrome.ts` — in-memory `chrome.storage.{local,sync,session}`, `runtime`, `alarms`,
  `windows`, `permissions`, `identity`, with quota + write-rate simulation for `sync`.
- Minimal runtime: a service worker that logs and responds to a `PING` message; a popup that renders
  "VaultaMark" and the build version; an empty manager page.
- `.github/workflows/ci.yml` — on `push` to `dev`/`main` **and** on `pull_request` (so outside
  contributions are still gated once the repo is public): Node from `.nvmrc`, `npm ci`, `npm run verify`,
  upload `dist/` and coverage as artifacts. Job name **`verify`**.
- `.github/workflows/codeql.yml` — JS/TS, on push to `dev` + PR + weekly.
- `docs/DEVELOPMENT.md` — load-unpacked instructions, dev watch loop, how to run each test tier.

**Out of scope:** crypto, storage, any vault behaviour.

**Tests**
- `test/unit/build/manifest.test.ts` — manifest shape: MV3, CSP exact string, permission set equals
  the lock file, no `content_scripts`, `incognito: "spanning"`.
- `test/unit/scripts/verify-no-remote-code.test.ts` — feed the scanner synthetic bundles containing
  `eval(`, a CDN `<script src>`, a remote `import()`, and a `blob:` worker; each must fail. A clean
  bundle must pass. Allowlisted googleapis URL must pass.
- `test/unit/mocks/chrome.test.ts` — the mock enforces `QUOTA_BYTES_PER_ITEM` and write-rate limits.
- Smoke: `npm run build` then run both verifiers against real `dist/`.

**Definition of done**
- [ ] `dist/` loads in `chrome://extensions` (Developer mode → Load unpacked) with no errors or warnings.
- [ ] `npm run verify` passes locally and in CI.
- [ ] `npm run zip` emits `release/vaulta-mark-<version>.zip` containing only build output.
- [ ] INV-1, INV-2, INV-3, INV-8, INV-9 are enforced by scripts and covered by tests.
- [ ] `dist/` contains zero absolute non-allowlisted URLs and zero runtime npm packages.
- [ ] CI is green on the pushed `dev` commit.

**Git:** direct commits on `dev`. When every Definition-of-done item is true, tag `phase-1-done` and
push. This is the phase that makes CI exist — confirm the `ci` workflow ran green on the pushed `dev`
commit before tagging.

---

## Phase 2 — Crypto core

**Goal:** a small, fully-tested, storage-agnostic crypto module. Nothing else may ever call WebCrypto.

**Depends on:** Phase 1.
**Specs to read:** [ARCHITECTURE §4 Cryptography](docs/ARCHITECTURE.md#4-cryptography) — implement it exactly.

**In scope** (`src/crypto/`)
- `kdf.ts` — `deriveKek(password: string, salt: Uint8Array, params: KdfParams): Promise<CryptoKey>`;
  PBKDF2-HMAC-SHA256, 600,000 iterations, 256-bit output, `["wrapKey","unwrapKey","encrypt","decrypt"]`.
  Params object is versioned and read from the vault header, never hard-coded at the call site.
- `keys.ts` — `generateDek()`, `wrapDek(kek, dek)`, `unwrapDek(kek, wrapped)` (a GCM tag failure
  throws `WrongPasswordError`, distinct from `CorruptVaultError`), and
  `subkey(dek, purpose: 'items'|'thumbs'|'hmac'): Promise<CryptoKey>` via HKDF-SHA256 with
  `info = "vaultamark/v2/" + purpose`.
- `envelope.ts` — `seal(key, plaintext: Uint8Array, aad: Aad): Promise<Uint8Array>` and
  `open(key, sealed, aad)`. Wire format: `[1B version][12B IV][ciphertext‖16B tag]`. AAD is the
  canonical JSON of `{ v, purpose, id }`.
- `codec.ts` — `gzip`/`gunzip` via `CompressionStream`/`DecompressionStream`; `pad`/`unpad` to a
  256-byte boundary with a 4-byte length prefix; base64url helpers.
- `hash.ts` — `sha256`, `hmacSha256` (used for bucket tags), constant-time `equalBytes`.
- `wipe.ts` — `zero(u8)`, plus a `Secret<T>` wrapper with an explicit `dispose()`; documented as
  best-effort (JS gives no guarantees — say so in the code and in SECURITY.md).
- `errors.ts` — `WrongPasswordError`, `CorruptVaultError`, `UnsupportedSchemaError`.
- `password.ts` — strength estimator (in-repo zxcvbn-lite-style heuristic: length, class variety,
  common-password list of ~2,000 entries bundled as a compressed asset, repeated/sequence
  detection). Hard minimum 10 characters; warn below "good".

**Out of scope:** anything that touches `chrome.storage`, the vault schema, or the UI.

**Tests** (`test/unit/crypto/`) — this module carries the 90 %/85 % gate.
- Known-answer tests: PBKDF2 vectors from RFC 6070 (SHA-1 variants for the algorithm sanity) plus
  pinned SHA-256 vectors committed in `test/fixtures/kdf-vectors.json`; HKDF vectors from RFC 5869;
  AES-GCM vectors from NIST CAVP (a trimmed set in `test/fixtures/gcm-vectors.json`).
- Round-trip property tests: random plaintexts 0–256 KiB survive `pad→gzip→seal→open→gunzip→unpad`.
- Tamper tests: flipping any single bit of a sealed blob (version byte, IV, ciphertext, tag) makes
  `open` throw; changing the AAD makes `open` throw.
- `unwrapDek` with a wrong password throws `WrongPasswordError` and never returns a key.
- Subkeys for different purposes are distinct and deterministic from the same DEK.
- Padding hides length: two plaintexts of 300 and 500 bytes seal to the same ciphertext length.
- Performance guard: `deriveKek` completes in < 3 s in CI (skipped when `process.env.CI_SLOW`).

**Definition of done**
- [ ] All KATs pass; coverage on `src/crypto/**` ≥ 90 % lines / 85 % branches.
- [ ] No module outside `src/crypto/` imports `crypto.subtle` (ESLint rule added and enforced).
- [ ] `docs/ARCHITECTURE.md` §4 matches the implementation byte-for-byte (wire format table updated
      if anything shifted).
- [ ] `npm run verify` green.

**Git:** direct commits on `dev`. When every Definition-of-done item is true, tag `phase-2-done` and push.

---

## Phase 3 — Vault model, schema versioning, local storage engine

**Goal:** a working encrypted vault on `storage.local` with a clean domain API. Still no UI.

**Depends on:** Phase 2.
**Specs to read:** [ARCHITECTURE §3 Vault format](docs/ARCHITECTURE.md#3-vault-format), [§5 Storage layout](docs/ARCHITECTURE.md#5-storage-layout).

**In scope**
- `src/vault/types.ts` — `VaultItem`, `Bookmark`, `Folder`, `Tombstone`, `VaultHeader`, `Bucket`,
  `SCHEMA_VERSION = 2`. (v2 from day one: v1 is reserved as "pre-tags/notes/thumbs" so the migration
  machinery is exercised by a real fixture rather than being dead code.)
- `src/vault/model.ts` — pure functions: `addItem`, `updateItem`, `deleteItem` (tombstone),
  `moveItem`, `listChildren`, `pathOf`, `countsByFolder`, `allTags`. No I/O.
- `src/vault/order.ts` — fractional indexing (`a0`, `a0V`, …) so reorders touch one item.
- `src/vault/migrate.ts` — `migrate(raw, from, to)` registry, `v1→v2` implemented, with a
  `test/fixtures/vault-v1.json` fixture. Unknown-higher schema → `UnsupportedSchemaError` with a
  user-facing "this vault was made by a newer VaultaMark" message.
- `src/vault/search.ts` — normalized token index over title, URL (host + path), tags, note;
  prefix + substring matching, tag filters (`tag:foo`), folder scoping. In-memory, rebuilt on unlock.
- `src/storage/buckets.ts` — `bucketOf(itemId, bucketCount)`, bucket assembly/disassembly,
  rebalance to a larger `bucketCount`.
- `src/storage/codec.ts` — bucket ⇄ sealed bytes (`pad → gzip → seal(k_items, aad{v,'bucket',i})`),
  bucket tag = `HMAC(k_hmac, plaintext)[0..8]`.
- `src/storage/local.ts` — the working copy: read/write `vm.meta`, `vm.buckets.<i>`, `vm.base`,
  `vm.settings` (non-sensitive, plaintext: theme, idle timeout, active provider id — never vault content).
- `src/storage/repo.ts` — `VaultRepository`: `create(password)`, `unlock(password)`, `lock()`,
  `getAll()`, `apply(mutations)` (bumps `vaultRev`, rewrites only affected buckets), `changePassword`,
  `destroy()`. Dirty-bucket tracking + a 300 ms write coalescer.
- `src/storage/quota.ts` — byte accounting and projected `storage.sync` fit (used by Phase 7).

**Out of scope:** `storage.sync`, `storage.session`, any provider, any UI.

**Tests** (`test/unit/vault/`, `test/unit/storage/`, `test/integration/vault-lifecycle.test.ts`)
- Create → add 500 items → lock → unlock → `getAll()` returns exactly what went in.
- Editing one item marks exactly one bucket dirty and writes exactly one bucket.
- Tombstones: deleted items are excluded from `getAll()` but survive round-trips; purge after 90 days.
- Migration: the v1 fixture loads, migrates, and re-serializes as v2 with tags/notes defaulted.
- Fractional ordering: 1,000 random reorders never collide and never require renumbering.
- Search: title/URL/tag/note hits, `tag:` filter, case/diacritic folding, no false negatives on
  substring queries.
- Rebalance 16 → 32 buckets preserves every item.
- **INV-6**: after a full lifecycle, no value in the mock `storage.local` contains any known
  plaintext token (assert over titles, URLs, tags, notes).

**Definition of done**
- [ ] Coverage on `src/vault/**` and `src/storage/**` ≥ 90 %/85 %.
- [ ] INV-6 test passes.
- [ ] A 500-item vault unlocks (excluding KDF time) in < 150 ms in the Node test env.
- [ ] `docs/ARCHITECTURE.md` §3/§5 match the code.

**Git:** direct commits on `dev`. When every Definition-of-done item is true, tag `phase-3-done` and push.

---

## Phase 4 — Service-worker lifecycle, session custody, lock/unlock

**Goal:** the extension can be created, unlocked, auto-locked, and panic-locked, with correct MV3
service-worker behaviour. First point at which a human can meaningfully click something.

**Depends on:** Phase 3.
**Specs to read:** [ARCHITECTURE §7 Service-worker lifecycle](docs/ARCHITECTURE.md#7-service-worker-lifecycle), §4.

**In scope**
- `src/background/index.ts` — SW entry: install/startup handlers, message router, alarm handlers.
  Top-level code must be cheap; all real work is lazy (SW cold-start budget: < 50 ms to first message
  handled).
- `src/shared/messages.ts` — a discriminated-union message contract with a typed
  `send<T>()`/`onMessage` pair. Every request/response type is declared here; no ad-hoc strings.
- `src/background/session.ts` — key custody:
  - `unlock(password)` → derive KEK → unwrap DEK → write `{ dek, unlockedUntil }` to
    `chrome.storage.session` → arm the `vm.autolock` alarm
  - on SW wake, rehydrate the DEK from `storage.session` if `unlockedUntil > now`, else lock
  - `lock()` → `chrome.storage.session.clear()`, zero in-memory buffers, clear alarms, broadcast
    `SESSION_LOCKED` so open UIs blank themselves immediately
  - `touch()` on every user action, re-arming the idle window
- `src/background/autolock.ts` — `chrome.alarms` at min(60 s, timeout) granularity; optional
  `chrome.idle` (optional permission) for true system idle; "lock on browser blur" wired to
  `chrome.windows.onFocusChanged === WINDOW_ID_NONE` behind a setting.
- `src/background/commands.ts` — keyboard commands: `add-current-tab` (Ctrl+Shift+S / ⌘+Shift+S),
  `panic-lock` (Ctrl+Shift+L), `open-manager` (Ctrl+Shift+B). Panic-lock also closes all extension
  UI pages/popups.
- `src/popup/` — real popup: **Create vault** (password + confirm + strength meter + a
  *typed confirmation* of the no-recovery warning), **Unlock**, **Locked/Unlocked** states,
  a lock button, and a link to the manager. Uses the `src/ui/dom.ts` helper.
- `src/ui/dom.ts`, `src/ui/styles.css` — the minimal UI kit + design tokens (light/dark via
  `prefers-color-scheme`).
- Settings surface (minimal, in the popup for now): idle timeout selector (1/5/**10**/30/60 min,
  Never), "lock on blur" toggle.

**Out of scope:** adding bookmarks, listing items, incognito, sync.

**Tests**
- `test/unit/background/session.test.ts` — unlock stores the DEK in the session mock; `lock()` leaves
  `storage.session` empty (**INV-7**); wrong password produces `WrongPasswordError` and leaves the
  session empty; expiry is enforced on rehydrate, not only by the alarm.
- Simulated SW termination: drop all module state, re-import, assert the session rehydrates and the
  vault is still readable; then advance the clock past `unlockedUntil` and assert it locks.
- Alarm re-arming on `touch()`; the alarm survives a simulated SW restart.
- `test/integration/lock-cycle.test.ts` — create → unlock → idle-expire → unlock again.
- Panic-lock clears the session and broadcasts within one tick.

**Definition of done**
- [ ] A human can install the unpacked build, create a vault, unlock it, watch it auto-lock, and
      panic-lock it with the shortcut.
- [ ] INV-7 passes.
- [ ] The no-recovery warning requires a typed confirmation (not just a checkbox) at vault creation.
- [ ] SW cold start to first handled message < 50 ms (measured in a test with a stubbed clock).

**Git:** direct commits on `dev`. When every Definition-of-done item is true, tag `phase-4-done` and push.

---

## Phase 5 — Popup MVP: add, list, open in incognito, favicons

**Goal:** the extension is genuinely useful end-to-end for one person on one device.

**Depends on:** Phase 4.
**Specs to read:** [ARCHITECTURE §9 Incognito](docs/ARCHITECTURE.md#9-incognito-opening), §10 Favicons.

**In scope**
- `src/background/add.ts` — `addActiveTab()`: read the active tab (title + URL under `activeTab`),
  normalize the URL, detect duplicates (same normalized URL → offer "already vaulted, open it?"),
  create the item, save. Rejects `chrome://`, `chrome-extension://`, `file://` (with a clear reason),
  and `about:` URLs.
- Four entry points, all gesture-based so `activeTab` is granted:
  toolbar action `+` (popup primary button), `chrome.contextMenus` on page/link/selection
  ("Add to VaultaMark" / "Add link to VaultaMark"), the `add-current-tab` command, and the popup.
- `src/background/incognito.ts` —
  - `chrome.extension.isAllowedIncognitoAccess()` checked at open time and cached per session
  - allowed → `chrome.windows.create({ incognito: true, url, focused: true })`; reuse an existing
    incognito window when the "reuse window" setting is on (default on)
  - **not allowed** → a guided modal in the manager page: what the setting does, why we need it,
    a copy-able `chrome://extensions/?id=<id>` deep link (Chrome forbids programmatic navigation to
    `chrome://` URLs — we copy to clipboard and instruct), a screenshot-style illustration, and a
    **Re-check** button
  - **fallback path** (explicit user choice, never silent): "Open in a normal window this once" with
    a one-line warning that the visit will enter history, plus a "and clear it from history
    afterwards" checkbox that queues a Phase-9 cleanup for that domain
- `src/ui/favicon.ts` — `faviconUrl(pageUrl, size)` → `chrome.runtime.getURL('/_favicon/?pageUrl=…&size=32')`;
  `onerror` → an inline SVG letter-avatar derived from the host (no network, no third party).
- Popup list UI: recent items (no row cap — favicons load lazily, so the list scrolls the whole
  vault instead of trimming it; `limit` stays in the protocol for Phase 6's virtualized list),
  instant filter box, per-row favicon + title + host,
  open (click / Enter), delete (with undo toast, 8 s), "Open manager" link.
- Empty, locked, error, and "no incognito access" states all designed, not left to chance.

**Out of scope:** folders, tags, notes editing, search over notes, sync, thumbnails.

**Tests**
- `test/unit/background/add.test.ts` — normalization (trailing slash, `#`-fragment retention policy,
  utm-stripping **on** by default with a setting), duplicate detection, scheme rejection.
- `test/unit/background/incognito.test.ts` — allowed → `windows.create` called with
  `{incognito:true}`; not allowed → no window created, `NEEDS_INCOGNITO_ACCESS` returned; reuse-window
  logic; explicit fallback creates a normal window **only** when the caller passes `force: true`.
- `test/unit/ui/favicon.test.ts` — the URL is extension-origin, never third-party (**INV-4**-adjacent).
- `test/integration/add-and-open.test.ts` — add active tab → appears in list → open → correct
  `windows.create` args.
- First Playwright E2E (`test/e2e/popup.spec.ts`): load the extension in a persistent context,
  create a vault, add a tab, see it listed. (Incognito windows are awkward in Playwright — assert the
  `windows.create` call via an injected spy rather than a real incognito window.)

**Definition of done**
- [ ] All four add entry points work in a real Chrome profile.
- [ ] With "Allow in Incognito" **off**, the guided prompt appears and nothing fails silently.
- [ ] With it **on**, bookmarks open in incognito.
- [ ] Favicons render, and the network tab shows **zero** requests while browsing the vault.
- [ ] E2E suite runs in CI (headless, `--headless=new`).

**Git:** direct commits on `dev`. When every Definition-of-done item is true, tag `phase-5-done` and push.

---

## Phase 6 — Manager page: folders, tags, notes, search, bulk ops, sorting

**Goal:** the full single-device bookmark manager. Feature-complete for the light tier.

**Depends on:** Phase 5.

**In scope**
- `src/manager/` — a full-tab page (`manager.html`), not a popup: sidebar (folder tree + tag cloud +
  saved filters), main list/grid, detail pane.
- Folders: create, rename, delete (with a "move children to parent" vs "delete recursively" choice),
  nested to any depth, breadcrumb navigation, per-folder counts (including descendants).
- Item editing: title, URL, note (multiline, ~4 KB soft cap with a counter), tags (chip input with
  autocomplete over existing tags, rename-tag-everywhere action).
- Search: the Phase-3 index wired to a debounced (120 ms) input; supports bare terms, `tag:x`,
  `folder:y`, `in:note`, `host:z`; results highlight matches; searches **only** the unlocked vault.
- Sorting: date added, date modified, alphabetical, recently opened, most opened. Persisted per view.
- Bulk operations: shift/ctrl multi-select, select-all-in-view, bulk move, bulk tag add/remove, bulk
  delete (single undo for the whole batch).
- Keyboard: `/` focus search, `j`/`k` navigate, `Enter` open, `e` edit, `Del` delete, `Esc` clear.
- Virtualized list (in-repo, ~120 LOC) so 5,000 items scroll at 60 fps.
- Settings page section (still local-only concerns): idle timeout, lock-on-blur, reuse-incognito-window,
  URL normalization options, theme, change master password, **destroy vault** (double confirmation +
  typed vault name).
- Accessibility pass: focus management, ARIA roles on the tree and list, visible focus rings,
  colour contrast ≥ 4.5:1, full keyboard operability.

**Out of scope:** sync, conflict UI, import/export, thumbnails, onboarding.

**Tests**
- Unit: folder tree operations (move into descendant must be rejected), counts including descendants,
  tag rename across items, bulk ops atomicity (all-or-nothing per batch), sort comparators.
- Search: a 2,000-item fixture; assert precision/recall on a table of ~30 query→expected-ids cases;
  query latency < 20 ms.
- `changePassword` re-wraps the DEK and leaves all ciphertext untouched (bucket tags unchanged).
- E2E: create folder → add item → tag it → search finds it → bulk-move → undo restores.
- A11y: `@axe-core/playwright` on the manager page, zero critical/serious violations.

**Definition of done**
- [ ] Every core light-tier feature in §5 marked Phase 6 works.
- [ ] 5,000-item fixture: initial render < 400 ms, scrolling stays at 60 fps.
- [ ] Zero critical/serious axe violations.
- [ ] Change-password does not rewrite buckets (asserted).

**Git:** direct commits on `dev`. When every Definition-of-done item is true, tag `phase-6-done` and push.

---

## Phase 7 — SyncProvider abstraction, ChromeSyncProvider, merge engine, conflict UI

**Goal:** the vault syncs across the user's Chrome devices with zero configuration, and divergence is
resolved without data loss. **This is the highest-risk phase — budget accordingly.**

**Depends on:** Phase 6.
**Specs to read:** [ARCHITECTURE §6 Sync and merge](docs/ARCHITECTURE.md#6-sync-and-merge) in full, plus §5.3 capacity math.

**In scope**
- `src/sync/provider.ts` — the `SyncProvider` interface exactly as in [§6](#6-sync-versioning--conflict-model-summary),
  plus `RemoteStamp`, `SyncResult`, and the error taxonomy (`QuotaExceeded`, `RateLimited`,
  `PreconditionFailed`, `Offline`, `AuthRequired`).
- `src/sync/chrome-provider.ts` — `ChromeSyncProvider`:
  - key layout `vm.s.meta`, `vm.s.b<i>.<part>`; parts sized to stay under 8,192 bytes **including**
    the key name and JSON quoting overhead (budget 7,600 chars of base64url)
  - writes only dirty buckets; a write-rate budget tracker (≤ 100 writes/min, ≤ 1,400/hour — under
    Chrome's 120/1,800) with an exponential-backoff queue
  - compare-and-swap on push: re-read `vm.s.meta` and fail with `PreconditionFailed` if `vaultRev`
    moved since `peek()`; the caller re-merges. (`storage.sync` has no real CAS — we do read-verify-write
    plus a short post-write verification read; documented as best-effort and backed by the merge
    engine, which is idempotent.)
  - `peek()` reads only `vm.s.meta`
  - quota: `getBytesInUse`, warn at 70 %, block new adds at 95 % with a "connect Drive" CTA
  - `capabilities = { heavyTier: false, maxLightBytes: 102_400 }`
- `src/sync/merge.ts` — the provider-agnostic 3-way merge engine (rules in §6). Deterministic:
  `merge(base, local, remote)` is a pure function returning `{ merged, conflicts }`.
- `src/sync/engine.ts` — the orchestrator: triggers (local change debounced 3 s; `storage.onChanged`
  from a remote device; `chrome.runtime.onStartup`; SW wake; manual "Sync now"), the state machine
  (`idle → peeking → pulling → merging → pushing → idle|conflict|error`), and a single-flight lock.
- `src/sync/base.ts` — merge-base persistence (`vm.base`, encrypted with `k_items`).
- Conflict UI (`src/manager/conflicts/`) — a dedicated view: per-item side-by-side diff (field-level),
  "keep mine" / "keep theirs" / "keep both (duplicate)" per conflict, plus batch actions. Conflicts
  block nothing else: the rest of the vault stays usable, with a persistent banner.
- Sync status UI: last-synced time, provider name, pending/queued state, quota bar, error surface with
  a plain-language explanation and a retry button.
- `docs/ARCHITECTURE.md` §6 filled in with the final algorithm and the worked examples.

**Out of scope:** Drive, thumbnails, provider migration UI (Phase 10 adds the second provider).

**Tests** — the deepest test set in the project.
- **Merge engine table tests** (≥ 30 cases): add/add same id, add/add different ids, edit/edit disjoint
  fields, edit/edit same field, edit/delete, delete/delete, move/rename, tag union with removals,
  folder deleted on one side with a child added on the other, tombstone vs resurrection.
- **Property tests**: `merge` is commutative in outcome (`merge(b,l,r)` and `merge(b,r,l)` differ only
  in conflict `side` labels), idempotent (`merge(m,m,m) === m`), and never loses an item that exists
  in `local` or `remote` and is not tombstoned.
- **Two-device simulation** (`test/integration/two-device-sync.test.ts`): two `VaultRepository`
  instances over one shared mock `storage.sync`; scripted interleavings including offline periods,
  simultaneous edits, and a mid-push crash. Assert convergence: both devices reach byte-identical
  bucket sets after a final sync.
- **Fuzz**: 200 randomized operation interleavings; assert convergence and no data loss.
- Quota: filling to 95 % triggers the block; exceeding a per-item cap splits into parts correctly;
  write-rate limiter never exceeds the budget under a burst of 500 rapid edits.
- Crash safety: kill the process between "push buckets" and "push meta" → next sync detects the
  inconsistency via bucket tags and recovers without loss.

**Definition of done**
- [ ] Two real Chrome profiles signed into the same Google account converge (manual verification
      written up in the commit message — there is no PR to record it in).
- [ ] Every merge table case and both property tests pass; fuzz run of 200 iterations is clean.
- [ ] Coverage on `src/sync/**` ≥ 90 %/85 %.
- [ ] The write-rate limiter is proven not to exceed Chrome's quotas under burst.
- [ ] The documented bookmark ceiling in README/ARCHITECTURE matches a measured fixture.

**Git:** this is the one phase worth isolating on a branch — `feat/phase-7-sync-chrome` off `dev`,
merged back with `--no-ff` — because it is the highest-risk work in the project and a clean revert
point is worth the ceremony. Commit `7a` (merge engine + tests) and `7b` (provider + engine + UI)
separately. Tag `phase-7-done` on `dev` after the merge.

---

## Phase 8 — Export, import, and native-bookmark import

**Goal:** the user can get data out and in — including off Chrome entirely. Also the disaster-recovery
story for a corrupted vault.

**Depends on:** Phase 7.

**In scope**
- `src/io/export-encrypted.ts` — `.vmv` file format (spec in
  [ARCHITECTURE §11](docs/ARCHITECTURE.md#11-portable-file-format)): a self-describing container with
  its own KDF header (the export password may differ from the vault password — default is "use my
  vault password", with an explicit "use a different password" option), the full light tier, and
  optionally the heavy tier. Downloaded via an object URL + `<a download>` (no `downloads` permission).
- `src/io/import-encrypted.ts` — password prompt, decrypt, validate, migrate schema if older, then a
  **preview** step (N bookmarks, M folders, date range) and a mode choice: **Merge** (uses the Phase-7
  merge engine with an empty base → adds and conflicts, never destroys) or **Replace** (double
  confirmation, keeps a one-shot local rollback snapshot for 24 h).
- `src/import/native-bookmarks.ts` — requests the optional `bookmarks` permission in context; renders
  the native tree with checkboxes; imports the selection into the vault preserving folder structure;
  then **offers** (never automatically) to delete the native copies, explaining that deleting them is
  precisely what removes those URLs from the omnibox. Deletion is a separate, explicit second step
  with its own confirmation and a summary of exactly what will be removed.
- Import/export progress UI for large vaults; all work chunked so the UI never blocks > 50 ms.

**Out of scope:** Drive.

**Tests**
- `.vmv` round-trip: export → import into a fresh vault → deep-equal item sets (modulo `rev`).
- Wrong export password → `WrongPasswordError`, no partial state written.
- Truncated/tampered `.vmv` → `CorruptVaultError`, vault untouched.
- Cross-schema: a v1-era `.vmv` fixture imports and migrates.
- Merge-mode import reuses the Phase-7 engine and produces conflicts, not overwrites.
- Native import: mocked `chrome.bookmarks` tree → correct vault structure; deletion step is a
  separate call that does nothing unless explicitly invoked (**INV-5**: `chrome.bookmarks` is only
  ever read here, plus the explicit delete).

**Definition of done**
- [ ] Export → wipe → import restores a vault bit-for-bit (contents, not ciphertext).
- [ ] A replace-mode import cannot be applied without the typed confirmation.
- [ ] Native import + optional native deletion verified manually against a real profile; the manual
      check is written up in the commit message.

**Git:** direct commits on `dev`. When every Definition-of-done item is true, tag `phase-8-done` and push.

---

## Phase 9 — Onboarding, settings, history hygiene

**Goal:** the two high-consequence facts are impossible to miss, and the omnibox-via-history leak is
closed.

**Depends on:** Phase 5 (functionally) / Phase 8 (ordering).

**In scope**
- `src/manager/onboarding/` — a 5-step first-run flow on `manager.html?onboarding=1`, opened on
  `chrome.runtime.onInstalled` (reason `install`):
  1. **What VaultaMark is** — one screen, the omnibox premise.
  2. **Create your master password** — strength meter, and a **typed** acknowledgement of
     "there is no recovery; if I lose this password my bookmarks are gone forever."
  3. **Allow in Incognito** — why it is needed, the copy-able `chrome://extensions/?id=<id>` link,
     a live status indicator with a Re-check button, and a "skip for now" that leaves a persistent
     nudge in the manager.
  4. **Choose your sync tier** — Chrome sync (default; zero config; ~600 bookmarks; **no
     thumbnails**) vs Google Drive (opt-in later; large vaults; **thumbnails**). Explicit tradeoff
     table. Drive is offered but deferred to Phase 10 in the code — until then the card is present
     and marked "coming in the next release" (**or**, if Phase 10 has landed, fully wired).
  5. **Two things Chrome still does** — (a) typed URLs live in history and can autocomplete even when
     nothing is bookmarked → offer the history-cleanup tool; (b) Chrome's URL-prediction/preload
     service can suggest URLs from its own signals → explain, and provide a copy-able
     `chrome://settings/?search=autocomplete` link with instructions to turn off
     "Autocomplete searches and URLs".
  Re-runnable any time from Settings → "Replay onboarding".
- `src/background/history.ts` —
  - **Clear history for vaulted domains**: requests the optional `history` permission in context,
    computes the distinct registrable domains in the vault (locally, from the decrypted set — never
    transmitted), and calls `chrome.history.deleteUrl`/`search`-and-delete per domain. Shows a
    dry-run count first ("this will remove 143 history entries across 27 domains"), then executes.
    Never touches non-vaulted domains.
  - **Quick-close** (optional, **off** by default, own shortcut Ctrl+Shift+X): close the active tab
    and delete that domain's history entries in one keystroke. Requires `history`. A settings note
    explains that this deletes real history, not just vault-related entries.
  - A scheduled option: "clean vaulted domains from history on every lock" (off by default).
- Settings page completion: sync section (provider, status, quota), privacy section (history tools,
  URL-prediction reminder with the deep link), security section (idle timeout, lock on blur, require
  password after restart, change password, destroy vault), about section (version, license, links to
  SECURITY.md and PRIVACY.md).
  - **Amended during Phase 9, twice.** "Require password after restart" is *not* a setting and cannot
    be one: the unlocked key lives in `chrome.storage.session`, which is memory-backed and emptied
    when Chrome exits (D14), so the vault locks on restart whatever anyone ticks. A toggle that could
    only ever be on is a lie about how much control the user has, so the security section states the
    fact instead. And the About section carries **no links**: INV-3 forbids any absolute URL in the
    shipped package that is not on `build/url-allowlist.json`, and widening an invariant that exists
    to keep exfiltration paths out of the build in order to make an About box clickable is the wrong
    trade. The substance travels instead of the link — the policy in four sentences, the security
    posture in three, and the repository named rather than addressed.
  - **Amended again after Phase 9** (maintainer-reported): the URL-prediction reminder is on
    onboarding step 5 only, and no longer duplicated in the privacy section. It is a one-time
    instruction to change something in Chrome, not a control this extension owns — a permanent copy
    of it among the toggles is a section that can never be finished. *Settings → About → Show the
    setup guide again* is the way back to it. See ARCHITECTURE §12.4.
- `docs/PRIVACY.md` finalized (what we store, where, what we never send, the Drive exception, no
  telemetry) — this is the URL that goes in the Store listing.

**Out of scope:** Drive, thumbnails.

**Tests**
- Onboarding state machine: steps advance/rewind, the no-recovery step cannot be passed without the
  exact typed string, incognito status re-checks live, and completion is persisted so it does not
  re-run.
- History: domain extraction handles eTLD+1 correctly — the decision is already made in
  [ARCHITECTURE §12.1](docs/ARCHITECTURE.md#121-registrable-domain-extraction) (bundle the Public
  Suffix List, generated by a committed script, never fetched at runtime); test `co.uk`, `com.au`,
  `github.io`, and plain `.com`. Dry-run count matches the executed deletions; non-vaulted domains
  are never passed to `history.deleteUrl` (assert the exact call list).
  - **§12.1 amended during Phase 9**: it said "ICANN section only", and `github.io` — named right
    here — is a PRIVATE-section rule. Both sections are bundled; the reasoning is in §12.1.
- Optional permission flow: denial is handled gracefully and the feature stays disabled without errors.
- E2E: fresh profile → onboarding appears → complete it → it never appears again.

**Definition of done**
- [ ] A fresh install walks a user through incognito + no-recovery + sync-tier without them being able
      to skip the no-recovery acknowledgement.
- [ ] History cleanup shows an accurate dry-run and deletes only vaulted domains.
- [ ] `docs/PRIVACY.md` is publishable as-is.

**Git:** direct commits on `dev`. When every Definition-of-done item is true, tag `phase-9-done` and push.

---

## Phase 10 — DriveSyncProvider

**Goal:** opt-in sync through the user's own Google Drive, with metadata-only freshness checks and
clean two-way migration. Unlocks the heavy tier for Phase 11.

**Depends on:** Phase 7 (merge engine, interface), Phase 9 (settings surface).
**Specs to read:** [ARCHITECTURE §6](docs/ARCHITECTURE.md#6-sync-and-merge), [§13 Drive integration](docs/ARCHITECTURE.md#13-drive-integration).

**In scope**
- `src/sync/drive/auth.ts` — `chrome.identity.getAuthToken({ interactive })` with the `drive.file`
  scope only; `removeCachedAuthToken` + retry on 401; `launchWebAuthFlow` + PKCE fallback for
  profiles not signed into Chrome; token never persisted by us.
- `build/manifest.ts` gains `oauth2: { client_id, scopes: ["https://www.googleapis.com/auth/drive.file"] }`
  and a documented `key` field for a stable unpacked extension ID during development
  (instructions in [RELEASE §5](docs/RELEASE.md#5-google-cloud--oauth-setup)).
- `src/sync/drive/api.ts` — a thin Drive v3 client: `files.list` (find our folder/file by name within
  `drive.file` visibility), `files.create` (multipart, with `appProperties`), `files.update`
  (media upload + `appProperties`), `files.get` with `fields=` for metadata-only reads. Exponential
  backoff on 403 `rateLimitExceeded`/`userRateLimitExceeded` and 5xx; respects `Retry-After`.
- `src/sync/drive/provider.ts` — `DriveSyncProvider implements SyncProvider`:
  - layout `/VaultaMark/vaultamark-vault.vmv` (light tier) + `/VaultaMark/thumbs/t_<id>.vmt`
  - `peek()` = one metadata-only `files.get?fields=modifiedTime,version,md5Checksum,appProperties`
  - optimistic concurrency via `appProperties.vmRev` + `If-Match` on `etag` where supported;
    mismatch → `PreconditionFailed` → the engine re-merges
  - `capabilities = { heavyTier: true, maxLightBytes: 50 * 1024 * 1024 }`
  - `disconnect()` revokes the token, clears cached ids, and **leaves the user's Drive files intact**
    (with an explicit optional "also delete the Drive copy" action)
- Wake-event freshness checks: `chrome.runtime.onStartup`, SW wake, `chrome.idle` state change to
  `active` (when the permission is granted), and after any local list change — each triggers `peek()`,
  never a blind download. Coalesced to at most one probe per 60 s.
- `src/sync/migration.ts` — provider switching per D24/§6, with a progress UI, verification step, and
  a rollback if verification fails.
- Settings → Sync: connect/disconnect Drive, show the Drive account email, "Sync now", last error,
  a link to the file in Drive, and a clear statement that VaultaMark can only see files it created.
- Offline behaviour: queue and retry; the UI shows "offline, changes are saved locally".
- **Settings travel with the vault.** `vm.settings` is per-profile today, so a second Chrome profile
  on the same Google account joins the synced vault (Phase 7, `repo.adopt`) and then starts from the
  defaults: theme, idle timeout, lock-on-blur, the tracking strip and the manager's column widths all
  have to be set again by hand. Maintainer-reported, 2026-08-02. It lands here rather than earlier
  because the fix is a *synced* settings record and this is the phase that already has to reason
  about a settings payload crossing a provider.
  - The record goes **inside the ciphertext**, not beside it. INV-6 is about vault *content* and a
    theme is not content — but `chrome.storage.sync` is replicated by Google whatever it holds, and
    "which of our users leaves the vault unlocked forever" is not a fact worth publishing in the
    clear when encrypting it is free. It merges last-writer-wins per field on `updatedAt`; there is
    no conflict UI for a preference.
  - Two exclusions, and they are the reason this is a design item rather than a one-line move:
    `sidebarWidth`/`detailWidth` describe a *screen*, so a laptop must not inherit a desktop's
    column widths, and `providerId` describes *this profile's* connection, so syncing it would tell
    a profile with no Drive token to use Drive. Both stay in the local `vm.settings`, which
    therefore does not go away — it becomes the per-device half of a two-part record.
  - A profile that has not adopted a vault has nothing to sync settings with; the local file is the
    whole story there, exactly as now.

**Out of scope:** thumbnails (Phase 11) — but `putThumb`/`getThumb` are implemented and tested here
so Phase 11 only adds capture and UI.

**Tests**
- `test/unit/sync/drive/*` against a mocked `fetch`: auth retry on 401, backoff on 403/5xx,
  metadata-only `peek` (assert the request has a `fields` param and no media download), multipart
  create, `appProperties` round-trip, `PreconditionFailed` on `vmRev` mismatch.
- The Phase-7 merge and two-device tests are **re-run against `DriveSyncProvider`** using the mock —
  proving the abstraction holds (this is the real payoff of the interface).
- Migration: chrome → drive → chrome preserves every item; a drive vault too large for `storage.sync`
  blocks the reverse migration with an actionable message.
- **INV-4**: the only hosts contacted are `www.googleapis.com` and `accounts.google.com`; with Drive
  disconnected, zero requests are made (Playwright route interception).
- Manual verification against a real Drive account, written up in the commit message (a mocked-only
  Drive integration is not sufficient evidence).

**Definition of done**
- [ ] A real Google account connects, syncs, and converges across two profiles.
      **Maintainer's, and the reason this phase is not tagged.** Playwright cannot sign into Google
      and a mocked `fetch` proves the client is right without proving Google agrees. Procedure:
      [DEVELOPMENT §5.4](docs/DEVELOPMENT.md#54-drive-sync-by-hand).
- [x] `peek()` costs one request and no payload download when nothing changed.
      (`test/unit/sync/drive/provider.test.ts`, asserted against the mock's `fields=` projection —
      a probe that forgot it would come back with the payload and the test would see it.)
- [x] Migration both directions verified, against a mocked Drive
      (`test/integration/provider-migration.test.ts`): round trip preserves every item, a vault too
      large for `storage.sync` blocks the reverse with a count, and a failed verification flips
      nothing. Against a **real** account it is part of the manual pass above.
- [x] INV-4 test passes with Drive both on and off. Off: `popup.spec.ts` / `manager.spec.ts`
      route-intercept and assert zero requests. On: `test/unit/sync/drive/hosts.test.ts` runs the
      whole lifecycle and checks every host against `build/url-allowlist.json` itself.
- [x] Only `drive.file` is ever requested (asserted against the manifest in
      `test/unit/build/manifest.test.ts` and against the `getAuthToken` call in
      `test/unit/sync/drive/auth.test.ts`).
- [x] A second profile that adopts the vault inherits the synced settings, and keeps its own column
      widths and its own provider (`test/integration/adopt-synced-vault.test.ts`).

**Deviations, recorded rather than left in the code**

- **The Drive container is JSON**, `{ v, header, buckets: { "<i>": "<base64url>" } }`, which the spec
  did not pin down. It trades about a third in size for a file a person can open — §13.3 makes a
  point of the vault being user-visible, and a user-visible opaque blob is only half of that. Written
  up in [ARCHITECTURE §13.3](docs/ARCHITECTURE.md#133-file-layout).
- **`vm.baseMeta` is rewritten rather than reset** at the flip (§6.6 step 3). Resetting it means the
  next sync reads every item as a local add and pushes the whole vault back at the backend it just
  came from; writing the base we have *just verified* is the same end state, one round trip earlier.
- **`build/url-allowlist.json` gained `https://oauth2.googleapis.com/`** — the OAuth token endpoint,
  which is a different host from the Drive API and is reached only by the PKCE fallback. INV-3's
  prose already covers it (`googleapis.com`); the concrete prefix list did not.
- **A build with no `VM_OAUTH_CLIENT_ID` emits no `oauth2` block at all.** Chrome treats a malformed
  one as a manifest error and refuses to load the extension, so an empty client id would break every
  source build. The settings screen says Drive is unavailable instead.
- **`SCHEMA_VERSION` was not bumped for the synced settings record.** It is an additive optional
  field in bucket 0's payload that older builds ignore, there is no item shape for a migration to
  change, and an empty record is left out entirely so an untouched vault seals byte for byte what it
  sealed before. Reasoning in [ARCHITECTURE §3.2](docs/ARCHITECTURE.md#32-bucket-plaintext).

**Git:** direct commits on `dev`. When every Definition-of-done item is true, tag `phase-10-done` and push.

---

## Phase 11 — OG-image thumbnails (heavy tier)

**Goal:** Discord-style previews, captured once at add-time, encrypted, never re-fetched while
browsing, and gracefully absent everywhere they are unavailable.

**Depends on:** Phase 10.
**Specs to read:** [ARCHITECTURE §14 Thumbnails](docs/ARCHITECTURE.md#14-thumbnails).

**In scope**
- `src/content/og-capture.ts` — injected via `chrome.scripting.executeScript` under `activeTab` at
  add-time only. Reads, in order: `og:image:secure_url`, `og:image:url`, `og:image`,
  `twitter:image`, `twitter:image:src`; plus `og:title`, `og:description` (each truncated: title
  300 chars, description 600 chars). Resolves relative URLs against the document base. Then
  **fetches the image in page context** (`fetch(url, { credentials: 'omit', mode: 'cors' })`),
  aborting above 5 MB, and transfers the bytes to the SW. On any failure: returns metadata only, no
  thumbnail, no retry, no error surfaced beyond a subtle "no preview available" state.
- `src/thumbs/validate.ts` — treat everything from the page as hostile: require `https:`; reject
  `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`,
  and any non-DNS host literal; reject `data:`, `blob:`, `javascript:`; require a decodable image
  and a sane content type; cap declared and actual bytes at 5 MB; cap decoded dimensions at
  10,000×10,000 (decompression-bomb guard); reject SVG entirely (script vector).
- `src/thumbs/process.ts` — `createImageBitmap` → `OffscreenCanvas` → longest edge ≤ 320 px
  (never upscale) → `convertToBlob({ type: 'image/webp', quality: 0.75 })`, with a quality
  step-down loop until ≤ 40 KB; JPEG fallback if WebP encoding is unavailable. Re-encoding through
  the canvas strips all metadata (EXIF/GPS) by construction — state this in the docs.
- `src/thumbs/store.ts` — the heavy tier: seal with `k_thumbs` (AAD `{v, 'thumb', itemId}`), write to
  `storage.local` under `vm.thumbs.<itemId>` **and** push to the provider when
  `capabilities.heavyTier`. An LRU cap on the local cache (**8 MB** for 1.0 — we do not request
  `unlimitedStorage`; see [ARCHITECTURE §5.1](docs/ARCHITECTURE.md#51-chromestoragelocal--the-working-copy))
  with eviction by last-viewed; Drive is the system of record, so eviction costs a re-fetch, not
  data. Deleting an item deletes its thumbnail locally and remotely.
- **Tier gating:** with `ChromeSyncProvider` active, thumbnails are **not captured at all** (no
  wasted work, no local-only data that will never sync) — unless the user opts into
  "keep thumbnails on this device only", which is offered once, in context, with an explanation.
  With Drive active, capture is on by default.
- UI: an **eye** icon on rows that have a thumbnail → expands an inline preview; a hover preview
  (200 ms delay, respects `prefers-reduced-motion`, disabled on touch); a "Refresh preview" action in
  the item detail pane that states plainly that it must open the page to re-capture, and does so only
  on that explicit click (opens the page in an incognito window, captures, closes). **Never**
  automatic, never in the background.
- **Graceful absence:** a device with no Drive connection shows favicon + title for items whose
  `thumb` metadata exists but whose bytes are unavailable, with a quiet "preview stored in Drive"
  affordance. No layout shift, no spinner that never resolves, no error toast.
- Schema: `thumb` metadata already exists in v2 (Phase 3), so no schema bump — verify and record that.

**Out of scope:** screenshots of any kind, browse-time fetching of any kind, background re-capture.

**Tests**
- `validate.ts` table test: ≥ 25 hostile inputs (private IPs, SVG, `data:`, oversized declared
  length, wrong content type, redirect to http, 10 MB payload) each rejected with the right reason;
  valid https JPEG/PNG/WebP accepted.
- `process.ts`: a 4000×3000 fixture downscales to ≤ 320 px longest edge, ≤ 40 KB, correct aspect
  ratio; a 100×80 fixture is **not** upscaled; the quality step-down loop terminates.
- Metadata stripping: a fixture with EXIF GPS produces output containing no EXIF marker.
- `store.ts`: thumbnails are encrypted at rest (**INV-6** extended — no image magic bytes appear in
  any stored value); LRU eviction respects the cap; item deletion removes both copies.
- Tier gating: with `ChromeSyncProvider` and the opt-in off, capture is never invoked (assert the
  content script is not injected).
- **INV-4 re-verified**: browsing a vault full of thumbnails issues zero network requests.
- E2E: add a page with an `og:image` (served from a local Playwright fixture server) → the eye icon
  appears → expanding shows the image → disconnect Drive → the row degrades to favicon without errors.

**Definition of done**
- [ ] Thumbnails appear for real sites with OG images when Drive is connected.
- [ ] Zero network requests while browsing (measured, INV-4).
- [ ] No plaintext image bytes anywhere in storage or on Drive (INV-6).
- [ ] All hostile-input cases rejected.
- [ ] Degradation on a Drive-less device is visually clean.

**Git:** direct commits on `dev`. When every Definition-of-done item is true, tag `phase-11-done` and push.

---

## Phase 12 — Hardening: E2E suite, performance, accessibility, security review

**Goal:** turn a feature-complete build into a shippable one.

**Depends on:** Phase 11.

**In scope**
- Full Playwright E2E suite covering the user journeys end to end: first run → onboarding → create
  vault → add via all four entry points → search/tag/folder → open in incognito (spy-asserted) →
  lock/unlock → export/import → connect Drive (mocked API, real extension code path) → conflict
  resolution → thumbnails. Run in CI on every push to `dev`.
- Performance budgets, enforced in CI (`scripts/check-budgets.mjs`):
  popup first paint < 100 ms; SW cold start < 50 ms; unlock (excluding KDF) < 200 ms for 1,000 items;
  total zip < 400 KB; largest single JS chunk < 150 KB.
- Bundle analysis committed as a report artifact; tree-shaking verified; dead code removed.
- Drag-and-drop reordering and re-parenting in the folder tree and list (the one optional feature
  promoted into 1.0 because the manager feels incomplete without it), with full keyboard equivalents.
- Accessibility: axe clean on every page, keyboard-only walkthrough documented, screen-reader labels
  for the tree/list/dialogs, `prefers-reduced-motion` respected everywhere.
- Error handling sweep: every `catch` produces a user-comprehensible message; no raw stack traces in
  the UI; a "copy diagnostics" button that produces a **redacted** report (no URLs, no titles, no
  tokens) for bug reports.
- Internationalization scaffolding: all user-facing strings moved to `_locales/en/messages.json`
  (English only for 1.0; the structure makes translation a PR).
- Security self-review against `docs/THREAT_MODEL.md`: a written checklist, each item ticked with a
  reference to the code or test that satisfies it. Run `/security-review` on the accumulated diff.
- `docs/THREAT_MODEL.md` finalized (expanded from ARCHITECTURE §8).
- **Dependency advisory sweep — do this first, before anything else in this phase.** Clear the whole
  Dependabot backlog in one deliberate change instead of merging bot PRs as they arrived (§0, R11).
  The **Vite, Vitest and ESLint majors are taken together**, because they are one interlocking
  toolchain: bump them, update **D2, D5 and D6** in §2.1 in the same commit, re-verify
  `build/mv3-plugin.ts` against the new Vite plugin API (`enforce`, `generateBundle`, lib-mode
  `fileName` and `build.modulePreload` have all moved between majors), and get the full suite green
  before touching the E2E work below. Record the result in `CHANGELOG.md`.
  Two triggers to **bring this forward** into an earlier phase: `npm audit` reporting a High on a
  path the build or CI actually executes, or any phase introducing a real dev server. Every
  advisory seen up to Phase 1 was dev-server-only and therefore inert here — `npm run dev` is
  `vite build --watch`, never `vite serve` — and that reasoning stops holding the moment a server
  exists.

**Out of scope:** new features.

**Tests:** the E2E suite is the deliverable. Plus budget checks and the a11y sweep.

**Definition of done**
- [ ] Full E2E suite green in CI, < 10 min wall clock.
- [ ] All performance budgets met and enforced.
- [ ] Zero critical/serious axe violations on every page.
- [ ] Security checklist complete, with every item traced to code or a test.
- [ ] No user-facing string outside `_locales`.
- [ ] `npm audit` reports no advisory, or each remaining one is recorded in the security checklist
      with a written reason for accepting it. No Dependabot PR is left open without a decision.

**Git:** direct commits on `dev`. When every Definition-of-done item is true, tag `phase-12-done` and push.

---

## Phase 13 — Release engineering & 1.0.0

**Goal:** a tag on `main` produces a GitHub Release with a verified zip, and (behind an explicit gate)
a Chrome Web Store submission.

**Depends on:** Phase 12.
**Specs to read:** [docs/RELEASE.md](docs/RELEASE.md) in full — implement it.

**In scope**
- `.github/workflows/release.yml` — triggers on `push: tags: v*.*.*` **and** `workflow_dispatch`:
  1. verify tag is on `main` and matches `package.json` version (fail loudly otherwise)
  2. `npm ci` → `npm run verify` (lint, type-check, unit, integration, build, invariants)
  3. E2E suite
  4. `npm run zip` → `vaulta-mark-<version>.zip`
  5. compute and print SHA-256 of the zip; attach `SHA256SUMS`
  6. extract the matching `CHANGELOG.md` section for the release body
  7. create the GitHub Release with the zip + checksums attached
  8. **gated** Chrome Web Store upload: runs only when `workflow_dispatch` input `publish == 'true'`,
     using `chrome-webstore-upload-cli` with `EXTENSION_ID`, `CLIENT_ID`, `CLIENT_SECRET`,
     `REFRESH_TOKEN` from repository secrets; `--auto-publish` behind a second input
     `auto_publish` (default false → uploads a draft for manual submission)
- `scripts/release-notes.mjs` — extract a version's section from `CHANGELOG.md`.
- `scripts/check-version-sync.mjs` — `package.json` ⇄ tag ⇄ built manifest agreement.
- CHANGELOG finalized for `1.0.0`; `[Unreleased]` emptied.
- Store assets produced per `docs/STORE_LISTING.md`: 128×128 icon, five 1280×800 screenshots, a
  440×280 promo tile, short description (≤ 132 chars), full description leading with the five
  differentiators, single-purpose statement, and a per-permission justification string for each
  requested and optional permission (draft text lives in `docs/STORE_LISTING.md`).
- `docs/PRIVACY.md` published (GitHub Pages or a raw-file URL) and linked from the Store listing.
- README completed: badges (CI, release, license), install-from-Store link, build-from-source
  instructions, the reproducibility note (how to verify the published zip's hash against a local
  build), security policy link, and the differentiators up top.
- GitHub issues created for the post-1.0 backlog (B1–B9).
- Release `1.0.0`: `git checkout main && git merge --no-ff dev`, push, annotated tag `v1.0.0`, verify
  the GitHub Release, then the **manual first Store upload** (the API cannot create a new item);
  subsequent releases can use the gated automation.

**Tests**
- `scripts/*` unit tests (release-notes extraction, version-sync detection).
- A dry-run of the release workflow on a `v0.0.0-test` tag in a fork or with the publish gate off.

**Definition of done**
- [ ] A tag push produces a GitHub Release with the zip and checksums, without publishing to the Store.
- [ ] `workflow_dispatch` with `publish: true` uploads a draft to the Store (verified once the item exists).
- [ ] All four Store secrets documented end-to-end in `docs/RELEASE.md`, with screenshots-in-words for
      each Google Cloud step.
- [ ] `main` is protected exactly as `docs/BRANCH_PROTECTION.md` specifies.
- [ ] v1.0.0 tagged and released.

**Git:** direct commits on `dev`, tag `phase-13-done`. Then the release itself:
`git checkout main && git merge --no-ff dev -m "release: v1.0.0"`, push `main`, and push the
annotated tag `v1.0.0` — see [RELEASE §4](docs/RELEASE.md#4-cutting-a-release).

---

## 10. README outline

To be written in Phase 0 and completed in Phase 13.

```
# VaultaMark
> Encrypted bookmarks that never touch your omnibox. Synced through your own Google Drive.

[CI badge] [Release badge] [License: GPL-3.0 badge] [Chrome Web Store badge]

## Why VaultaMark
Five differentiators, one line each:
  · Encrypted vault synced through YOUR own Google Drive — nobody else does this
  · Stored entirely outside chrome.bookmarks → vaulted URLs never autocomplete in the address bar
  · Discord-style link previews, captured once when you save, encrypted, never re-fetched
  · Every vaulted link opens in an incognito window
  · One-click history cleanup for vaulted domains — closes the omnibox-via-history leak
  · Zero config by default (Chrome sync); connect Drive when you want more room and previews

## Screenshots            (Phase 13)
## Install                 Web Store link · build from source · verify the published zip's hash
## How it works            60-second version: password → PBKDF2 → AES-256-GCM → your storage
## What it protects (and what it doesn't)   → links to SECURITY.md + docs/THREAT_MODEL.md
## THE ONE WARNING         There is no password recovery. None. Not by us, not by anyone.
## Sync tiers              Chrome sync (default, ~600 bookmarks, no thumbnails) vs Drive (large, thumbnails)
## Permissions             Table: permission → why → required or optional
## Privacy                 No telemetry. No analytics. No network calls except your Drive.
## Development             Prereqs, npm scripts, load-unpacked, test tiers → docs/DEVELOPMENT.md
## Architecture            → docs/ARCHITECTURE.md
## Releases                → docs/RELEASE.md + CHANGELOG.md
## Contributing            → CONTRIBUTING.md
## Security                → SECURITY.md (private reporting via GitHub advisories)
## License                 GPL-3.0-only
```

---

## 11. Risks & open questions

### Risks

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | `chrome.storage.sync` quota is tighter in practice than the math suggests | Medium | High | Phase 7 measures a real fixture and updates the documented ceiling; the 70 %/95 % guards degrade rather than break; Drive is the escape hatch. |
| R2 | `storage.sync` has no true compare-and-swap, so a fast two-device race could interleave a push | Medium | Medium | Read-verify-write plus post-write verification, bucket HMAC tags to detect torn writes, and an idempotent merge engine that converges on the next sync. Fuzz-tested in Phase 7. |
| R3 | OAuth verification for `drive.file` takes weeks | High | Medium | `drive.file` is Sensitive, not Restricted — a form and a demo video, no CASA audit. Start verification during Phase 10, not Phase 13. Until verified, the unverified-app screen limits us to 100 users, which is fine for a beta. |
| R4 | Store review flags the `history` or `bookmarks` permission | Medium | Medium | Both are **optional** and requested in context; the justification strings are drafted in Phase 0 and refined in Phase 13. |
| R5 | Content-script image fetch is blocked by page CSP/CORS on many sites, so thumbnail coverage is poor | High | Low | Accepted by design: no thumbnail is a fine outcome, favicons always work. The opt-in extension-origin fetch exists for users who want coverage. Measure real-world coverage during Phase 11 and put the number in the docs. |
| R6 | `storage.session` key custody is a weaker posture than pure in-memory | Certain | Low–Medium | Documented in the threat model and in Settings; memory-only, never on disk, cleared on browser exit; timeout default 10 min; "require password after restart" on by default. |
| R7 | Users lose their password and blame the extension | High | Low (product) / High (support) | Typed acknowledgement at creation, a repeat warning in onboarding, a README section, a Store-listing sentence, and the encrypted-export flow pushed as the backup story. |
| R8 | MV3 service-worker termination causes subtle sync bugs | Medium | Medium | Phase 4 tests simulate termination explicitly; Phase 7's engine is restartable and idempotent; every long operation is resumable. |
| R9 | Scope creep across 14 phases | High | Medium | Each phase's "out of scope" list is binding. A fresh conversation that wants to do more should open an issue instead. |
| R10 | `_favicon/` returns the generic globe for sites not in the profile's cache | Certain | Low | Documented; the letter-avatar fallback is designed, not an afterthought. |
| R11 | Dev-dependency advisories accumulate, and clearing them needs major upgrades that contradict settled decisions (Vite → D2, Vitest → D5, ESLint → D6) | Certain | Low | **Nothing from npm ships.** `dist/` carries zero runtime dependencies (D4), enforced by `verify:invariants`, so a toolchain advisory can never reach a user of the extension — the exposure is the maintainer's own machine. Reviewed with `npm audit` at the end of every phase (§0); majors are executed as **one deliberate change in Phase 12**. Brought forward if a High lands on a path the build or CI actually runs. |

### Resolved decisions (previously open; settled by the maintainer's delegation — do not relitigate)

All six questions below were delegated back to the plan author and are now **binding**. A phase
conversation that wants to change one must open an issue and get it changed here first.

1. **License — GPL-3.0-only.** Final. Copyleft keeps forks of a security tool auditable, matches the
   prior art in this niche, and is compatible with Chrome Web Store distribution. The cost (no
   proprietary reuse of the crypto/sync modules) is a non-goal.
2. **Short description (≤ 132 chars)** — the working draft, refined only for length/clarity in
   Phase 13:
   > *Password-encrypted bookmarks kept out of Chrome's bookmarks and omnibox. Opens in incognito.
   > Optional sync via your own Google Drive.* (131 chars)
3. **Google Cloud + Chrome Web Store accounts** — the maintainer creates both under `zyndata`, at the
   start of Phase 10 (Cloud project + OAuth consent screen; verification takes weeks, so it starts
   early) and before Phase 13 (Store developer account, $5). Phases 0–9 are unblocked. Every step is
   in [RELEASE §5–§6](docs/RELEASE.md#5-google-cloud--oauth-setup).
4. **Minimum Chrome version — 116.** Set in the manifest as `minimum_chrome_version: "116"`. Floor
   drivers: `chrome.storage.session` (102), `OffscreenCanvas.convertToBlob` WebP (94),
   `CompressionStream` (80), and MV3 service-worker stability. Chrome 116 shipped in 2023; anything
   older is not a market worth constraining the design for.
5. **Native-bookmark deletion — never automatic.** Importing into the vault and deleting the Chrome
   originals are two separate, separately-confirmed actions (Phase 8). No "do both" convenience
   button: the deletion is irreversible from our side and is exactly the step a user might regret.
6. **Thumbnails on the Chrome-sync tier — not captured.** With `ChromeSyncProvider` active, no OG
   capture happens at all, so no device accumulates data that can never sync. The first time a user
   adds a page that *has* an OG image, they are offered a one-time, in-context opt-in for
   local-only thumbnails, with the tradeoff stated. Connecting Drive turns capture on by default.

### Still genuinely open (decide when the phase arrives, not before)

- **Measured `storage.sync` ceiling** — the ~600/~980 figures in
  [ARCHITECTURE §5.3](docs/ARCHITECTURE.md#53-capacity-math) are derived, not measured. Phase 7 must
  measure a real fixture and correct the number in ARCHITECTURE, README, and the quota-warning copy.
- **Real-world thumbnail coverage** — how many sites survive the content-script fetch (page CSP and
  image CORS both have to cooperate). Phase 11 measures it across a sample and puts the number in
  the docs. If coverage is very low, revisit whether the off-by-default extension-origin fetch
  should be offered more prominently.
- **`auto_publish` in the release workflow** — stays `false` until several releases have gone
  through the pipeline cleanly ([RELEASE §10](docs/RELEASE.md#10-rollback)).

---

*Changes to this plan are made on `dev` with a `docs:` commit. Phases should be renumbered only if
absolutely necessary — the phase number is the contract with the executing conversation.*
