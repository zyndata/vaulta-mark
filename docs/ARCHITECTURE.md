# VaultaMark — Architecture

Technical reference for [PLAN.md](../PLAN.md). This document is normative: where it and the code
disagree, one of them is a bug. Phases that change anything here must update it in the same PR.

**Contents**

1. [Component map](#1-component-map)
2. [Build system](#2-build-system)
3. [Vault format](#3-vault-format)
4. [Cryptography](#4-cryptography)
5. [Storage layout](#5-storage-layout)
6. [Sync and merge](#6-sync-and-merge)
7. [Service-worker lifecycle](#7-service-worker-lifecycle)
8. [Threat model](#8-threat-model)
9. [Incognito opening](#9-incognito-opening)
10. [Favicons](#10-favicons)
11. [Portable file format](#11-portable-file-format)
12. [History hygiene](#12-history-hygiene)
13. [Drive integration](#13-drive-integration)
14. [Thumbnails](#14-thumbnails)
15. [Dependencies policy](#15-dependencies-policy)

---

## 1. Component map

```
src/
├─ background/          service worker — the ONLY place keys exist
│  ├─ index.ts          entry, message router, install/startup
│  ├─ session.ts        key custody, unlock/lock, storage.session
│  ├─ autolock.ts       alarms, idle, blur
│  ├─ commands.ts       keyboard shortcuts
│  ├─ contextmenu.ts    right-click entries
│  ├─ add.ts            add active tab / link — URL policy, duplicates
│  ├─ items.ts          the popup's vocabulary (add/list/open/delete/undo)
│  ├─ organize.ts       the manager's vocabulary (folders/edit/tags/bulk ops), batched
│  ├─ badge.ts          toolbar feedback for the entry points that have no window
│  ├─ incognito.ts      access detection + windows.create
│  └─ history.ts        vaulted-domain cleanup, quick-close
├─ crypto/              WebCrypto only — no other module may import crypto.subtle
│  ├─ kdf.ts  keys.ts  envelope.ts  codec.ts  hash.ts  wipe.ts  password.ts  errors.ts
├─ vault/               pure domain logic, zero I/O
│  ├─ types.ts  model.ts  order.ts  migrate.ts  search.ts  sort.ts  errors.ts
├─ storage/             persistence of the working copy
│  ├─ repo.ts  local.ts  buckets.ts  codec.ts  quota.ts
├─ sync/                transport + reconciliation
│  ├─ provider.ts       the SyncProvider interface
│  ├─ chrome-provider.ts
│  ├─ drive/{auth.ts,api.ts,provider.ts}
│  ├─ merge.ts  engine.ts  base.ts  migration.ts
├─ thumbs/              validate.ts  process.ts  store.ts
├─ import/              native-bookmarks.ts
├─ history/             domain.ts (registrable domains)  cleanup.ts (chrome.history)
│                       public-suffix.ts  ← generated, `npm run update-psl`
├─ io/                  export-encrypted.ts  import-encrypted.ts  rollback.ts
├─ content/             og-capture.ts   (injected on demand, never declared in the manifest)
├─ popup/               popup.ts (shell + create/unlock)  vault.ts (the unlocked screen)
├─ manager/             manager.ts (entry/router)  app.ts (the shell)
│  ├─ state.ts          what the tab is looking at; the only thing that fetches
│  ├─ sidebar.ts  list.ts  detail.ts  settings.ts  dnd.ts  sync.ts  io.ts
│  └─ onboarding/       steps.ts (the gates, pure)  screen.ts (the five screens)
├─ ui/                  dom.ts  favicon.ts  incognito-prompt.ts  virtual-list.ts  strings.ts
│                       dialog.ts  create-form.ts  address.ts  history-cleanup.ts
│                       tracking.ts  export-gate.ts  styles.css
└─ shared/              messages.ts  settings.ts  result.ts  time.ts  url.ts
```

**Dependency direction is strictly one-way:**

```
ui → shared → vault → crypto
       ↑        ↑
   storage ─────┘
       ↑
     sync
       ↑
  background
```

`crypto` imports nothing from the project. `vault` is pure and testable in isolation. Nothing below
`background` may call `chrome.*` except `storage`, `sync`, and `ui/favicon.ts` (which only builds a
URL). This is enforced by an ESLint `import/no-restricted-paths` configuration.

---

## 2. Build system

### Why not `@crxjs/vite-plugin`

`@crxjs/vite-plugin` v2 has been in beta for an extended period with intermittent maintenance. A
build plugin that stalls blocks Chrome Web Store releases, and its HMR machinery injects code paths
we would then have to prove are absent from production builds (INV-1). Our requirements are small:

- four entries: `background` (ES module, no splitting), `popup`, `manager` (both HTML entries),
  `content/og-capture` (single-file IIFE, injected via `scripting.executeScript`)
- emit `manifest.json` from a typed source
- copy `public/` (icons, `_locales`)
- a dev watch loop

`build/mv3-plugin.ts` implements exactly that in ~80 lines we own and can audit.

### Entry configuration

| Entry | Format | Notes |
| --- | --- | --- |
| `background.js` | `es` module | `"type": "module"` in the manifest. **No code splitting** — a dynamic import in a service worker after termination is a common failure source. `output.codeSplitting = false` (Rolldown's name for what Rollup called `inlineDynamicImports`). |
| `popup.html` + `popup.js` | `es` | HTML entry, hashed asset names. |
| `manager.html` + `manager.js` | `es` | Same. |
| `og-capture.js` | `iife`, single file | `chrome.scripting.executeScript({ files: [...] })` needs one self-contained file with no imports. |

Target `chrome116`. `minify: 'oxc'` (Vite 8 bundles with Rolldown and ships no esbuild), `sourcemap: 'hidden'` (maps are built, uploaded as CI
artifacts for debugging, and **excluded from the store zip**).

### `manifest.json` (generated)

```jsonc
{
  "manifest_version": 3,
  "name": "__MSG_extName__",
  "description": "__MSG_extDescription__",
  "default_locale": "en",
  "version": "1.0.0",                       // from package.json, see build/version.ts
  "minimum_chrome_version": "116",
  "icons": { "16": "...", "32": "...", "48": "...", "128": "..." },
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html", "default_title": "__MSG_actionTitle__" },
  "options_page": "manager.html",
  "permissions": ["storage", "activeTab", "scripting", "contextMenus", "alarms", "favicon"],
  "optional_permissions": ["identity", "history", "bookmarks", "idle"],
  "optional_host_permissions": ["https://www.googleapis.com/*"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; frame-ancestors 'none'"
  },
  "incognito": "spanning",
  "commands": {
    "add-current-tab": { "suggested_key": { "default": "Ctrl+Shift+S", "mac": "Command+Shift+S" },
                         "description": "__MSG_cmdAdd__" },
    "panic-lock":      { "suggested_key": { "default": "Ctrl+Shift+L", "mac": "Command+Shift+L" },
                         "description": "__MSG_cmdLock__" },
    "open-manager":    { "suggested_key": { "default": "Ctrl+Shift+B", "mac": "Command+Shift+B" },
                         "description": "__MSG_cmdManager__" }
  },
  "web_accessible_resources": []            // deliberately empty
}
```

Notes:

- **No `content_scripts` declaration.** The OG capture script is injected on demand under `activeTab`.
  This is why we need no host permissions at install time.
- **No `web_accessible_resources`.** Nothing we ship should be reachable from a web page.
- `oauth2` is added in Phase 10 (Drive) with the single `drive.file` scope.
- Chrome 116+ is the floor: `CompressionStream` (Chrome 80), `OffscreenCanvas.convertToBlob` with
  WebP (Chrome 94+), `chrome.storage.session` (Chrome 102), `chrome.action.openPopup` (Chrome 127 —
  used only behind a feature check).

### Version mapping (`build/version.ts`)

Chrome versions must be 1–4 dot-separated integers. SemVer pre-releases map deterministically:

| `package.json` | `manifest.json` |
| --- | --- |
| `1.2.3` | `1.2.3` |
| `1.2.0-rc.1` | `1.2.0.1` |
| `1.2.0-beta.4` | `1.2.0.4` |

Rule: strip the pre-release identifier's leading word, append its numeric suffix as a fourth
component. A release build (`1.2.3`) always sorts above any of its pre-releases, since `1.2.3` >
`1.2.3.N` is **false** in Chrome's comparison — so pre-releases must use the *next* patch's number
minus one, or simply never be published to the Store. **Decision: pre-releases are never uploaded to
the Store**, only attached to GitHub Releases. That removes the ordering problem entirely.

### Invariant scanners

`scripts/verify-no-remote-code.mjs` walks every file in `dist/` and fails on:

- `<script` with a `src` whose value is not a relative path
- `<link rel="stylesheet">` with an absolute `href`
- any string literal matching `https?://` that is not in `build/url-allowlist.json`
- `eval(`, `new Function(`, `Function(` used as a constructor, `setTimeout("…")` with a string body
- `import(` with a non-literal or non-relative specifier
- `importScripts(`, `WebAssembly.instantiate`/`compile` (we ship no WASM)
- `navigator.sendBeacon`, `XMLHttpRequest` (we use `fetch` only, and only in the Drive/thumb paths)
- `blob:`/`data:` used as a script or worker URL

`scripts/verify-manifest.mjs` fails on:

- `manifest_version !== 3`
- a CSP that is not the exact expected string, or that contains `unsafe-eval`, `unsafe-inline`,
  `wasm-unsafe-eval`, or any remote origin
- a `permissions`/`optional_permissions`/`host_permissions` set that differs from
  `build/permissions.lock.json` (INV-9 — changing it requires updating the lock file, which forces a
  reviewed diff and a CHANGELOG entry)
- a non-empty `web_accessible_resources` without an explicit allowlist entry
- any declared `content_scripts` (we inject only)

Both run in `npm run verify:invariants`, which runs in CI on every PR and in the release workflow.

---

## 3. Vault format

`SCHEMA_VERSION = 2`.

### 3.1 Header (plaintext)

Stored at `vm.meta` in `storage.local` and mirrored to the active provider. It **must** be plaintext:
we cannot derive the key without the KDF parameters.

```ts
interface VaultHeader {
  magic: 'VAULTAMARK';
  schemaVersion: 2;
  kdf: {
    alg: 'PBKDF2-HMAC-SHA256';
    iterations: number;          // 600000 at v2
    salt: string;                // base64url, 32 bytes, random per vault
  };
  wrappedDek: { iv: string; ct: string };   // AES-256-GCM(KEK, DEK): 12B IV, 32B+16B tag
  vaultRev: number;              // monotonic; incremented on every committed change
  bucketCount: number;           // 16 initially; 32, 64… after rebalance
  buckets: BucketMeta[];
  createdAt: number;             // epoch ms
  updatedAt: number;
  deviceId: string;              // random per install; used only for merge-conflict labels
}

interface BucketMeta {
  i: number;                     // bucket index
  rev: number;                   // vaultRev at which this bucket last changed
  parts: number;                 // how many storage items this bucket occupies; 0 = empty, unstored
  tag: string;                   // base64url of HMAC-SHA256(k_hmac, plaintext)[0..8]
}
```

Every index in `[0, bucketCount)` has an entry, empty buckets included. `parts: 0` means the bucket
holds no items and **nothing is stored for it** — an empty vault therefore occupies one header and
no bucket values, rather than sixteen sealed empty payloads costing ~7 KB of a 100 KB sync quota to
say nothing.

`tag`'s "plaintext" is the **canonical JSON** of the bucket payload — object keys sorted at every
depth, items ordered by id — taken before gzip. Canonical ordering is not cosmetic: the tag's whole
job is to answer "did this bucket's contents change?", and it can only do that if the same item set
always serialises to the same bytes. Without it, an item rebuilt with its fields in a different
order would report a change that never happened, costing one sync write per edit forever.

**What the header leaks:** that a VaultaMark vault exists, when it was created and last changed, how
many buckets it has (a coarse size signal), and how many revisions it has seen. It leaks **nothing**
about contents. `tag` is a keyed HMAC, not a plain hash, precisely so an observer cannot confirm a
guessed bucket content offline.

### 3.2 Bucket plaintext

```ts
interface BucketPayload {
  items: VaultItem[];
  settings?: SyncedSettings;    // bucket 0 only — see §6.7
}

type VaultItem = Bookmark | Folder;

interface ItemBase {
  id: string;                    // UUID v4, stable for the item's lifetime
  parentId: string;              // 'root' for top level
  title: string;
  createdAt: number;
  updatedAt: number;
  order: string;                 // fractional index — see §3.4
  rev: number;                   // vaultRev at last change to this item
  deleted?: true;                // tombstone
  deletedAt?: number;
}

interface Bookmark extends ItemBase {
  type: 'bookmark';
  url: string;
  note?: string;                 // soft cap 4096 chars
  tags?: string[];               // normalized: trimmed, lowercased, deduped, max 32 per item
  openedAt?: number;
  openCount?: number;
  og?: { title?: string; description?: string };
  thumb?: ThumbMeta;
}

interface Folder extends ItemBase { type: 'folder' }

// Absent and empty mean the same thing, and are read through accessors so no call site has to
// know which one it got:
tagsOf(item)  // item.tags ?? []
noteOf(item)  // item.note ?? ''

interface ThumbMeta {
  sha256: string;                // of the *plaintext* thumbnail bytes; integrity + dedupe
  w: number; h: number;
  bytes: number;                 // encrypted size
  src: 'og' | 'twitter';
  at: number;                    // capture time
  driveId?: string;              // Drive file id when synced
}
```

`settings` is the synced half of `vm.settings` (§6.7). It rides in **bucket 0 only**, which every
vault has, and is an *additive, optional* field rather than a `SCHEMA_VERSION` bump: an older build
reads the bucket, ignores the key and behaves exactly as before, and there is no item shape for a
migration to change. An empty record is left out entirely, so a vault where nobody has ever changed
a preference seals byte for byte what it sealed before the field existed. What it does affect is
bucket 0's plaintext tag — which is the point: changing a theme dirties one bucket and travels like
any other edit.

### 3.3 Schema versioning and migration

`src/vault/migrate.ts` holds an ordered registry of `(from, to, fn)` steps. `migrate()` applies them
in sequence. Rules:

- A vault whose `schemaVersion` is **lower** than ours is migrated in memory on unlock and written
  back on the next commit.
- A vault whose `schemaVersion` is **higher** throws `UnsupportedSchemaError`; the UI says
  "this vault was created by a newer version of VaultaMark — please update" and refuses to write.
  Never downgrade-write; that destroys data.
- Migrations are pure functions over the decrypted payload, unit-tested against committed fixtures
  in `test/fixtures/vault-v<N>.json`.
- Migration runs over the **whole item set**, not per bucket: a step may need to see an item's
  siblings (v1 → v2 does), and a bucket holds a hash-scattered slice rather than a subtree.
- `migrate()` is the one place a decrypted payload becomes typed `VaultItem`s, so it also validates
  every item's required fields. That is not defending against an attacker — the bytes authenticated
  before they got there — it is defending against a migration step that forgets a field, which would
  otherwise surface three layers up with no clue where it came from.

**v1 → v2** (the one shipped migration): v1 lacked `tags`, `note`, `og`, `thumb`, and used integer
`order`. The step converts integer order to fractional indices, per parent. The new optional fields
are left **absent** rather than written as `[]` and `""`: absent and empty read identically through
`tagsOf`/`noteOf`, and an empty array in every item is real bytes against a 100 KB sync quota.

### 3.4 Ordering

Fractional indexing over the base-62 alphabet `0-9A-Za-z` — **in ASCII order**, so `<` on the strings
agrees with `<` on the digit values. `a0 < a0V < a1`. Inserting between two siblings generates a
midpoint string; only the moved item's `order` changes, so a reorder dirties one bucket instead of
renumbering a folder.

Keys carry a variable-length **integer part** whose length is encoded in the first character (`a` →
one digit above zero, `b` → two, …; `Z` → one digit below zero, `Y` → two, …). That prefix is what
keeps appends cheap: adding to the end of a list increments the integer part instead of appending a
digit, so a thousand sequential adds produce keys of length 2–3 rather than length 500. Only
inserting *between* two adjacent keys lengthens the fractional part, and then by one digit.

There is consequently **no "no midpoint available" case** and no renumbering path: a midpoint always
exists, because the fractional part can always grow. `ordersBetween(before, after, n)` exists for
laying out an imported folder in one pass and bisects rather than chaining, so `n` keys stay short.
Exhaustion needs the integer part to overflow 27 base-62 digits, which is not reachable.

`src/vault/order.ts` reproduces the well-known algorithm (as in the `fractional-indexing` package)
rather than depending on it: ~120 lines, load-bearing for data we cannot re-derive, and D4 wants a
written case for a runtime dependency. This is not that case.

### 3.5 Normalization rules

- **Tags:** `trim().toLowerCase()`, NFC-normalized, internal whitespace collapsed, empty rejected,
  max 64 chars, max 32 per item, deduped.
- **URLs:** stored as the user's tab reported them, with these applied: lowercase scheme and host,
  strip the default port, keep the fragment (people bookmark anchors), keep the query. UTM stripping
  is **on** by default and available as a setting; it removes campaign and click-identifier
  parameters only (`utm_*`, `gclid`, `fbclid`, `msclkid`, …) — nothing that could change which page
  a URL resolves to, which is what makes it safe to have on: none of it is load-bearing, and leaving
  it makes the same article saved from two mailings look like two bookmarks. Switching the setting
  on offers, once and only when there is something to offer, to apply the same strip to what is
  already saved (`organize.countTracked` / `organize.stripTracked`, `ui/tracking.ts`); nothing is
  ever rewritten without that being answered. Two bookmarks that collapse to the same address stay
  two bookmarks — a clean-up of addresses is not a licence to delete one of them. A separate key is
  computed for duplicate detection only (`duplicateKeyOf`:
  scheme+host+path+sorted query, fragment dropped, a bare origin's trailing slash normalised away)
  and **never stored**. A URL `URL` cannot parse is kept verbatim: this is a bookmark manager, not a
  validator, and a user should get back exactly what they saved.
- **Which URLs may be vaulted at all** (`background/add.ts`, an allowlist of `http`, `https`, `ftp`,
  `ftps`): a browser-internal page (`chrome:`, `chrome-extension:`, `about:`, `devtools:`,
  `view-source:`, and the equivalents in other Chromium builds) is refused because nothing could
  reopen it later; `file:` is refused because an incognito window will not open it; everything else
  — `javascript:`, `data:`, `blob:`, `mailto:` — is refused because its "bookmark" is a payload
  rather than a destination. An allowlist rather than a denylist on purpose: forgetting to ban a
  scheme is unrecoverable, forgetting to allow one is a bug report. Input `URL` cannot parse is
  refused here too — it has no scheme to have checked — which is why this rule is separate from
  `normalizeUrl`, which keeps such input verbatim once it is already stored.
- **Search text:** NFKD-folded, combining marks stripped, lowercased. The search index is built on
  unlock and dropped on lock — it is never persisted, because a search index *is* the vault content
  reorganised, and writing one would break INV-6.

---

## 4. Cryptography

Everything here lives in `src/crypto/`. **No other module may import `crypto.subtle`** (ESLint-enforced:
`no-restricted-syntax` bans the `subtle` member everywhere under `src/` except `src/crypto/**`).

| Module | Contents |
| --- | --- |
| `kdf.ts` | `deriveKek`, `generateKdfSalt`, `pbkdf2Sha256`, `KdfParams`, `RECOMMENDED_KDF_PARAMS` |
| `keys.ts` | `generateDek`, `wrapDek`, `unwrapDek`, `subkey`, `hkdfSha256` |
| `envelope.ts` | `seal`, `open`, `aadBytes`, `gcmEncrypt`, `gcmDecrypt`, the wire-format constants |
| `codec.ts` | `Bytes`, `gzip`/`gunzip`, `pad`/`unpad`, `toBase64Url`/`fromBase64Url`, `utf8`/`utf8Decode` |
| `hash.ts` | `sha256`, `hmacSha256`, `verifyHmacSha256`, `assertHmacSha256`, `equalBytes` |
| `wipe.ts` | `zero`, `zeroAll`, `Secret<T>` |
| `errors.ts` | `CryptoError`, `WrongPasswordError`, `CorruptVaultError`, `UnsupportedSchemaError` |
| `password.ts` | `estimateStrength`, `isCommonPassword`, `MIN_PASSWORD_LENGTH` |
| `data/` | the bundled common-password list — see §4.6 |

The module is storage-agnostic: it imports nothing from the rest of the project, touches no `chrome.*`
API, and knows nothing of the vault schema. `Bytes` (`Uint8Array<ArrayBuffer>`) is the byte type used
throughout; bare `Uint8Array` admits `SharedArrayBuffer`, which WebCrypto will not accept as a
`BufferSource`.

### 4.1 Key hierarchy

```
master password (never stored, never transmitted, never logged)
      │
      │  PBKDF2-HMAC-SHA256, 600,000 iterations, 32-byte random salt (from the header)
      ▼
    KEK  (256-bit, non-extractable where possible)
      │
      │  AES-256-GCM unwrap of header.wrappedDek
      ▼
    DEK  (256-bit, random at vault creation, never changes unless the vault is re-keyed)
      │
      │  HKDF-SHA256, salt = 32 zero bytes, info = "vaultamark/v2/<purpose>"
      ├──► k_items   — bucket payload encryption
      ├──► k_thumbs  — thumbnail encryption
      └──► k_hmac    — bucket integrity tags
```

**Why two levels.** Changing the master password re-derives the KEK and re-wraps 32 bytes. Nothing
else is touched: no re-encryption of the vault, no sync storm, no window in which the vault is
half-converted. Phase 6 asserts this (bucket tags must be unchanged after a password change).

**Why HKDF subkeys.** No key is ever used for two purposes. A hypothetical weakness in the thumbnail
path cannot be turned into an oracle against the item path.

**What each level is, concretely.** The KEK is a non-extractable `CryptoKey` — the raw bits never
exist as JavaScript-reachable bytes, which costs us nothing because the KEK's only job is the DEK.
The DEK is the opposite: 32 raw bytes, because it has to survive in `chrome.storage.session` across
service-worker restarts (D14) and a `CryptoKey` does not serialise into it. Subkeys are
non-extractable `CryptoKey`s again; `subkey()` derives 32 bits' worth of material, imports it, and
zeroes the intermediate buffer before it returns. `SUBKEY_INFO_PREFIX` carries the schema version, so
a future v3 vault derives entirely different subkeys from the same DEK for free.

### 4.2 KDF parameters

| Parameter | Value | Note |
| --- | --- | --- |
| Algorithm | PBKDF2-HMAC-SHA256 | WebCrypto-native, no dependency |
| Iterations | 600,000 | OWASP 2023 floor for PBKDF2-SHA256; ~350–700 ms on typical hardware |
| Salt | 32 random bytes | Per vault, in the header |
| Output | 256 bits | |

Parameters are read from the header at unlock, never hard-coded at the call site, so raising the
iteration count later is a header change plus a re-wrap, not a format break. The vault records the
parameters it was created with; when the app's recommended parameters exceed the stored ones, the UI
offers an in-place upgrade (re-derive KEK with the new count, re-wrap the DEK) — a post-1.0 nicety,
but the format supports it from v2.

**Parameters we refuse to read.** `deriveKek` throws `CorruptVaultError` for an unrecognised `alg`,
a salt that is not exactly 32 bytes, or an iteration count below `MIN_KDF_ITERATIONS` (100,000). The
last one is not defending against a rewritten header — lowering the count there does not help an
attacker, since the DEK was wrapped under the original KEK and would simply fail to unwrap. It
defends against an *imported* vault built by something else with an indefensibly cheap KDF, which
would otherwise leave the user weakly protected while every screen said "unlocked".

**On Argon2id:** memory-hard KDFs are meaningfully better against offline cracking. We are not
adopting one for 1.0 because the only practical route in MV3 is a WASM build, which requires adding
`'wasm-unsafe-eval'` to the CSP. Trading a documented, enforced, reviewable CSP for a KDF upgrade is
a bad deal against our threat model, where the primary adversary is a person with access to a device,
not a cluster. Revisit in backlog item B7 if a compiled-to-JS or native option appears.

### 4.3 Envelope format

`seal(key, plaintext, aad)` produces:

```
byte 0        : format version (0x02)
bytes 1..12   : IV (96-bit, from crypto.getRandomValues, fresh per operation)
bytes 13..N   : AES-256-GCM ciphertext ‖ 128-bit tag
```

AAD is the UTF-8 encoding of canonical JSON:

```jsonc
{ "v": 2, "purpose": "bucket", "id": "7" }
// or "thumb"/"<itemId>", "base"/"", "export"/"", "conflicts"/""
```

`conflicts` was added in Phase 7 for `vm.conflicts` (§5.1). It is a purpose of its own rather than a
second slot under `base` because the two hold different shapes with different lifetimes, and a purpose
is exactly the thing that stops one being opened as the other.

The AAD is rebuilt field by field, never stringified from the caller's object: JSON key order follows
insertion order, so an AAD constructed with its fields in a different order would produce different
bytes and fail to authenticate a blob that is perfectly valid.

Binding the AAD prevents a bucket ciphertext being replayed into a different bucket slot, or a
thumbnail blob being served as a bucket. `open()` throws `CorruptVaultError` on any tag failure
except the DEK unwrap, which throws `WrongPasswordError`.

| Failure | Thrown by | Error |
| --- | --- | --- |
| GCM tag fails on `header.wrappedDek` | `unwrapDek` | `WrongPasswordError` |
| `wrappedDek` is malformed (bad base64url, IV ≠ 12 B, ct ≠ 48 B) | `unwrapDek` | `CorruptVaultError` |
| GCM tag fails on any sealed blob | `open`, `gcmDecrypt` | `CorruptVaultError` |
| AAD does not match the one the blob was sealed with | `open` | `CorruptVaultError` |
| Version byte ≠ `0x02`, or blob shorter than 29 bytes of framing | `open` | `CorruptVaultError` |
| Padding, gzip or UTF-8 does not decode | `unpad`, `gunzip`, `utf8Decode` | `CorruptVaultError` |
| Header declares a schema version we do not know | vault layer (Phase 3) | `UnsupportedSchemaError` |

**`header.wrappedDek` is not an envelope.** It is a bare `{ iv, ct }` pair — 12-byte IV, 48-byte
ciphertext-plus-tag, both base64url — with **no version byte and no AAD**, because it is read before
we know anything at all, and its shape is fixed by the header format (§3.1). Everything else in the
vault goes through `seal`/`open`.

Random 96-bit IVs are safe here by a wide margin: GCM's birthday bound becomes a concern around 2³²
encryptions under one key, and a heavy user commits on the order of 10⁵ bucket writes in a decade.

**Known-answer tests.** `gcmEncrypt`/`gcmDecrypt` are exported precisely so the NIST-referenced GCM
vectors — which pin an IV and a raw AAD, and so cannot go through `seal` — run through the code the
product uses rather than through `crypto.subtle` directly, where a green test would only prove the
platform works. `test/fixtures/gcm-vectors.json` also pins one blob in our own envelope format: if
that test fails, the wire format changed, and a wire-format change needs a `SCHEMA_VERSION` bump and
a migration, not a regenerated fixture.

### 4.4 Compression and padding

Write order is **gzip → pad → seal**.

1. `gzip` the JSON payload with `CompressionStream('gzip')`. Typical bookmark JSON compresses 3–4×,
   which is what makes the `storage.sync` tier viable.
2. **Pad** the compressed bytes to a 256-byte boundary: prepend a 4-byte little-endian length, append
   zero bytes to the next multiple of 256. This coarsens the length side-channel — an observer sees
   "this bucket is 1.75 KB" instead of "this bucket contains exactly a 47-character URL".
3. `seal` with the purpose key.

Padded length is `ceil((4 + n) / 256) * 256`. A payload whose framed length already sits exactly on a
boundary gets no extra block: that case leaks "the length is a multiple of 256", which is a far
smaller signal than the bytes a whole spare block would cost across every bucket of a synced vault.
An empty payload still occupies one block, because the length prefix has to live somewhere.

Read reverses it. Padding is applied *after* compression because padding before compression would be
compressed away. `unpad` checks every structural expectation — a positive multiple of 256, a declared
length that fits — and treats a violation as corruption.

**Thumbnails are padded but not gzipped** (§14). A WebP is already entropy-coded, so deflating it
spends CPU to grow the payload by the size of a gzip header. The padding stays, because it is doing
different work: it is what keeps the stored length from being a fingerprint of the exact image.

### 4.5 Wiping

`src/crypto/wipe.ts` provides `zero(u8)` and a `Secret<T>` wrapper with `dispose()`. JavaScript gives
**no guarantee** that a value is unrecoverable from memory: strings are immutable and may be copied
by the GC, and `CryptoKey` internals are opaque. We therefore:

- keep raw key material in `Uint8Array`, never in `string`, wherever we control it
- zero those arrays on lock
- clear `chrome.storage.session` on lock
- never write key material to `storage.local` or `storage.sync`
- state the limitation plainly in `SECURITY.md` rather than implying a guarantee we cannot make

`Secret<T>` earns its place not by making bytes unrecoverable — it cannot — but by making a forgotten
release *visible*: a `Secret` still readable after `lock()` shows up in a diff, where a stray
`Uint8Array` in a module-scope variable does not. `dispose()` is idempotent, because MV3 races a lock
alarm against a user click as a matter of routine, and reading a disposed `Secret` throws rather than
handing back stale bytes. The default disposer zeroes a `Uint8Array` and does nothing else for
anything else; a `CryptoKey` has nothing we can reach into, and the code does not pretend otherwise.

### 4.6 Password policy

`src/crypto/password.ts` estimates strength from length, character-class variety, a bundled
~2,000-entry common-password list (compressed asset, no network), and repeat/sequence detection.
Hard minimum 10 characters. Below "good", the create-vault button stays enabled but requires a
second confirmation. We never block a user from their own choice; we make sure they made it knowingly.

The hard minimum is enforced in `VaultRepository.create()` and `changePassword()`, which throw
`WeakPasswordError` — not only in the UI. There is no recovery, so a vault created through some later
code path that forgot to check would be permanently weak, and the one place that cannot forget is the
one that writes the header. `passwordLength()` is the single definition of the count, so the floor and
the meter cannot disagree; it counts **code points**, which is why ten emoji are ten characters.

`estimateStrength(password)` returns `{ score: 0–4, bits, warnings, meetsMinimumLength, acceptable }`.
Warnings are **machine-readable codes** — `too-short`, `common-password`, `common-password-variant`,
`single-character-class`, `repeated-characters`, `sequential-characters`, `keyboard-pattern`,
`year-like` — never sentences: user-facing text belongs in `_locales`, and `src/` is where it must
not appear. Length is counted in code points, so ten emoji are ten characters. Pattern penalties are
multiplicative (a long passphrase that happens to contain "2024" is not punished like a short
password that is nothing but a pattern); a hit on the common-password list *caps* the estimate
instead, because a known password has no entropy worth the name whatever its character classes claim.

The list is checked case-insensitively and after leet substitution and trailing-digit stripping, so
`P@ssw0rd!!` is recognised as `password`. It ships as `src/crypto/data/common-passwords.ts` — the
newline-separated list, gzipped and base64url-encoded, decompressed lazily on the first call and
memoized — generated from the human-readable `src/crypto/data/common-passwords.txt` by
`scripts/gen-common-passwords.mjs`. The list is mechanically constructed from a curated core plus the
suffixes people actually append, **not** a breach dump: vendoring someone else's corpus of unclear
provenance into a GPL package, for a strength hint, is not a trade worth making. A test regenerates
the list and decompresses the shipped asset, so the three artefacts cannot drift apart.

---

## 5. Storage layout

### 5.1 `chrome.storage.local` — the working copy

| Key | Contents | Encrypted |
| --- | --- | --- |
| `vm.meta` | `VaultHeader` | no (by necessity) |
| `vm.buckets.<i>` | sealed bucket payload (single value, no part splitting locally) | yes (`k_items`) |
| `vm.base` | sealed merge base (item set as of the last successful sync) | yes (`k_items`) |
| `vm.baseMeta` | `{ lastSyncedRev, providerId, syncedAt }` | no (no content) |
| `vm.settings` | UI/behaviour settings: theme, idle timeout, provider id, toggles | no (no vault content) |
| — | *no key holds a bookmark's URL, host or title outside the sealed buckets* | — |
| `vm.thumbs.<itemId>` | sealed thumbnail bytes | yes (`k_thumbs`) |
| `vm.thumbsLru` | `{ itemId: lastViewedMs }` | no |
| `vm.conflicts` | sealed pending-conflict records | yes (`k_items`) |
| `vm.rollback` | sealed pre-replace-import snapshot (§11) | yes (`k_items`) |
| `vm.rollbackMeta` | `{ createdAt, expiresAt }` | no (no content) |
| `vm.onboarding` | `{ completedAt, step, incognitoSkipped }` (§12.5) | no (no content) |
| `vm.drive` | Drive linkage: mode, account address, folder/file ids, and the **sealed** refresh token (§13.2) | the token only (`k_items`) |

Every sealed value is stored as **base64url**, not as a `Uint8Array`. `chrome.storage.local`
JSON-serialises what it is given, so a byte array comes back as `{"0":12,"1":…}` — roughly five bytes
of quota per byte of ciphertext, and a silent shape change on the way out.

`vm.settings` holds `theme`, `idleTimeoutMinutes`, `providerId`, `lockOnBrowserBlur`,
`stripTrackingParams`, `reuseIncognitoWindow`, `clearHistoryOnLock`, `quickClose`,
`localThumbnails`, `thumbnailsOffered`, `sortBy` and the
manager's two column widths (`sidebarWidth`, `detailWidth`). It is deliberately plaintext and
deliberately incapable of holding vault content: the lock screen has to honour the theme, and the
auto-lock alarm has to be armed, before any key exists.

It is **half** of the settings, and the other half travels with the vault (§6.7). The preferences
that describe how the *vault* behaves — theme, idle timeout, lock-on-blur, the tracking strip, the
incognito-window reuse, the two history toggles and the sort order — are recorded inside the
ciphertext, so a second Chrome profile that adopts the synced vault arrives with them already set.
`sidebarWidth`, `detailWidth`, `providerId`, `localThumbnails` and `thumbnailsOffered` stay here and
only here, because a column width describes a screen, a provider id describes this profile's
connection, and "keep preview pictures on this device only" describes this computer's disk: a laptop
must not inherit a desktop's columns, a profile with no Drive token must not be told to use Drive,
and a machine that opted into local-only pictures has not opted the others in.

`sortBy` names one of six orders. Five are derived from a field of the item — date added, date
modified, title, recently opened, most opened — and the sixth, **`manual`** (Phase 12), reads
`item.order`, the fractional index the model has maintained since Phase 3 and which nothing
displayed until reordering arrived. That is what makes dragging a bookmark to a *position* mean
anything: under a derived order the list re-sorts itself on the next reload, so a drop between two
rows would be a gesture with no effect and no explanation. The manager therefore withdraws the
gesture rather than making it a no-op — reordering is offered only under `manual`, inside a folder,
with the search box empty, because order keys are unique within a parent and every cross-folder view
(a search, a tag filter, "Untagged") interleaves parents. The folder **tree** offers it
unconditionally: folders have always been in their own order and there is no sort selector over the
tree to disagree with. Keyboard equivalent throughout: **Alt+↑ / Alt+↓**, in both the list and the
tree. `manual` is deliberately not the default — a fresh vault has never been arranged, so it would
present the order things happened to be added in as a choice somebody made.

`sortBy` is one order for the whole manager rather than one per folder, and that is a privacy
decision rather than a simplification. A per-folder preference has to be keyed by folder id, and
this file is plaintext, so it would put a map of folder ids on disk — leaking how many folders a
vault has and which of them are used. Small, but exactly the shape INV-6 exists to keep out of
`storage.local`. The same reasoning rules out user-defined saved filters: a saved filter is a query
string the user composed out of their own bookmarks, and there is nowhere plaintext to keep one.
Reading it never throws — a corrupted blob falls back to defaults field by field, because a bad theme
value must not be able to keep someone out of their vault.

The column widths are the line that reasoning draws, seen from the other side: a width describes the
window, not what is in it, so it says nothing about the vault however carefully it is read. Both are
clamped into range on the way in *and* on the way out — a stored width is only as trustworthy as the
last thing that wrote it, and a column of −4,000 px is a manager that cannot be used again without
clearing storage by hand.

`clearHistoryOnLock` and `quickClose` (§12) are the two settings here that delete data *outside* the
vault, and both are off by default. They are booleans about behaviour: the domains they act on are
derived from the decrypted vault at the moment they run and never written down, which is what keeps
a feature whose whole subject is "which sites are in your vault" on the right side of INV-6.

`idleTimeoutMinutes` is in minutes, defaults to **10**, and **`0` means "never auto-lock"** — the
value the UI offers as *Never*. A negative or non-finite value is corruption and falls back to the
default. "Never" is not "stay unlocked forever": `chrome.storage.session` is memory-backed and clears
when the browser exits, so the vault still locks on restart (§5.5, D14).

`destroy()` enumerates every `vm.` key rather than deleting a fixed list. A key added by a later
phase and forgotten there would leave sealed vault content on disk after the user asked for it to be
gone, which is the one outcome `destroy()` exists to prevent.

**Destroying also removes the synced copy, by default** (maintainer-reported after Phase 11). For a
long time it did not, and the consequence was worse than an incomplete erase. The profile came back
offering to *adopt* the vault it had just been told to destroy (`adoptable` is a `peek()`, and the
sync area still held one), and a replacement created with the same master password could never open
those bytes — a new vault is a new random DEK, which is exactly what `create` means — so the two
deadlocked on `VaultMismatch` forever, on the one code path whose entire promise is that afterwards
there is nothing left.

`DESTROY_VAULT` therefore carries `deleteRemote`, defaulting to **true**, and the router clears the
backend **before** the local erase: on Drive the file ids and the sealed refresh token live under
`vm.drive` in `storage.local`, so the other order would leave an orphaned folder in the user's Drive
that nothing here could still find. The remote step is best-effort and never blocks the local one —
a destroy that could not be completed offline would be the wrong kind of safe — and the response
reports which of the three things happened (removed / left on purpose / could not be reached) so the
screen says a true sentence rather than a reassuring one. Unticking the box is offered for the case
it is actually for: another computer is still using the vault and its copy should survive.

`chrome.storage.local` has a ~10 MB quota unless `unlimitedStorage` is requested. We deliberately do
**not** request it: VaultaMark's permission set produces no install-time warning today, and we intend
to keep it that way.

**Decision:** 1.0 clamps the thumbnail cache to **8 MB**, evicting least-recently-viewed first. Drive
is the system of record for thumbnails; the local copy is only a cache, so eviction costs a re-fetch,
not data. If a future release adds `unlimitedStorage`, the cap becomes user-configurable
(25 / 100 / 500 MB).

### 5.2 `chrome.storage.sync` — the ChromeSyncProvider transport

| Key | Contents |
| --- | --- |
| `vm.s.meta` | `VaultHeader` (JSON, plaintext header — same as local) |
| `vm.s.b<i>.<p>` | part `p` of bucket `i`, base64url of the sealed bytes |

Chrome's documented limits:

| Limit | Value |
| --- | --- |
| `QUOTA_BYTES` | 102,400 |
| `QUOTA_BYTES_PER_ITEM` | 8,192 (key + JSON-stringified value) |
| `MAX_ITEMS` | 512 |
| `MAX_WRITE_OPERATIONS_PER_HOUR` | 1,800 |
| `MAX_WRITE_OPERATIONS_PER_MINUTE` | 120 |

Our budget: **7,600 characters of base64url per part**, leaving headroom for the key name and JSON
quoting. Write-rate governor caps us at **100 writes/minute and 1,400/hour**, well under Chrome's
limits, with an exponential-backoff queue when the budget is exhausted. A part is written only when
its bucket's plaintext HMAC tag changed.

### 5.3 Capacity math

Per bookmark, typical:

| Field | Bytes (JSON, uncompressed) |
| --- | --- |
| `id` (UUID) | 44 |
| `url` | ~70 |
| `title` | ~50 |
| `tags` (2 short tags) | ~25 |
| `note` (usually empty) | 0–200 |
| timestamps, `rev`, `order`, `type`, `parentId` | ~90 |
| **Total** | **~280 (no note), ~400 (with a short note)** |

gzip on a homogeneous array of such records reliably reaches 3.5–4× (shared keys, shared URL
prefixes). Call it **~75 bytes compressed per bookmark**.

base64url expands by 4/3, and padding adds ≤ 256 bytes per bucket. With 16 buckets:

```
usable sync bytes            = 102,400
  − header (vm.s.meta, 16 buckets)   ≈ 1,400
  − base64 overhead (÷ 1.333)        → 75,750 sealed bytes
  − per-bucket envelope (13 B × 16)  ≈ 208
  − padding waste (≤128 B avg × 16)  ≈ 2,048
  ≈ 73,500 bytes of compressed payload
  ÷ 75 bytes per bookmark
  ≈ 980 bookmarks
```

**Measured, Phase 7.** `test/integration/sync-capacity.test.ts` builds a fixture of plausible
bookmarks — varied hosts, varied slugs, a title of a few words, two short tags, no note — seals them
with the real codec and pushes them through the real provider into a mock enforcing Chrome's actual
limits, until the quota refuses another batch. It reaches **1,100 bookmarks** in ~100 KB, crossing the
70 % warning at ~800.

The derivation above is therefore conservative by about 12 %, which is the right direction to be
wrong in. The published numbers stay where they are:

**Documented ceilings:** ~600 bookmarks comfortable, ~1,000 hard. The gap between the measured 1,100
and the quoted 600 is deliberate and is not slack for its own sake — the fixture carries no notes, and
a note is up to 4 KB. A vault where one bookmark in ten has a paragraph attached hits the ceiling
several hundred bookmarks earlier, and the number a user is given has to be the one that holds for
their vault rather than for the fixture. **Warn at 70 % of `QUOTA_BYTES`, block new adds at 95 %** with
a "connect Drive" CTA.

Note also `MAX_ITEMS = 512`: at 7,600 chars/part, 512 parts would be 3.9 MB — the byte quota binds
first, so item count is never the limiting factor.

### 5.4 Bucketing

```
bucketOf(itemId, bucketCount) = SHA-256(itemId)[0..4] as big-endian uint32 % bucketCount
```

- Deterministic, so every device agrees without coordination.
- Uniform, so buckets stay balanced without rebalancing logic for normal growth.
- Independent of item content, so renaming a bookmark never moves it between buckets.

Items are sorted by id **inside** a bucket, so the same item set always serialises to the same bytes
— which is what the header's integrity tag depends on (§3.1).

`bucketCount` starts at 16 and doubles when the largest bucket exceeds 60 % of the per-part budget ×
parts, which in practice means a full rewrite roughly once per 1,000 items. A rebalance is a single
atomic commit that bumps `vaultRev` and rewrites everything; it is rare and is treated as a normal
(if large) sync push.

### 5.4.1 Writing: dirty tracking and ordering

`VaultRepository` keeps an item-id → bucket-index map (a SHA-256 per id, cached because it never
changes for an id) and a dirty set. A mutation marks the buckets its changed items belong to; a
300 ms coalescer then re-seals **only those** buckets, so a burst of edits is one write rather than
one per keystroke. An edit that changes nothing returns no changed items, marks nothing dirty, and
costs no write — otherwise a no-op would spend one of the 120 writes a minute buys and manufacture a
merge conflict out of nothing.

**Buckets are written before the header, always.** A crash between the two leaves a header pointing
at the previous revision of a bucket that has already been superseded, which the integrity tag
detects; the other order leaves a header pointing at buckets that do not exist. A write that fails
leaves its buckets dirty rather than dropping them, so the next flush retries instead of leaving
`storage.local` a revision behind permanently.

`lock()` flushes pending writes first by default — losing the last thing a user typed to a lock timer
is a bug, not a security feature. Panic-lock (Phase 4) passes `flush: false`, where being immediate
is the whole point.

### 5.5 `chrome.storage.session` — key custody

```jsonc
{
  "vm.session": { "dek": "<base64url 32B>", "unlockedUntil": 1750000600000, "providerId": "chrome" },
  // Hosts queued for the Phase-9 history cleanup by the normal-window fallback (§9). Vault-derived,
  // so memory-backed by necessity rather than by convenience — see INV-6.
  "vm.historyQueue": ["example.com"],
  // The Drive access token (§13.2). A credential, so it gets the DEK's custody rather than a place
  // on disk. `storage.local` holds the *sealed* refresh token; this holds the short-lived one.
  "vm.driveToken": { "token": "<opaque>", "expiresAt": 1750003600000 },
  // When the last freshness probe ran (§13.4). Here rather than in a module variable because the
  // module variable is what is being defended against: MV3 tears the worker down every ~30 s, so a
  // module-scope timestamp would reset as often as the events it is coalescing arrive.
  "vm.probedAt": 1750000550000
}
```

Everything in this area is written **only while the vault is unlocked**, and INV-7 is "empty after
`lock()`", not "our key is gone": `lock()` calls `clear()`. That is also why the probe writes
nothing when the vault is locked — a timestamp arriving a few seconds after a lock would put a key
back into an area whose emptiness is the invariant.

`chrome.storage.session` is memory-backed, cleared when the browser exits, and (with the default
access level) unreachable from content scripts. We additionally call
`chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` at startup to make that
explicit rather than implicit.

This is a deliberate weakening relative to "the key exists only in a service-worker local variable",
and the reason is §7: MV3 kills the worker after ~30 seconds of inactivity, so a memory-only key
means a password prompt every few minutes. The tradeoff is documented in the threat model, in
`SECURITY.md`, and in the Settings UI.

---

## 6. Sync and merge

### 6.1 The `SyncProvider` interface

```ts
export interface RemoteStamp {
  vaultRev: number;
  contentHash: string;      // md5Checksum (Drive) or a hash of vm.s.meta (chrome)
  modifiedAt: number;
}

export interface SyncProvider {
  readonly id: 'chrome' | 'drive';
  readonly capabilities: { heavyTier: boolean; maxLightBytes: number };

  init(): Promise<void>;
  /** Metadata-only freshness probe. MUST NOT download the payload. */
  peek(): Promise<RemoteStamp | null>;
  pullLight(): Promise<EncryptedVault | null>;
  /** Compare-and-swap: fails with PreconditionFailed if the remote moved past `expect`. */
  pushLight(v: EncryptedVault, expect: RemoteStamp | null): Promise<RemoteStamp>;

  getThumb(itemId: string): Promise<Uint8Array | null>;
  putThumb(itemId: string, blob: Uint8Array): Promise<void>;
  deleteThumb(itemId: string): Promise<void>;

  usage(): Promise<{ usedBytes: number; quotaBytes: number }>;
  disconnect(): Promise<void>;
}
```

`EncryptedVault` is `{ header: VaultHeader; buckets: Map<number, Uint8Array> }` — the provider moves
ciphertext and never sees a key. Providers that lack a heavy tier throw `HeavyTierUnsupported` from
the thumb methods; callers check `capabilities.heavyTier` first.

Error taxonomy: `QuotaExceeded`, `RateLimited(retryAfterMs)`, `PreconditionFailed(currentStamp)`,
`Offline`, `AuthRequired`, `HeavyTierUnsupported`, `CorruptRemote`.

### 6.2 Revisions and lineage

| Field | Where | Meaning |
| --- | --- | --- |
| `item.rev` | per item | the `vaultRev` at which this item last changed |
| `item.updatedAt` | per item | wall-clock ms, used only for display and as a tiebreaker |
| `header.vaultRev` | per vault | monotonic counter, incremented on every committed local change |
| `vm.baseMeta.lastSyncedRev` | local only | the `vaultRev` of the last state successfully synced |
| `vm.baseMeta.remoteHash` | local only | `contentHash` of the remote stamp the base was written against |
| `vm.base` | local only | the encrypted item set as of `lastSyncedRev` — the merge base |

Wall clocks are never trusted for correctness. `updatedAt` breaks ties in the UI ("which looks newer")
but every merge decision is made from the base comparison, not from timestamps.

`remoteHash` exists because `lastSyncedRev` alone cannot answer *has the remote moved?*. Two devices
can both reach revision 7 with entirely different contents, and a revision number that matched would
wave a genuinely divergent remote straight past the merge. The hash is over the remote **header**,
which already carries every bucket's tag, so comparing it costs one `peek()` and no decryption.

### 6.3 The sync state machine

```
        local change (debounced 3 s)
        storage.onChanged from another device      ← this is the whole of "zero configuration":
        chrome.runtime.onStartup / SW wake            Chrome replicates the area and tells us
        manual "Sync now"                             nothing to poll, nothing to set up
                 │
                 ▼
    ┌────────► IDLE
    │            │  trigger (single-flight; concurrent triggers coalesce,
    │            │           one that lands mid-run earns exactly one re-run)
    │            ▼
    │         PEEKING ── provider.peek() ──┐
    │            │                          │ remote is null (first sync)
    │            ▼                          ▼
    │   remoteHash unchanged?           PUSHING (create remote)
    │       │yes          │no
    │       ▼             ▼
    │  vaultRev moved?  PULLING ─► MERGING ─► outbound == remote?
    │   │no      │yes      │                    │yes            │no
    │   ▼        ▼         │                    ▼               ▼
    │  IDLE   PUSHING ─────┘             adopt remote rev    PUSHING
    │           │PreconditionFailed        (push nothing)       │
    │           └──────────────────────────────────────────► set base
    │                                                            │
    └────────────────────────────────────────────────────────► IDLE
                                    conflicts pending ⇒ CONFLICT
                                    (banner; the vault stays usable and
                                     everything else keeps syncing)
```

Every transition is restartable: the service worker can die at any point and the next trigger
re-derives the correct state from `vm.baseMeta`, the local buckets, and a fresh `peek()`. Nothing is
remembered in a module variable that matters.

**The order of writes is the part that survives a crash.** The merged vault is written locally first,
because it is the one copy nobody else can reconstruct. Conflicts are persisted next, before anything
is pushed, so a crash cannot lose the record of a disagreement while pushing the resolution of it.
Then the push, **buckets first, header last**, so a crash mid-push leaves a remote whose header still
points at the old revision — the new bucket bytes are unreferenced and are overwritten by the next
push. The merge base is written **last, and only after the push succeeded**, because the base means
exactly one thing — *this is what the remote has* — and writing it earlier would be a lie the next
merge believes.

**A torn remote is repaired, not merged.** A puller whose bucket bytes do not match the tags in the
header it read has found a push that was interrupted, and raises `CorruptRemote`. The engine's answer
is to push its own copy over it. That loses nothing: a torn remote is by definition a *partial* copy
of some device's local state, and that device still has all of it and will push again.

### 6.4 The merge algorithm

`merge(base, local, remote) → { merged, conflicts }` — a pure function over three item maps keyed by
`id`. For each id in `base ∪ local ∪ remote`:

| base | local | remote | Result |
| --- | --- | --- | --- |
| — | present | — | take local (added locally) |
| — | — | present | take remote (added remotely) |
| — | present | present, equal | take either |
| — | present | present, differ | **conflict** (concurrent add of the same id — only possible after an import; keep both is offered) |
| present | present, unchanged | present, unchanged | take base |
| present | changed | unchanged | take local |
| present | unchanged | changed | take remote |
| present | tombstone | unchanged | delete |
| present | unchanged | tombstone | delete |
| present | tombstone | tombstone | delete |
| present | changed | tombstone | **conflict** (edit vs delete — never silently discard an edit) |
| present | tombstone | changed | **conflict** |
| present | changed | changed, **disjoint fields** | field-wise merge |
| present | changed | changed, **same field differs** | **conflict** on that field |

Field-level rules for the "both changed" case:

- **Scalar fields** (`title`, `url`, `note`, `parentId`, `order`): if only one side differs from base,
  take that side. If both differ and they are unequal → conflict on that field.
- **`tags`**: set union of (local ∪ remote), minus tags removed on either side relative to base.
  Deliberately biased toward keeping data; documented, never a conflict.
- **`thumb`**: the side with the newer `at` wins; no conflict (a thumbnail is derived data).
- **`og`**: same rule as `thumb` — derived from a page rather than typed by a person, so the side
  that changed it wins and two changed sides are settled by canonical byte order. Never a conflict.
- **`openedAt` / `openCount`**: `max` / `max`; never a conflict. Opening a bookmark is deliberately
  **not** an edit: a device that opened an item while another deleted it must not produce a prompt.
- **`createdAt`**: `min`. An item cannot have been created twice; the later stamp belongs to whichever
  device learned about it second.
- **`updatedAt`**: `max` of the merged sides.
- **`rev`**: `max(local.rev, remote.rev)`.

Resulting `vaultRev = max(local.vaultRev, remote.vaultRev) + 1`.

> **`rev` was specified as "the new `vaultRev`" and had to change.** The new `vaultRev` is computed
> *on the device doing the merge, at the moment it merges*, and `rev` lives inside the ciphertext —
> so two devices merging the same pair of vaults minutes apart stamp different numbers, their bucket
> plaintexts differ, their tags differ, and each sees the other as changed forever. That directly
> contradicts the convergence property below. `max` of the two sides is symmetric, deterministic and
> says the same thing about when the item last moved. Found by the order-independence property test,
> not by reading.

**Two things the merge does that the table above does not describe.**

*Purges.* An id present in the base and **absent** from a side was purged there — its tombstone aged
past the 90-day TTL and was dropped (D20). The purge propagates when the other side agrees the item is
gone, and is overruled when the other side has since changed it: a restore, or an edit from a device
that was offline for three months. A change outranks a purge.

*Reattachment.* Two independently legal edits can produce an illegal tree — a folder deleted here
while a bookmark was added to it there, or `A` moved into `B` on one device while `B` moved into `A`
on the other. Neither is a conflict, because nobody disagreed about anything, but both leave live
items that no folder listing can reach, and an item nobody can find is lost as surely as one that was
dropped. After merging, any live item whose parent chain does not end at the root is reattached to the
top level — the minimum number of links, so a placement the user *did* ask for is not discarded.

**Properties (property-tested in Phase 7, over 200 seeded random scenarios each):**

- *No loss*: every id present and non-tombstoned in `local` or `remote` appears in `merged` or in
  `conflicts`, unless it was in the base and the other side deleted or purged it. Nothing is dropped
  that somebody did not ask to drop.
- *Idempotent*: `merge(m, m, m) = m`, changing nothing and therefore costing no bucket write.
- *Order-independent*: `merge(b, l, r)` and `merge(b, r, l)` produce the same conflict set with `mine`
  and `theirs` swapped, and agree on every item that is not conflicted. They deliberately **differ**
  on the conflicted items, because each run provisionally keeps its own side (§6.5) — and on those
  items' descendants, which are reattached differently when the two sides disagree about a folder.
- *Convergent*: after both devices sync twice with no further local edits, their **bucket tag tables**
  are identical. Not their ciphertext: every seal draws a fresh IV, so two devices holding the same
  bookmarks hold entirely different bytes. The tag is an HMAC over each bucket's canonical plaintext,
  so equal tags mean equal contents — and it is the same comparison the provider uses to decide
  whether a bucket needs writing at all.

**What makes it terminate.** A merge that ends in a push at a fresh revision would be seen by the
other device as a moved remote, merged, and pushed back at a fresher one, forever, without a single
bookmark changing. So after merging, the engine compares the item set it was about to send against the
one it just pulled; if they are the same, it adopts the remote's `vaultRev` verbatim and pushes
nothing. That comparison is the reason two peers ever agree they are done.

### 6.5 Conflicts

Conflicts are persisted to `vm.conflicts` (encrypted) and surfaced in a dedicated manager view. Until
a conflict is resolved:

- the merged vault (with the **local** side provisionally applied for conflicted fields) is fully
  usable
- a persistent, non-blocking banner shows the count
- **nothing is pushed** for the conflicted items — the rest of the vault continues to sync normally

**How "nothing is pushed for the conflicted items" is implemented.** Everything the engine sends is
the local vault put through `outboundView`: the item set with the **remote** side restored for every
unresolved conflict. The merge base is written from the same view. So a push cannot overwrite the
other device's answer, the base honestly records what the remote holds, and the rest of the vault
travels normally in the same push. Locally the item still shows this device's version, which is what
keeps the vault usable while the banner is up.

Resolution offers, per conflict: *keep mine*, *keep theirs*, *keep both* (duplicates the item with a
new id and a `(conflicted copy)` title suffix), plus batch versions of each. *Keep both* is withheld
when one side is a deletion — keeping both would mean keeping a deletion. Resolving builds the same
mutations the manager would build if a person had typed the answer, applies them, and drops the
record; the item then rejoins the outbound view and is pushed.

*Keep mine* changes no bookmark at all — the item already holds this device's version, and the only
thing that moved is the record that was keeping it out of the outbound view. The sync that follows a
resolution is therefore forced rather than conditional, or the engine would see an unchanged
`vaultRev`, conclude there was nothing to send, and leave the resolution on one device.

**Only the device that discovered the divergence is prompted.** The other one sees its own version
still on the remote and has nothing to decide. Resolving on both sides is possible — if each device
edited the same bookmark again in the meantime — and simply raises the disagreement again rather than
silently overwriting one of them. Each round strictly reduces the disagreement, so it terminates.

### 6.5.1 Joining from a second device

A profile with no vault of its own but a vault in the sync area is a **second computer**, not a
first one, and it is offered the master password rather than the create form.

Everything needed is already in the header the first device pushed: the KDF salt and the wrapped
DEK (§3.1). So the whole of the setup is the password the user already knows — nothing is exported,
copied, scanned or typed in beyond that. `session.state()` reports `adoptable` from a single
`peek()`, asked only when there is no local vault; `UNLOCK` then routes to adoption instead of a
local unlock, because from where the person is standing the two are the same act.

`repo.adopt(vault, password)` derives the KEK from the *pulled* header, unwraps the DEK and decrypts
every bucket **before writing anything**. A wrong password throws `WrongPasswordError` and leaves
the profile exactly as empty as it was; writing the header first and validating second would leave a
half-adopted vault behind every typo. `deviceId` is regenerated rather than inherited — it is the one
header field that describes the install rather than the vault, and two devices claiming to be the
same one would mislabel every side of every future conflict.

The merge base is written as the last step, from the adopted item set at the remote's `vaultRev`.
Without it the first sync after joining would find no base, read every item as a local add, and push
the whole vault straight back at the device it came from.

**Two vaults, one sync area.** Someone can decline to join and create a separate vault instead; the
create screen says plainly that it will not sync with the one already there. If they do, the next
sync pulls a vault whose ciphertext will not open under this device's key, and that is reported as
`VaultMismatch` rather than as corruption. Nothing is damaged and nothing is overwritten — the
mismatch is detected in `openEncrypted`, before anything is pushed — but the two cannot be merged.

**It is not evidence of a different password**, and the UI must not say that it is (it did, until
the second post-Phase-11 pass). A vault created a second time is a *new vault* whatever it was given
to open it: `create()` draws a fresh random DEK, so the wrapped key in the sync area was never
derivable from this profile's typing. The likeliest way to land here is therefore not two people and
two passwords, it is **one person whose `storage.local` went away** — a reinstall, a cleared profile,
an extension id that changed with a build variant — who typed the same password into a new vault and
cannot understand why sync refuses it.

**Saying so is not enough, and for a while that was all we did** (maintainer-reported after
Phase 11). The status line named the problem correctly and offered nothing to do about it — and
because the toolbar's sync status *is* the Sync-now button, the one thing on screen anybody could
click re-ran the merge that cannot work and appeared to do nothing at all. It is not a failure with
a cause to fix; it is a **question with two right answers**, and which one is right is not something
the extension can know. Settings → Sync carries both, neither preselected and neither on one press:

- **"Overwrite the synced copy with this vault"** (`REPLACE_REMOTE_VAULT`): delete the remote, drop
  `vm.baseMeta` — after a deletion the base is a lie, and a merge that believes it would read the
  next thing to appear there as a mass deletion — and push this vault with `force`. Gated on a
  second press, like destroying a vault is, because it discards another vault's only synced copy.
- **"Use the synced vault on this computer"** (`ADOPT_REMOTE_VAULT`, added in the same pass): pull
  it, and `VaultRepository.adoptOver` derives the KEK from the **pulled** header, unwraps the DEK and
  decrypts every bucket *before* `clearVault()` removes anything. A wrong password, a truncated pull
  or a tag that does not verify therefore costs nothing at all: the old DEK is still in
  `storage.session`, so the next read rebuilds the vault that is still on disk. It is refused while
  locked, and that is a gate rather than plumbing — knowing some *other* vault's password must not
  be a way to erase this one. The merge base is recorded exactly as an adoption from an empty
  profile records it, and the erase takes `vm.settings` with everything else, so the backend is
  written back before the session starts and the Drive record is put back minus its refresh token
  (that token is sealed under the departed vault's `k_items` and is noise now — §13.2).

Neither is ever something the engine decides on its own, at any confidence.

### 6.6 Provider migration

**chrome → drive**
1. Authorize (`drive.file`), create `/VaultaMark/`, upload the current light tier, set
   `appProperties.vmRev`. A folder that **already holds a vault** is adopted rather than overwritten
   when it opens under this device's key — that is a second computer reconnecting, and uploading
   over it would destroy what the first one had. One that does not open is reported as
   `VaultMismatch` and nothing is touched.

   That refusal has the same two answers §6.5 gives, reachable from the screen that reported it —
   and it needs its own wiring for both, because the migration refuses *before* flipping anything.
   `providerId` is still `chrome` at that point, so "overwrite the synced copy" would clear Chrome
   sync and never touch the Drive folder in question: taking the folder over is `CONNECT_DRIVE`
   again with `replaceExisting`, which deletes what is there and pushes against an empty backend
   (a compare-and-swap against the stamp of a file that has just been deleted would fail its own
   precondition), with the verification and the flip still attached. Joining the Drive vault
   instead is `ADOPT_REMOTE_VAULT` with `from: 'drive'` — named explicitly for the same reason.
   Without these, a Drive folder holding another vault was the one state a second computer could
   not get out of at all: adoption from an empty profile reads the backend out of `vm.settings`,
   which is `chrome` until a migration succeeds.
2. Verify: `peek()` returns the expected stamp; `pullLight()` round-trips to an identical item set.
3. Flip `vm.settings.providerId = 'drive'` and rewrite `vm.baseMeta` — the spec said *reset*, and
   writing the base we have just verified is the same thing one round trip earlier: the next sync
   would otherwise read every item as a local add and push the whole vault straight back.
4. Offer to clear the `chrome.storage.sync` copy (default: yes, after a successful verify) so other
   devices do not keep two systems of record. Devices still on the old version will see the sync copy
   vanish; they are told to connect Drive. **This is why the flip is a deliberate, explained action,
   not a silent optimization.**
5. Start capturing thumbnails from the next add.

**drive → chrome**
1. Compute the light tier's projected `storage.sync` size. If it exceeds 95 % of quota, **refuse**
   with a message naming the number of bookmarks that would fit and offering to export first.
2. Push to `storage.sync`, verify, flip `providerId`, reset the base.
3. Keep existing thumbnails in the local cache but stop syncing them; warn that other devices will
   lose access to previews.
4. Leave the Drive files untouched unless the user explicitly asks to delete them.

Rollback: if verification fails at any point, the original provider stays active and nothing is
flipped.

### 6.7 Settings that travel

`vm.settings` is two halves. The per-device half stays in `storage.local` (§5.1); the rest is a
record inside bucket 0's payload (§3.2), and therefore inside the ciphertext, and therefore wherever
the vault is.

```ts
type SyncedSettings = { [field]?: { v: string | number | boolean; at: number } };
```

**Why encrypted, when a theme is not vault content.** Because `chrome.storage.sync` is replicated by
Google whatever it holds, and "which of our users leaves the vault unlocked forever" is not a fact
worth publishing in the clear when encrypting it is free.

**What travels:** `theme`, `idleTimeoutMinutes`, `lockOnBrowserBlur`, `stripTrackingParams`,
`reuseIncognitoWindow`, `clearHistoryOnLock`, `quickClose`, `sortBy`.
**What does not:** `sidebarWidth`, `detailWidth`, `providerId` — a screen and a connection, not a
vault.

**Merge rules.** Last writer wins **per field**, on the field's own `at`; never a conflict, and no
UI. Two devices disagreeing about a theme is not a disagreement worth interrupting anybody over, and
per-field means a device changing the sort order cannot silently revert another's idle timeout. A
tie — equal `at`, different values — is broken by comparing the *values*, because the merge runs on
whichever device noticed the divergence first and an order-dependent answer is exactly how two peers
trade revisions forever (the same trap §6.4 documents for `item.rev`).

**A field nobody has ever changed stays out of the record.** This is the part that is easy to get
wrong: stamping all eight fields on the first edit makes that device claim seven defaults it never
chose, at a timestamp that then beats another device's real change. An absent field defers to
whichever device has an opinion, which is what an untouched preference should do.

The record is written only while the vault is unlocked, so the vault is the authority and
`repo.adopt` carries it across — which is what makes a second computer arrive with its settings
rather than with the defaults.

---

## 7. Service-worker lifecycle

MV3 service workers are terminated after ~30 seconds of inactivity (and on browser idle, and on
crash). Everything must survive that.

### 7.1 What survives, and how

| State | Survives SW death? | Mechanism |
| --- | --- | --- |
| Vault ciphertext | yes | `chrome.storage.local` |
| Unlocked DEK | **yes, until the idle timeout or browser exit** | `chrome.storage.session` (memory-only) |
| Decrypted item set | no | re-decrypted on demand; ~50 ms for 1,000 items |
| Search index | no | rebuilt lazily on first search after a wake |
| Auto-lock deadline | yes | `unlockedUntil` in `storage.session` + a `chrome.alarms` alarm |
| Sync state | yes | derived from `vm.baseMeta` + local buckets + a fresh `peek()` |
| In-flight sync | no | restartable by design (§6.3) |

**Why not memory-only keys.** A memory-only DEK dies with the worker, i.e. roughly every 30 seconds
of inactivity, which means a password prompt every time the user opens the popup. That is not a
security posture, it is an abandoned product. `chrome.storage.session` is the platform's answer:
memory-backed, never written to disk, cleared on browser exit, and restricted to trusted contexts.
We combine it with a real idle timeout (default 10 min), an explicit lock command, lock-on-blur as an
option, and "require password after browser restart" (free — session storage clears anyway).

**Lock-on-blur is off by default**, and its name in the UI matters more than it looks. It fires on
`WINDOW_ID_NONE` — no Chrome window has focus at all — which means *every switch to another
application*, not "when Chrome closes". At 600,000 PBKDF2 iterations that is a password prompt per
alt-tab: a defensible posture to offer, a bad one to impose, and a worse one to imply with a label
like "lock when I leave Chrome". The UI says "switch to another app" and spells out the consequence
next to the toggle.

Focus moving *between* Chrome windows must never lock, or opening a bookmark in incognito (§9) would
lock the vault behind it.

### 7.2 Cold-start budget

The SW entry does only: register listeners, read `vm.settings` (small), and return. Key derivation,
decryption, index building, and provider init are all lazy and triggered by the first message that
needs them. Budget: **< 50 ms** from cold start to the first handled message. Enforced by a test with
a stubbed clock and by the Phase-12 budget script.

### 7.3 Alarms

`chrome.alarms` has a 30-second minimum period for unpacked extensions and 1 minute for packed ones
in some Chrome versions; we therefore never rely on alarm precision for security. The alarm is a
*convenience* that locks proactively; the *authority* is the `unlockedUntil` check performed on every
session rehydrate. An attacker who suppresses alarms still cannot use an expired session.

| Alarm | When | What it does |
| --- | --- | --- |
| `vm.autolock` | armed at `unlockedUntil`, floored at 30 s, cleared on lock and for a "never" session | re-checks `unlockedUntil`: locks if it has passed, **re-arms if it has not** |
| `vm.housekeeping` | every 12 h, armed once per worker start if not already armed | purges tombstones past the 90-day TTL (D20), only while unlocked |

`vm.autolock` re-arms rather than locking on an early fire, because Chrome clamping a short delay is
routine and locking a still-valid session would be a bug the user experiences as random logouts.
`vm.housekeeping` is checked before it is created: `chrome.alarms.create` with an existing name resets
the schedule, so recreating it on every worker start would produce a periodic alarm that never fires
on a profile the user touches often.

---

## 8. Threat model

> **[docs/THREAT_MODEL.md](THREAT_MODEL.md) is the expanded version**, written in Phase 12: the
> assets in priority order, the same adversary and out-of-scope tables with their reasoning, and —
> the part that is not here — a security self-review checklist in which every claim is traced to
> the code or test that keeps it true. This section stays as the normative summary; where the two
> disagree, that file is newer.

### 8.1 In scope — what VaultaMark defends against

| Adversary / scenario | Defence |
| --- | --- |
| Someone using your unlocked computer, typing in the address bar | Vault items are never in `chrome.bookmarks` or `chrome.history`, so they cannot autocomplete. History cleanup closes the "you visited it once" path. |
| Someone browsing your Chrome profile directory or a backup of it | Everything but the header is AES-256-GCM ciphertext. |
| Someone reading your `chrome.storage.sync` data through another device on your Google account | Same — the synced blob is ciphertext. |
| Google, or anyone with access to your Drive | The Drive file is ciphertext; we never transmit the password or the key. |
| A stolen exported backup file | `.vmv` is independently encrypted with its own KDF header. |
| A shoulder-surfer seeing your open browser | Auto-lock, panic lock, lock-on-blur. |
| Casual inspection of what you opened | Incognito-only opening leaves no history or cache entry. |
| A network observer | No network traffic at all unless Drive sync is on; then only TLS to `googleapis.com`. |

### 8.2 Out of scope — what it does not defend against

| Scenario | Why not |
| --- | --- |
| Compromised OS, malware, or a keylogger | The password is typed into that machine. Nothing in a browser extension survives this. |
| An attacker at your unlocked, unlocked-vault machine | By definition they have what you have. Mitigate with a short idle timeout. |
| Another extension with `debugger` permission or devtools access to our pages | Chrome's extension model does not isolate us from that. |
| A weak master password + an attacker with your ciphertext | 600k PBKDF2 iterations raise the cost per guess but cannot rescue "password1". We show a strength meter and enforce a 10-char floor. |
| Traffic analysis of Drive API calls | Reveals *that* you use VaultaMark and roughly how much and how often you change it. Not the contents. |
| The existence of the vault | The plaintext header is detectable on the device. Plausible deniability is a non-goal (backlog B4 explores a hidden second vault). |
| Chrome's own URL-prediction service suggesting a URL you typed manually | Outside our reach, and not something we can switch off or verify. Stated in `docs/PRIVACY.md`; no longer claimed as a setup step (§12.4). |
| Memory forensics on a running browser with the vault unlocked | The DEK is in `storage.session` and in JS heap. JS cannot guarantee erasure. |

### 8.3 Accepted, documented leaks

1. **Plaintext header** — reveals that a vault exists, its creation/modification times, its revision
   count, and a coarse size signal (bucket count). Unavoidable: KDF parameters must be readable
   before the key exists.
2. **Ciphertext length** — mitigated by 256-byte padding, not eliminated.
3. **Drive file metadata** — name, size, timestamps, and the fact of syncing are visible to Google
   and to anyone with Drive access.
4. **Favicon cache** — `_favicon/` reads Chrome's local favicon cache, which is populated by normal
   browsing. It does not *create* an entry, so it does not leak; but a vaulted domain you have never
   visited simply shows a generic icon.
5. **The OG image fetch at add-time** — the page's own origin serves the image to the page's own
   context. No new party learns anything, but the origin sees one more request from a browser that
   was already loading the page.

### 8.4 Non-negotiable invariants

Restated from [PLAN.md §4](../PLAN.md#4-hard-invariants) and enforced in CI: no remote code, strict
CSP, no absolute URLs outside the allowlist, zero network traffic when Drive is off, no
`chrome.bookmarks` for storage, no plaintext in any store, nothing left behind on lock, no telemetry,
no silent permission growth.

---

## 9. Incognito opening

Implemented in `src/background/incognito.ts`; `src/background/items.ts` supplies the settings and
records the open.

```ts
export async function openVaulted(url: string, options: OpenOptions = {}): Promise<OpenStatus> {
  if (await isAllowedIncognitoAccess()) {
    if (options.reuseWindow === true) {
      const existing = await findIncognitoWindow();          // windows.getAll, first incognito one
      if (existing !== undefined) {
        await chrome.tabs.create({ windowId: existing, url, active: true });
        await focusWindow(existing);                          // best-effort; the tab is open either way
        return 'incognito';
      }
    }
    await chrome.windows.create({ incognito: true, url, focused: true });
    return 'incognito';
  }
  if (options.force !== true) return 'needs-incognito-access';  // UI shows the guided prompt
  return (await chrome.windows.create({ url, focused: true }), 'normal');  // explicit fallback only
}
```

The open counter (`openedAt`, `openCount`) is bumped only when something actually opened, so the
guided prompt is not a click that silently edits the vault.

**The guided prompt.** Chrome does not allow an extension to navigate to `chrome://extensions`
programmatically, and there is no API to request incognito access. So the prompt:

1. explains in one sentence what "Allow in Incognito" does and why VaultaMark needs it
2. shows `chrome://extensions/?id=<our id>` with a **Copy** button and "paste this in your address bar"
3. illustrates the toggle's location in words plus a bundled screenshot asset (words only until the
   store assets land in Phase 13)
4. offers **Re-check** (calls `isAllowedIncognitoAccess()` again and updates live)
5. offers the fallback: *Open in a normal window this once* — with a plain warning that the visit
   will be recorded in history, plus an opt-in checkbox to queue a history cleanup for that domain
   afterwards (Phase 9)

It lives on the **manager page** (`manager.html#incognito=<itemId>`, built by
`src/ui/incognito-prompt.ts`) rather than in the popup, because step 2 asks the user to click into
the address bar and a popup closes the moment they do. The address is a `<code>` with a Copy button,
not a link: Chrome refuses to follow an `<a href="chrome://…">` from an extension page, and a dead
link is a worse instruction than a string that can be copied.

The **history-cleanup queue** (`vm.historyQueue`) lives in `chrome.storage.session`, not in
`storage.local`. The host of a vaulted URL is vault content, and INV-6 says vault content does not
reach disk in the clear — so the queue is memory-backed, restricted to trusted contexts, and emptied
by `session.lock()` along with the key. The cost is that locking before Phase 9 drains it drops the
queue, which is the right way round to be wrong.

`incognito: "spanning"` in the manifest means one shared service worker across normal and incognito
windows, so an unlocked vault stays unlocked when the incognito window opens. With `"split"` we would
get a second, independently-locked instance — worse in every way for this product.

The access result is cached in a service-worker module variable and invalidated on every explicit
re-check and on `lock()`. It is deliberately **not** invalidated on `chrome.management.onEnabled`:
that event needs the `management` permission, which would add an install-time warning for a checkbox
MV3 already re-reads for free every ~30 seconds when the worker restarts.

---

## 10. Favicons

```ts
export function faviconUrl(pageUrl: string, size = 32): string {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.toString();
}
```

Requires the `favicon` permission (which produces no user-facing permission warning). This reads
**Chrome's local favicon cache** — no network request, no third party. Using
`https://www.google.com/s2/favicons?domain=…` or any similar service would send every vaulted domain
to a third party on every render, which would defeat the product's entire premise. It is banned by
the URL allowlist scanner.

`size` is what we ask Chrome for, not what is rendered: the row is 16 px and the request is 32, so a
2× display gets a sharp icon.

Fallback when the cache has no entry (Chrome returns a generic globe): a letter avatar generated
from the first character of the host, coloured by a hash of it (FNV-1a → hue, fixed 55 %/42 % so
every hue clears 4.5:1 against white text). Purely local, deterministic, no network.

It is a **styled `<span>`**, not an inline `<svg>` and not a `data:` URL. `<svg>` would need
`createElementNS('http://www.w3.org/2000/svg', …)`, and a `data:` URI is a string shaped exactly like
what `verify-no-remote-code.mjs` exists to find — both would mean arguing with an invariant scanner
over a decoration. The colour goes on through CSSOM, which no CSP directive touches; `.vm-avatar` in
`ui/styles.css` owns the geometry, so the fallback and a real favicon are the same size by
construction.

---

## 11. Portable file format

`.vmv` — the encrypted export/backup container. Self-describing so it can be decrypted by any future
version, and independent of the vault's own KDF parameters (the export password may differ).

```jsonc
{
  "magic": "VAULTAMARK-EXPORT",
  "formatVersion": 1,
  "schemaVersion": 2,                 // the vault schema inside
  "createdAt": 1750000000000,
  "createdBy": "VaultaMark 1.0.0",
  "kdf": { "alg": "PBKDF2-HMAC-SHA256", "iterations": 600000, "salt": "<b64url 32B>" },
  "wrappedKey": { "iv": "<b64url 12B>", "ct": "<b64url 48B>" },   // AES-256-GCM(KEK, exportKey)
  "includesThumbs": false,
  "payload": "<b64url of seal(k_items, gzip(pad(JSON)), aad{v:formatVersion,purpose:'export',id:''})>",
  "thumbs": { "<itemId>": "<b64url sealed>" }    // present only when includesThumbs
}
```

**`wrappedKey` mirrors the vault's own two-level hierarchy (§4.1), and it is what makes the two
failure modes distinguishable.** The container holds a random 32-byte export key wrapped under the
KEK derived from the export password; the payload is sealed under `HKDF(exportKey, 'items')`. A wrong
password therefore fails on 48 authenticated bytes and reports `WrongPasswordError`, while anything
that fails *after* the wrap has opened can only be damage and reports `CorruptVaultError`. Sealing
the payload directly under the KEK would collapse both into one indistinguishable GCM failure — and
"your password is wrong" and "this backup is damaged" send a user down entirely different roads, one
of which ends with a good backup being deleted. It costs 64 bytes.

**The AAD binds `formatVersion`, not `SCHEMA_VERSION`.** A payload sealed under the writing build's
vault schema would stop opening the day that schema moved on, in a format whose entire purpose is to
still open then. This is why `src/io/export-encrypted.ts` seals the payload itself rather than going
through `storage/codec.ts`'s `sealJson`, which binds the vault schema version by design.

The payload plaintext is `{ items: VaultItem[] }` — the complete item set including tombstones
younger than the purge window (so a merge-mode import does not resurrect deleted items).

`includesThumbs` is written as `false` by every build up to Phase 11, because nothing captures
thumbnails before then and there is no heavy tier to include. A reader that meets `true` opens the
light tier and ignores `thumbs`: a thumbnail is a cache of something re-derivable from the page, and
refusing an otherwise perfectly readable backup over one would be the wrong trade.

### 11.1 What the importer accepts

**Two file shapes, both `.vmv`.** The backup above is one; the other is the Drive sync container
(§13.3), which is `vaultamark-vault.vmv` in the user's own Drive — a vault header plus base64url
buckets, exactly as the engine pushes it. `src/io/vault-file.ts` recognises either and hands the same
`ItemMap` to the same two import modes.

This is not a convenience. §13.3 deliberately makes the Drive vault an ordinary, visible,
downloadable object rather than something hidden in `appdata`, and the disconnect flow tells the user
in so many words that leaving the file behind keeps a copy they can restore from. A file the product
hands you, names after itself, and promises you can restore from has to be restorable — and
downloading it is the only recovery path that survives the Google account it came from.

The container is opened from its **own header**: `deriveKek(password, header.kdf)` → `unwrapDek` →
HKDF subkeys → `openBucket` per bucket, verifying each bucket's HMAC tag. That is `repo.adopt()`'s
derivation without the adoption, and deriving from the file rather than from the running vault's keys
is what makes it work for a vault from another profile as well as for this one's own copy.

Recognition is **positive on the backup and structural on the container** — `magic` present means
backup, otherwise a `v`/`header`/`buckets` shape means container, and anything else is neither.
Deliberately not "whatever is left is a container": an unrelated JSON file has to fail as *not a
VaultaMark file*, not as a vault that needs recovering. The container path re-applies the two guards
`parseVmv` applies and `parseHeader` did not — a floor under the KDF iteration count here, and the
KDF algorithm now checked in `parseHeader` itself, since `VaultHeader.kdf.alg` is a literal type that
a cast was asserting without anything having checked it.

A container carries no `createdBy` and no creation date — it is the live vault, not a snapshot taken
at a moment — so the preview reports `header.updatedAt` as "last changed" and says which of the two
kinds of file it is holding. `includesThumbs` is false for a container as a fact rather than a
default: thumbnails are their own Drive files (§14.3), and none of them is in this one.

Import modes:

- **Merge** — runs the Phase-7 merge engine with an *empty base*, which by the table in §6.4 yields
  adds for new ids and conflicts for divergent same-id items. Nothing is ever destroyed. Note what
  this means for a backup of *this* vault taken before a deletion: the file says the bookmark is
  alive, the vault says it was deleted, and that is an `edit-delete` conflict for the user to settle
  — a merge import never silently undoes a deletion. Restoring is what **Replace** is for.
  Conflicts raised this way carry `origin: 'import'`, which changes nothing about how they are merged
  or shown and exactly one thing about what is pushed: `outboundView` (§6.5) withholds a conflicted
  item so a push cannot overwrite *the other device's* answer, and a file is not a device with an
  answer to protect. Substituting the file's version would propagate a backup's copy of a bookmark to
  every device — a version the user has not chosen — so imported conflicts are pushed as the merged
  vault holds them, which is this device's side, the one on screen.
- **Replace** — double confirmation (a typed `REPLACE MY VAULT`, then a second dialog that says how
  many bookmarks are about to go), plus a one-shot rollback snapshot of the previous vault in
  `storage.local` for 24 hours. The snapshot is **sealed** (`purpose: 'rollback'`) — it is a complete
  copy of the item set, and INV-6 has no exception for "temporarily". Beside it, `vm.rollbackMeta`
  holds two timestamps and deliberately nothing else, so "is there an undo, and until when?" is
  answerable without a key. Restoring consumes it; an expired one is deleted rather than merely
  hidden, so an unused snapshot does not become a second copy of the vault that nobody knows is
  there.

**There is no plaintext export.** A Netscape bookmark-file export was specified here and built in
Phase 8 behind a typed `EXPORT UNENCRYPTED` gate; it was removed afterwards on the maintainer's call.
The gate was doing its job, but the feature it gated is the product running backwards — a file that
reveals every vaulted URL to anything that reads it, and that puts those URLs back into the omnibox
the moment a browser imports it. The `.vmv` backup is the way a vault leaves this extension. Anyone
who genuinely wants their bookmarks in Chrome has Chrome's own bookmark manager and a vault they can
read; nothing here needs to make that one click away from a backup.

The backup is delivered with `URL.createObjectURL` + a synthetic `<a download>` click, so the
`downloads` permission is never needed. The object URL is revoked in the same turn it is clicked: it
is a live handle to a decrypted copy of the vault, and one left alive keeps that copy readable from
the address bar for the lifetime of the page.

**Importing from Chrome's own bookmarks** (`src/import/native-bookmarks.ts`) is the one module that
may read `chrome.bookmarks` (INV-5), and it is split in two on purpose. Copying bookmarks into the
vault does *not* remove them from Chrome, so it does not remove them from the omnibox either —
deleting the native copies is what does, and that is a second, separately confirmed step with its own
button and its own summary. It is a separate message (`DELETE_NATIVE`) rather than a flag on the
import, because a flag would put "and delete the originals" one mis-click away from a copy, and
VaultaMark cannot undo a bookmark deletion.

The permission is requested **from the page**, during the click: `chrome.permissions.request` needs a
user gesture and refuses to run in a service worker at all. Reading the tree is then the worker's
job. Imported URLs go through the same allowlist as every other way into the vault
(`background/add.ts`), so an import cannot store what the add button would refuse; what it skips is
counted and reported rather than dropped in silence.

An import commits as **one batch** — the `addMany` mutation (§3.4), which lays each parent's new
children out in a single pass using `ordersBetween`. Adding items one at a time is quadratic twice
over (`listChildren` per add, and a whole-map copy per add), which at the five thousand bookmarks a
real profile can hold is tens of millions of operations in a worker MV3 is entitled to kill halfway
through.

---

## 12. History hygiene

### 12.1 Registrable-domain extraction

**Decision:** bundle the Public Suffix List (~10,200 rules, ~140 KB of source text, ~43 KB gzipped),
committed as a generated asset with a documented regeneration script. A naive "last two labels"
heuristic is wrong for `co.uk`, `com.au`, `github.io`, and several hundred other common suffixes —
and being wrong here means either failing to clean a domain the user asked to clean, or cleaning a
*different* site's history. Both are unacceptable, so the bytes are worth it.

> **Amended in Phase 9.** This paragraph originally said "a *trimmed* list, ICANN section only". That
> was wrong, and the sentence above it says why: `github.io` — named in Phase 9's own test list — is
> a **PRIVATE**-section rule, and so is `*.blogspot.com` and a few thousand others. Dropping the
> section reduces `alice.github.io` to `github.io`, so a cleanup aimed at one person's pages would
> delete every GitHub Pages site in the profile's history. That is precisely the failure this
> section exists to prevent. Both sections are bundled. (The "~9,000 entries" figure in the original
> text already described the whole list rather than the ICANN section, which has 6,949.)

Implementation: `src/history/public-suffix.ts` (generated), `src/history/domain.ts` (the algorithm).
Rules are **punycoded at generation time**, because `URL.hostname` is always in its ASCII form and a
rule kept in Unicode could never match anything the extension sees. The three rule kinds — plain,
`*.` wildcard, `!` exception — are stored as three newline-joined strings and turned into sets
lazily, on the first lookup: the module is reachable from the service worker's initial evaluation,
and the cold-start budget is 50 ms (§7.2). Measured cost of evaluating the literals: 0.06 ms.

The list is a static asset, never fetched at runtime. Regeneration is a manual `npm run update-psl`
that writes a dated file and requires a reviewed diff — no auto-updating from a URL (that would be
remote data influencing a security-relevant decision).

An IP literal has no registrable domain in the PSL sense and is answered with **itself**, so a
bookmark on a NAS or a dev box can still be cleaned; equality is the right containment test for
those. A host that *is* a public suffix (`co.uk`), or has no dot at all (`localhost`), is answered
with `null`, and every caller treats that as "do not touch it".

### 12.2 Clear history for vaulted domains

1. Request the optional `history` permission in context (explain first, then call
   `chrome.permissions.request`).
2. Decrypt the vault locally, extract the distinct registrable domains. **This set never leaves the
   device.**
3. For each domain, `chrome.history.search({ text: domain, maxResults: 0, startTime: 0 })`, filter
   results whose registrable domain matches exactly (`search` does substring matching, which
   over-matches — `example.com` would match `notexample.community`), and count.
4. Show a dry run: "This will remove 143 entries across 27 domains. Review the list."
5. On confirm, `chrome.history.deleteUrl` for each matched URL.

Non-vaulted domains are never passed to `deleteUrl`, nor to `search`: asking is already a question
about somebody else's browsing. `test/unit/background/history.test.ts` asserts both call lists
exactly.

`maxResults: 0` is Chrome's "no limit" — `QueryOptions::max_count` defaults to 0 meaning unbounded,
and the extension API only overrides it when `maxResults` is truthy. It reads like a bug and is not:
Chrome's 100-result default would produce an accurate-looking dry run that then left most of the
history it promised to remove.

The dry run and the run share one function (`scanHistory`), and the run **re-scans** rather than
trusting a URL list the page held onto: a preview can be minutes old and the worker can have been
torn down and rebuilt since. The two numbers therefore agree by construction rather than by
coincidence, and differ only when the history really has.

**On lock.** `clearHistoryOnLock` (off by default) runs the same cleanup on every lock, and the queue
of hosts left by the incognito fallback (`vm.historyQueue`, §9) is drained **unconditionally** —
that tick was a promise about specific pages, so it is kept whatever the setting says. Both happen
inside `session.lock()`, before the key is dropped, because the domain set comes from the decrypted
vault; the worker is rehydrated from `storage.session` first if this instance is cold, which it
usually is. A panic-lock skips both: immediacy is the point of that shortcut. The hook is injected
from `background/index.ts` rather than imported, or `session.ts` and `items.ts` would cycle.

### 12.3 Quick-close

Optional, **off by default**, `Ctrl+Shift+X`: close the active tab and delete that tab's domain's
history entries. The settings copy states plainly that this deletes real browsing history for that
domain, not merely VaultaMark-related entries.

Deliberately **not** limited to vaulted domains — a version that only cleaned pages already in the
vault would silently do nothing on exactly the page someone reached for it on. The history goes
before the tab does: Chrome writes the visit as the tab tears down, so closing first would leave the
entry the keystroke was aimed at. It needs no unlocked vault, and does not touch the idle window: it
is about the browser, not about the vault.

### 12.4 The URL-prediction reminder — removed

There used to be a card on onboarding step 5 about Chrome's "Autocomplete searches and URLs"
setting: an explanation, a copy-able `chrome://settings/?search=autocomplete` address, and an
instruction to switch it off. It is **gone** (maintainer-reported after Phase 11), along with
`onboardingPrediction*` and `AUTOCOMPLETE_SETTINGS_URL`.

The reasoning is written down rather than dropped, because a spec that simply forgets a decision
invites it back. The card had no control on it and could not have one: the setting is Chrome's, we
cannot read it, set it, or check afterwards whether the instruction was followed. So it was the one
step in a setup flow that nobody could complete *in the flow* — homework handed out at the end,
phrased as if it were part of the product's own configuration. The threat it describes is real and
belongs in `docs/PRIVACY.md`, which is where a statement that cannot be a control belongs.

What stays is the widget it shared with §9. `src/ui/address.ts` renders a `chrome://` address as
text in a `<code>` with a Copy button, never as an `<a href>`: Chrome refuses to follow a `chrome://`
link from an extension page, and a dead link is a worse instruction than a string the user can see
and copy. Its remaining caller is the incognito prompt's `chrome://extensions/?id=…` (§9), which
*does* have something to check afterwards — a Re-check button reading the real permission state.

---

### 12.5 Onboarding

A five-step flow on `manager.html?onboarding=1`, opened once by `chrome.runtime.onInstalled` with
reason `install` — never on an *update*, because a browser that updated four extensions overnight
and greeted the user with four tabs is how a flow teaches people to close it unread. It lives on the
manager page rather than in the popup because step 3 asks the user to paste an address into the
address bar, and a popup closes the moment they click there.

The five screens are: what VaultaMark is · create your master password · allow in incognito · choose
your sync tier · two things Chrome still does. The gates are pure functions in
`src/manager/onboarding/steps.ts`, and there are exactly two:

- **The password step is gated on `vaultExists`**, not on "the form said so". Nothing can set that
  but a `CREATE_VAULT` that succeeded, and nothing can send one but a form whose typed no-recovery
  phrase matched (`src/ui/create-form.ts`). There is no path from Next to step 3 that does not go
  through a real vault. This is the Definition-of-done item.
- **The incognito step is gated on "allowed **or** explicitly skipped"**. Nobody may be swept past it
  without noticing, and nobody may be trapped on it either — there is no API that can turn the
  setting on. A skip is recorded in `vm.onboarding` and leaves a persistent banner in the manager,
  which clears itself the moment the toggle goes on.

Going *back* is always allowed, including out of a step whose gate is shut: rewinding to re-read the
introduction cannot un-create a vault, and a flow you can only go forwards through is one people
click through without reading.

Progress lives in `vm.onboarding` (`storage.local`, plaintext): a step number, two booleans and a
completion timestamp. It is contentless in the same way `vm.baseMeta` is, and it has to be readable
before a vault exists — the whole point of the flow is that it runs before a password does. The
completion timestamp is stamped by the **worker**, not sent by the page. `resumeStep` answers `null`
for a completed record, which is the whole of "it never appears again"; Settings → About →
"Replay the setup guide" clears the stamp first.

Every step re-reads the world rather than remembering it. Whether a vault exists and whether
incognito access is on are both facts a user can change in another window.

---

### 12.6 One bookmark at a time

§12.2 is a promise about *sites*, made on a settings screen. It answers the question someone asks
once, deliberately, when they think about their history. It does not answer the question the manager
raises every time it is opened: **is this bookmark, the one I am looking at, still in the address
bar's suggestions?** Vaulting a page is what people believe stops that, and it does not — the visit
is still in `chrome.history`, autocompleting on its own.

So the same fact is offered a second way, at the granularity of a bookmark:

- **A warning marker on the row**, beside the eye and drawn on the same terms — always in the row,
  always the same width, visible only when it has something to say. A `span` with a `title` and
  hidden from assistive technology, because a listbox may contain nothing but options (§5.1).
- **A sentence and a button in the detail pane**, which is where the row's marker can be acted on
  and what a screen reader reaches instead of it.

Both are drawn from `HISTORY_PRESENCE`, which is **one scan for the whole vault**: `scanHistory` over
the vault's registrable domains, exactly as the dry run does, and then two set lookups per bookmark.
A query per row would be a `history.search` IPC per row — five thousand of them on a large vault, to
draw an icon. The answer on the wire is a list of **ids and nothing else**: the page drew those rows,
so it already knows their titles and addresses, and the reply carries no vault content of its own.

It is asked when the manager opens, on `VAULT_CHANGED` (a bookmark that was just added is the
likeliest thing in the vault to be in history — it is usually the page the tab was sitting on), and
on the way back to the list from any other screen. Never on the path of a keystroke, a scroll or a
selection. Without the `history` permission the answer is `granted: false` and the manager draws no
warnings at all, which is indistinguishable from "nothing is in history" on purpose: a warning drawn
on a guess is worse than no warning.

**`FORGET_ITEM_HISTORY` is scoped to the page, not to the site**, and that is the whole difference
between it and §12.2. It is offered under one bookmark's title, in the pane showing that one
bookmark; deleting a domain's worth of unrelated history from there would be an ambush. The domain
search is only how the candidates are found — `search` over-matches, so every result is re-checked
first for the domain (`urlBelongsTo`) and then for the page (`isSamePage`).

Matching a stored URL to a history entry is `src/history/match.ts`, and the rule is asymmetric on
purpose:

1. Compare origin, path and query, all normalized, ignoring the fragment.
2. **Only when the bookmark itself carries no query**, also accept an entry that differs from it by
   having one.

Clause 2 exists because `stripTrackingParams` is on by default, so the vault routinely holds
`example.com/post` for a page whose history entry is `example.com/post?utm_source=x`. It cannot fire
in the other direction — `youtube.com/watch?v=a` and `?v=b` are two videos, and a rule that ignored
the query would offer to forget one and delete both. The bookmark is the thing being asked about, so
it is the bookmark's lack of a query that widens the match, never the entry's.

---

## 13. Drive integration

### 13.1 Scope choice

`https://www.googleapis.com/auth/drive.file` — "See, edit, create, and delete only the specific
Google Drive files you use with this app."

| | `drive.file` | `drive` (full) |
| --- | --- | --- |
| Sensitivity tier | **Non-sensitive** | **Restricted** |
| Verification | **Not required.** An app whose scopes are all non-sensitive is exempt from OAuth app verification | OAuth consent form + demo video, **plus an annual CASA Tier-2 security assessment** by an approved third-party assessor (paid, weeks of calendar time, annual renewal) |
| Access | only files this app created | the user's entire Drive |
| Fits our need? | **yes** | overkill |

We only ever create and manage our own vault file, so `drive.file` is both sufficient and a far better
privacy story to put in a Store listing. The cost: if the user manually recreates or moves the file
outside our flow, we lose visibility of it and recovery goes through Import. That tradeoff is
documented in the UI.

**`drive.file` is the only Drive scope in the non-sensitive tier, and that is most of why it is the
right one.** It is not merely cheaper than `drive` — it takes the entire verification process off the
critical path to a release: no demo video, no privacy-policy review, no "unverified app" interstitial
in front of the consent screen. Every other Drive scope, `drive.readonly` included, is Restricted.
This table said *Sensitive* until 2026-08-10 and priced a review into the release plan that Google
does not ask for; if a future edit widens the scope, the cost being restored is this whole paragraph,
not a tier label.

The one thing publication still requires is leaving **Testing** status — see RELEASE §5.2, and note
that the reason has nothing to do with verification.

`drive.appdata` (the hidden app folder) was considered and rejected: the requirement is that the vault
file be a **normal, user-visible file** the user can see, back up, and copy.

### 13.2 Authentication

Primary: `chrome.identity.getAuthToken({ interactive: true, scopes: [...] })`. No client secret ships
in the package; the OAuth client is bound to the extension ID. On a `401`, call
`chrome.identity.removeCachedAuthToken` and retry once interactively.

Fallback for Chrome profiles not signed into Google: `chrome.identity.launchWebAuthFlow` with PKCE
(`code_challenge_method=S256`), a Web-application OAuth client, and the redirect URI
`https://<extension-id>.chromiumapp.org/` (from `chrome.identity.getRedirectURL()`, never built by
us). No client secret is required with PKCE, which is why this fallback is acceptable to ship in a
public package. Refresh tokens are stored in `chrome.storage.local` **encrypted with `k_items`**, so
an unlocked vault is required to refresh — and a refresh token that arrives while the vault is
locked is **dropped** rather than written down in the clear.

This fallback is the only reason `https://oauth2.googleapis.com/` is on
`build/url-allowlist.json` (INV-3): the authorization-code exchange and the refresh both POST to the
OAuth token endpoint, which is a different host from the Drive API. The consent screen and the
revocation endpoint are on `accounts.google.com`, which was already there. The access token itself
lives in `chrome.storage.session` — memory-backed, cleared when the browser exits — never in
`storage.local`.

A build with no `VM_OAUTH_CLIENT_ID` emits **no `oauth2` block at all** rather than an empty one:
Chrome treats a malformed `oauth2` as a manifest error and refuses to load the extension, and a
source build with no Google project behind it should still install, run and sync through Chrome. It
simply cannot offer Drive, and the settings screen says so.

Manifest addition (Phase 10):

```jsonc
"oauth2": {
  "client_id": "<numeric>-<hash>.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/drive.file"]
}
```

During development, an unpacked extension gets a new ID on every load, which breaks the OAuth client
binding. Fix: add a `"key"` field to the manifest (the base64 public key from a one-time
`chrome.exe --pack-extension` run) so the unpacked ID is stable. Instructions live in
[RELEASE.md §5](RELEASE.md#5-google-cloud--oauth-setup). The `key` field is stripped from production
builds — the Store assigns the real ID.

### 13.3 File layout

```
My Drive/
└─ VaultaMark/
   ├─ vaultamark-vault.vmv          appProperties: { vmRev: "137", vmSchema: "2" }
   └─ thumbs/
      ├─ t_<itemId>.vmt             appProperties: { vmItem: "<id>", vmSha: "<sha256>" }
      └─ …
```

The folder and files are ordinary, user-visible Drive objects. Their *contents* are ciphertext.

The vault file is JSON — `{ v, header, buckets: { "<i>": "<base64url>" } }` — which trades about a
third in size for a file a person can open and recognise. §13.3 makes a point of the vault being a
user-visible object rather than something hidden in `appdata`; a user-visible file that is an opaque
blob is only half of that promise. The encoding is not a security boundary and is not doing any
work: what is inside those base64url strings is the same sealed bucket that goes into
`chrome.storage.sync`. Drive's `md5Checksum` is computed over these bytes, which is what makes it a
usable cross-check against `appProperties.vmRev`.

A push is **one request**, so the "buckets before the header" ordering §5.4.1 exists for has nothing
to do here: Drive replaces a file's contents atomically and a failed upload leaves the previous
revision intact. A file that arrives truncated anyway — a connection that dropped mid-upload, a tool
that mangled it — is rejected by the container reader as `CorruptRemote`, and the engine repairs it
by pushing this device's copy (§6.3).

### 13.4 Freshness check (metadata only)

```
GET https://www.googleapis.com/drive/v3/files/{fileId}
    ?fields=modifiedTime,version,md5Checksum,appProperties
```

~300 bytes of response, no payload download, no decryption. `appProperties.vmRev` is authoritative;
`md5Checksum` is the integrity cross-check. `pullLight()` (the actual download,
`?alt=media`) runs **only** when `vmRev` or `md5Checksum` differs from what we last saw.

Triggers: after any local list change (debounced 3 s), `chrome.runtime.onStartup`, service-worker
wake, and `chrome.idle` transition to `active` when that permission is granted. All coalesced to at
most one probe per 60 seconds.

### 13.5 Concurrency

`pushLight` sends `If-Match: <etag>` where the API supports it, and always writes
`appProperties.vmRev` in the same request as the media update. A mismatch, or an observed `vmRev`
newer than `expect`, raises `PreconditionFailed(currentStamp)` and the engine re-enters MERGING. The
merge engine is idempotent, so a spurious retry is harmless.

### 13.6 Rate limits and errors

Exponential backoff with full jitter on `403 rateLimitExceeded`/`userRateLimitExceeded` and on all
`5xx`, honouring `Retry-After`. Base 1 s, cap 60 s, 6 attempts. `401` → one token refresh + retry.
`404` on the vault file → treat as "no remote yet" and offer to create or to re-link an existing file
via a picker. Offline → queue locally; the UI says "offline — your changes are saved on this device".

---

## 14. Thumbnails

### 14.1 Pipeline

```
add-time, user gesture, activeTab granted
  │
  ├─ scripting.executeScript(files: ['og-capture.js'])   ← the ONLY injection, on demand
  │    publishes globalThis.__vmOgCapture, and reports nothing (see below)
  │
  ├─ scripting.executeScript(func: readCapture)          ← calls it, and returns the answer
  │    reads og:image:secure_url | og:image:url | og:image | twitter:image | twitter:image:src
  │    reads og:title (≤300 chars), og:description (≤600 chars)
  │    resolves relative URLs against document.baseURI
  │    fetch(imageUrl, { credentials: 'omit', mode: 'cors', signal: AbortSignal.timeout(8000) })
  │      ↳ IN PAGE CONTEXT: the page's origin already served this image to this page
  │      ↳ abort above 5 MB
  │    returns { image?: base64url, contentType?, declaredBytes?, ogTitle?, ogDescription? }
  │
  ├─ SW: validate.ts   (§14.2)
  ├─ SW: process.ts    createImageBitmap → OffscreenCanvas → ≤320 px → WebP q0.75 → ≤40 KB
  ├─ SW: seal(k_thumbs, bytes, aad{v:2, purpose:'thumb', id:itemId})
  └─ SW: store.ts      storage.local (LRU-capped) + provider.putThumb() when heavyTier
```

**Why two injections.** A `files:` injection reports the completion value of the *program*, and a
bundled program is one IIFE expression statement — `(function () { … })();` — whose value is
`undefined` whatever the module did. So the file publishes a function and a second, three-line
`func:` injection calls it; Chrome awaits a returned promise, which is what lets the fetch happen
inside the page. The bytes travel as **base64url text**, not as an `ArrayBuffer`: `executeScript`
serialises its result, and a transferable would arrive as `{}` with no error anywhere.

**Capture happens on one entry point.** Of the four add gestures (D25), only the toolbar popup and
the keyboard shortcut act on a page that is *loaded in the active tab*; "Add link to VaultaMark" on
a context menu points at a URL nobody has opened. So capture runs from `items.addActiveTab` and
nowhere else, and only for a genuine add — re-vaulting a page already in the vault is a `duplicate`,
and silently re-capturing on it would make the toolbar button a hidden refresh button.

**Why the content script fetches, not the service worker.** A fetch from the service worker
originates from the extension and would be a genuine third-party request made by VaultaMark —
breaking INV-4 and creating a request the site's origin can attribute to "an extension", not "a page
load". Fetching in the page context uses the page's own cache and its own origin; no new party
learns anything. Cost: pages whose CSP blocks the fetch, or images without permissive CORS, yield no
thumbnail. That is an acceptable outcome — the favicon is always there. A setting
(**off by default**, explained in context) allows an extension-origin fetch for users who prefer
coverage.

**Never at browse time.** Rendering the vault performs zero network requests, ever. This is
INV-4 and is asserted by a Playwright route-interception test.

**Never a screenshot.** No `captureVisibleTab`, no `tabs.captureVisibleTab`, no offscreen rendering
of the page. If there is no OG/Twitter image, there is no thumbnail.

### 14.2 Validation — everything from the page is hostile

| Check | Rule |
| --- | --- |
| Scheme | `https:` only. `http:`, `data:`, `blob:`, `javascript:`, `file:` rejected. |
| Host | Must be a **public DNS name**. Written as an allowlist of shape rather than a denylist of ranges, because a denylist has to be complete to be worth anything — `0x7f.1`, `2130706433` and `[::ffff:127.0.0.1]` are all `127.0.0.1` before IPv6 zone identifiers are considered. So: every address literal is refused, public ones included; so are single-label hosts, `*.local`, `*.localhost`, `*.internal` and `*.home`. That covers `localhost` and every range the threat model names — `10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `::1`, `fc00::/7`, `fe80::/10` — and the test table drives each of them individually. (SSRF hygiene: the fetch happens in the page, but the URL is also recorded and could be reused.) |
| Content type | An **allowlist**: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/avif`, `image/bmp`. Same reasoning as `add.ts`'s scheme allowlist. **`image/svg+xml` is rejected with its own reason** — SVG is a script vector, and "SVG" is a better answer than "content type". |
| Declared size | `Content-Length` > 5 MB → reject before reading the body. |
| Actual size | Abort the stream past 5 MB. |
| Decodability | `createImageBitmap` must succeed. |
| Dimensions | Reject > 10,000 px on either axis (decompression bomb). |
| Aspect | Reject extreme ratios (> 20:1) as junk. |
| Redirects | A redirect to a non-`https` URL fails the fetch. |

Each rejection reason is recorded locally for the "no preview available" tooltip; nothing is reported
anywhere.

### 14.3 Processing

- Longest edge ≤ **320 px**, preserving aspect ratio, **never upscaling** a smaller source.
- `OffscreenCanvas.convertToBlob({ type: 'image/webp', quality: 0.75 })`, stepping quality down
  (0.75 → 0.6 → 0.45 → 0.3) until the result is ≤ **40 KB**; if still over, reduce the longest edge
  to 256 and repeat once; then give up and store nothing.
- JPEG fallback if WebP encoding is unavailable.
- Re-encoding through a canvas **strips all metadata by construction** — no EXIF, no GPS, no ICC
  profile beyond what the encoder writes. Tested with a GPS-tagged fixture.

### 14.4 Tier gating

| Active provider | Capture? | Storage | UI |
| --- | --- | --- | --- |
| `ChromeSyncProvider` | **No** (default) | — | favicon only |
| `ChromeSyncProvider` + "local-only thumbnails" opt-in | Yes | `storage.local` only | thumbnails on this device only, clearly labelled |
| `DriveSyncProvider` | Yes (default) | `storage.local` cache + Drive | full |

Not capturing by default on the Chrome tier is deliberate: capturing data that can never sync
produces a vault that looks different on every device for no reason the user asked for.

The opt-in is offered once, in context, **the first time a user saves a page from the popup** — not
"the first time they save one that has an OG image", which is what this section used to say. Knowing
whether a page has an image means injecting a script into it, and the gate is that *nothing is
injected*: a build that injected on every add to decide whether to ask is a materially different
product from one that does not, and it is what the phase's test asserts. The offer is marked as made
whichever way it is answered, including by dismissal — a question that returns because it was ignored
teaches people to ignore it — and the setting is in Settings → Browsing from then on. The two
gestures with no window to ask in (the keyboard shortcut, the context menu) never offer: their only
channel is the toolbar badge, and a badge cannot carry a question.

**The extension-origin fetch (§14.1) is not built.** It is named there as a setting for users who
want coverage, and it would require a host permission broad enough to fetch from any origin — which
is not in the permission table (D26) and is not something to widen for a decoration (INV-9). Building
it is a decision for a later phase, and it starts with a PLAN change, not with a manifest edit.

### 14.5 UI

- **The card is the picture *and* the page's own words.** `og:title` (≤300 chars) and
  `og:description` (≤600 chars) have been captured since Phase 11 and, until they were wired up
  after Phase 12, were read by nothing at all — stored inside the ciphertext, synced, and never
  displayed. They render under the image as a `figure`/`figcaption`, which is the same pair of
  fields a chat client shows when a link is pasted into it. Two consequences worth stating:
  - **A page with words and no picture still has a card.** Most of the web publishes no `og:image`;
    a great deal of it says what it is about. `thumbs.get()` therefore does not return early on a
    missing `thumb` record, and the "there is no preview" line is suppressed when there are words to
    read — it would be contradicting the card it sits in. It is *kept* for `remote`, where "the
    picture is in Drive" is information rather than an absence.
  - **This is the one place a page's own words reach the document**, and a page is hostile by
    assumption. They are text nodes built by `h`, never markup; the lengths were already capped at
    capture, and the CSS clamp (one line, then three) is about the shape of a floating card rather
    than about trusting the source.
- **Eye icon** on rows whose item has a card to show — a picture **or** those words; the flag is
  `hasPreview`, computed by `vault/types.ts` `hasPreview()` for both lists, and was `hasThumb` when
  only a picture counted → toggles a preview anchored to the row. **Both lists have one**, and they
  are deliberately not the same element:
  - **The manager's** is a `span`, not a `button`: a row is an `option` in a multi-selectable
    `listbox`, and a listbox may not contain interactive descendants (§ the same constraint that put
    every other per-row action in the toolbar). The keyboard equivalent is **`p`** on the list, which
    is not a convenience here — it is the only route a keyboard has. An empty, same-width `span` sits
    on rows with no preview, so the columns after it do not move as the list scrolls.
  - **The popup's** is a real `button`, immediately left of the delete button, and is **absent**
    rather than empty on a row with nothing to show. Both differences follow from the row: it is an
    `li` holding two buttons rather than an `option`, and the list is not windowed, so nothing moves
    when an eye is missing. Being a button is what gives the popup's preview a keyboard route without
    a second binding — Enter and Space pin the same card a hover opens. `ItemSummary.hasPreview`
    carries the flag; the card's contents still come from `GET_THUMB` when one is opened, for the
    reason the note is not on that wire either.

  The card is one card: `ui/thumb.ts` renders it and, since the popup grew an eye, `ui/styles.css`
  styles it — a preview that looked like one thing in one window and another in the other would be
  two products (the reasoning that moved `dialog.ts` in Phase 8). In the popup it is hosted on
  `.vm-vault`, the nearest ancestor of a row that does not scroll; hosting it on `.vm-list` would
  clip it at the first row it overhung.
- **The preview is a floating card, not an expanded row.** This section used to say "inline
  expansion", and the manager's list is windowed (`ui/virtual-list.ts`) with one fixed row height
  that the scroll arithmetic multiplies by: a row that grew to hold a picture would put every row
  below it at the wrong offset. Click-to-pin and hover therefore open the same card, positioned to
  stay inside the layout and never over the row it belongs to. The **detail pane**, which is not
  windowed, does show its preview inline — that is where the word applies.
- **Hover preview** after 200 ms, suppressed under `prefers-reduced-motion` and on touch/coarse
  pointers. The card is `pointer-events: none`: one that could take a `mouseleave` from the row
  underneath would flicker itself open and closed.
- **Refresh preview** is **two affordances, in two places, and only one of them can finish the job.**
  Re-capturing needs a script in the page; `chrome.scripting` needs either a host permission or an
  `activeTab` grant; and `activeTab` is only ever granted by a gesture *on that tab*. VaultaMark asks
  for no host permission at install (D25/INV-9), so:
  - **The popup** offers it when the page in front of it is already vaulted. Opening the popup *is*
    the gesture, so the capture runs there and then. This is the one arrangement in the whole
    extension where a refresh is possible. The notice appears **on open**, from
    `LOOKUP_ACTIVE_TAB` — a read of the active tab's URL against the vault, no injection and no
    write. It used to appear only after *Add this page* answered `duplicate`, which put an *add* in
    the middle of a *refresh*: two rounds of user reports treated that step as absent and concluded
    the button did nothing. Every reason the lookup has no answer — no tab, no grant, a `chrome://`
    page, an unvaultable scheme — collapses to `null` and shows nothing, because a popup opening is
    not a question anyone asked.
  - **The manager's detail pane** states plainly that re-capturing means opening the page, and on
    click opens it — in an incognito window, through the ordinary open path — and names the three
    steps that finish the job there: the toolbar button, *Add this page*, then *Refresh preview* on
    the notice that says it is already saved. It cannot do more, and pretending otherwise would mean
    a button that silently does nothing. The wording is load-bearing: an earlier version said only
    "use the toolbar button", and the popup does not offer a refresh until the add reports a
    duplicate — so the instruction ran out one step early and the feature was reported as broken.

  **A refresh replaces; an add merely adds.** A re-capture writes down what the page publishes *now*,
  including that it publishes nothing: a page that has lost its `og:image` loses its stored picture
  and bytes, and one that has lost its card loses `og` with it. The alternative was reported as
  "Refresh preview does nothing" — the notice said the page offered no preview picture while the
  previous page's card stayed on screen. The clearing is conditioned on the injection having actually
  run: a restricted page or a missing `activeTab` grant is *no information*, not evidence of an
  absence, and must not throw away a good preview. Nothing is written when there was nothing to
  clear, so the ordinary picture-less refresh still costs no revision and no sync push.

  Never automatic, never in the background, never on a timer. (The version this section described —
  the manager opening a window and injecting into it — is not implementable without a host permission
  for the page's origin. Recorded here rather than quietly dropped, so the idea does not come back
  without the permission question coming back with it.)
- **Graceful absence**: an item with `thumb` metadata whose bytes are unavailable (authored on a
  Drive machine, viewed on a Chrome-tier machine, or evicted from the cache) renders favicon + title
  with a quiet "preview stored in Drive" affordance. No spinner, no layout shift, no error toast. The
  stored `w`/`h` travel with the `remote` answer precisely so the box keeps its shape.

### 14.6 Cache management

`storage.local` thumbnails are capped (default **8 MB** without `unlimitedStorage`; see §5.1) and
evicted least-recently-viewed first. Evicted thumbnails are re-fetched from Drive on demand when
`capabilities.heavyTier` is true; on the Chrome tier eviction is genuinely lossy, which is part of
what the opt-in in §14.4 is asking about. A thumbnail with no LRU entry sorts as never-viewed and
goes first — the only way to have bytes and no entry is a write interrupted between the two.

`vm.thumbsLru` tracks last-viewed times and is **plaintext**, which is defensible for exactly one
reason: the item ids it holds are already visible beside it, because §5.1 stores each picture under
`vm.thumbs.<itemId>`. It leaks no id that enumerating the area would not, and it holds no title, URL
or host. It is local-only and never pushed to a provider.

**Thumbnails are dropped when the item is really gone, not when it is deleted.** A delete in this
codebase is a *tombstone* with an undo behind it (D20), and taking the picture at that moment would
make the undo lossy on a device that cannot re-fetch it. So the housekeeping alarm sweeps after
`purge()`, comparing the stored ids against the live item set and calling `provider.deleteThumb()`
for the difference. Sweeping by comparison rather than by list is also what catches the orphans a
merge, an import or a rollback leaves behind — none of which passes through the delete path at all.
A remote deletion that fails is swallowed: the alternative is refusing to delete a bookmark because
Drive is unreachable.

**They are also dropped when the bookmark stops pointing at the page they came from.** Editing a
bookmark's URL in the detail pane clears `thumb` and `og` in the same batch as the edit — one
revision, one thing for the merge to see — and drops the bytes afterwards. A preview is a statement
about a page, not a decoration of a row: keeping it would leave a card describing something the
bookmark no longer opens, and nothing in the manager can dislodge it, because the manager cannot
inject (§14.5). A save that leaves the normalized URL unchanged (a retitle through the same form)
clears nothing.

---

## 15. Dependencies policy

**Target: zero runtime dependencies in the shipped bundle.** Every runtime dependency is executable
code we ship to users of a security tool, and every one is a supply-chain surface.

Everything we need is in the platform:

| Need | Platform API |
| --- | --- |
| Crypto | WebCrypto (`crypto.subtle`) |
| Compression | `CompressionStream` / `DecompressionStream` |
| Image decode/resize/encode | `createImageBitmap`, `OffscreenCanvas`, `convertToBlob` |
| UUIDs | `crypto.randomUUID()` |
| Deep clone | `structuredClone` |
| UI | `src/ui/dom.ts` (~150 LOC, in-repo) |
| Virtualized list | `src/ui/components/virtual-list.ts` (~120 LOC, in-repo) |

**Static data assets** (not code) that we do bundle: the trimmed Public Suffix List (§12.1) and the
common-password list (§4.6). Both are generated by a committed script, reviewed as a diff, and never
fetched at runtime.

**Exception process.** Adding a runtime dependency requires: an issue stating what it does and why
the platform cannot; a bundle-size measurement; a look at its own dependency tree (transitive
dependencies count); a note in this section. Dev dependencies (Vite, Vitest, Playwright, ESLint,
TypeScript) are unrestricted — they never reach users.

---

*See also: [PLAN.md](../PLAN.md) · [RELEASE.md](RELEASE.md)*
