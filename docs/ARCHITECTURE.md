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
│  ├─ add.ts            add active tab / link
│  ├─ incognito.ts      access detection + windows.create
│  └─ history.ts        vaulted-domain cleanup, quick-close
├─ crypto/              WebCrypto only — no other module may import crypto.subtle
│  ├─ kdf.ts  keys.ts  envelope.ts  codec.ts  hash.ts  wipe.ts  password.ts  errors.ts
├─ vault/               pure domain logic, zero I/O
│  ├─ types.ts  model.ts  order.ts  migrate.ts  search.ts  errors.ts
├─ storage/             persistence of the working copy
│  ├─ repo.ts  local.ts  buckets.ts  codec.ts  quota.ts
├─ sync/                transport + reconciliation
│  ├─ provider.ts       the SyncProvider interface
│  ├─ chrome-provider.ts
│  ├─ drive/{auth.ts,api.ts,provider.ts}
│  ├─ merge.ts  engine.ts  base.ts  migration.ts
├─ thumbs/              validate.ts  process.ts  store.ts
├─ import/              native-bookmarks.ts
├─ io/                  export-encrypted.ts  import-encrypted.ts  export-html.ts
├─ content/             og-capture.ts   (injected on demand, never declared in the manifest)
├─ popup/  manager/     UI entry points
├─ ui/                  dom.ts  favicon.ts  styles.css  components/
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
| `background.js` | `es` module | `"type": "module"` in the manifest. **No code splitting** — a dynamic import in a service worker after termination is a common failure source. `output.inlineDynamicImports = true`. |
| `popup.html` + `popup.js` | `es` | HTML entry, hashed asset names. |
| `manager.html` + `manager.js` | `es` | Same. |
| `og-capture.js` | `iife`, single file | `chrome.scripting.executeScript({ files: [...] })` needs one self-contained file with no imports. |

Target `chrome116`. `minify: 'esbuild'`, `sourcemap: 'hidden'` (maps are built, uploaded as CI
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
interface BucketPayload { items: VaultItem[] }

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
  is **off** by default and available as a setting. A separate key is computed for duplicate
  detection only (`duplicateKeyOf`: scheme+host+path+sorted query, fragment dropped, a bare origin's
  trailing slash normalised away) and **never stored**. A URL `URL` cannot parse is kept verbatim:
  this is a bookmark manager, not a validator, and a user should get back exactly what they saved.
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
{ "v": 2, "purpose": "bucket", "id": "7" }   // or "thumb"/"<itemId>", "base"/"", "export"/""
```

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
| `vm.thumbs.<itemId>` | sealed thumbnail bytes | yes (`k_thumbs`) |
| `vm.thumbsLru` | `{ itemId: lastViewedMs }` | no |
| `vm.conflicts` | sealed pending-conflict records | yes (`k_items`) |
| `vm.onboarding` | `{ completed, version, stepsSeen }` | no |

Every sealed value is stored as **base64url**, not as a `Uint8Array`. `chrome.storage.local`
JSON-serialises what it is given, so a byte array comes back as `{"0":12,"1":…}` — roughly five bytes
of quota per byte of ciphertext, and a silent shape change on the way out.

`vm.settings` is deliberately plaintext and deliberately incapable of holding vault content: the lock
screen has to honour the theme, and the auto-lock alarm has to be armed, before any key exists.
Reading it never throws — a corrupted blob falls back to defaults field by field, because a bad theme
value must not be able to keep someone out of their vault.

`destroy()` enumerates every `vm.` key rather than deleting a fixed list. A key added by a later
phase and forgotten there would leave sealed vault content on disk after the user asked for it to be
gone, which is the one outcome `destroy()` exists to prevent.

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

**Documented ceilings:** ~600 bookmarks comfortable (leaves room for notes and growth), ~980
theoretical. **Warn at 70 % of `QUOTA_BYTES`, block new adds at 95 %** with a "connect Drive" CTA.
Phase 7 must measure a real fixture and correct these numbers in this file and the README if the
measurement disagrees.

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
{ "vm.session": { "dek": "<base64url 32B>", "unlockedUntil": 1750000600000, "providerId": "chrome" } }
```

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
| `vm.base` | local only | the encrypted item set as of `lastSyncedRev` — the merge base |

Wall clocks are never trusted for correctness. `updatedAt` breaks ties in the UI ("which looks newer")
but every merge decision is made from the base comparison, not from timestamps.

### 6.3 The sync state machine

```
        local change (debounced 3 s)
        storage.onChanged from another device
        chrome.runtime.onStartup / SW wake
        idle → active
        manual "Sync now"
                 │
                 ▼
    ┌────────► IDLE
    │            │  trigger (single-flight; concurrent triggers coalesce)
    │            ▼
    │         PEEKING ── provider.peek() ──┐
    │            │                          │
    │   remote.vaultRev == lastSyncedRev    │  remote is null (first sync)
    │            │                          │
    │            ▼                          ▼
    │      local dirty? ──no──► IDLE     PUSHING (create remote)
    │            │yes
    │            ▼
    │         PUSHING (CAS on expect=remoteStamp)
    │            │           │PreconditionFailed
    │            │           └──────────────┐
    │   local clean & remote ahead          │
    │            ▼                          ▼
    │         PULLING ──────────────────► MERGING
    │            │                          │
    │            ▼                    ┌─────┴─────┐
    │      apply & set base       conflicts?    clean
    │            │                    │           │
    │            ▼                    ▼           ▼
    └────────── IDLE              CONFLICT     PUSHING → set base → IDLE
                                (banner, vault stays usable)
```

Every transition is restartable: the service worker can die at any point and the next trigger
re-derives the correct state from `vm.baseMeta`, the local buckets, and a fresh `peek()`. Pushes are
ordered **buckets first, header last**, so a crash mid-push leaves a remote whose header still points
at the old revision — the new bucket bytes are simply unreferenced and are overwritten on the next
push. Bucket HMAC tags in the header let a puller detect a torn state and re-pull.

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
- **`openedAt` / `openCount`**: `max` / `max`; never a conflict.
- **`updatedAt`**: `max` of the merged sides.
- **`rev`**: set to the new `vaultRev`.

Resulting `vaultRev = max(local.vaultRev, remote.vaultRev) + 1`.

**Properties (property-tested in Phase 7):**

- *No loss*: every id present and non-tombstoned in `local` or `remote` appears in `merged` or in
  `conflicts`. Nothing is ever dropped.
- *Idempotent*: `merge(m, m, m) = m`.
- *Order-independent*: `merge(b, l, r)` and `merge(b, r, l)` produce the same merged set and the same
  conflict set, differing only in which side is labelled "mine".
- *Convergent*: after both devices sync twice with no further local edits, their bucket sets are
  byte-identical.

### 6.5 Conflicts

Conflicts are persisted to `vm.conflicts` (encrypted) and surfaced in a dedicated manager view. Until
a conflict is resolved:

- the merged vault (with the **local** side provisionally applied for conflicted fields) is fully
  usable
- a persistent, non-blocking banner shows the count
- **nothing is pushed** for the conflicted items — the rest of the vault continues to sync normally

Resolution offers, per conflict: *keep mine*, *keep theirs*, *keep both* (duplicates the item with a
new id and a `(conflicted copy)` title suffix), plus batch versions of each. Resolving commits a
normal local change, which bumps `vaultRev` and pushes.

### 6.6 Provider migration

**chrome → drive**
1. Authorize (`drive.file`), create `/VaultaMark/`, upload the current light tier, set
   `appProperties.vmRev`.
2. Verify: `peek()` returns the expected stamp; `pullLight()` round-trips to an identical item set.
3. Flip `vm.settings.providerId = 'drive'`, reset `vm.baseMeta`.
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

---

## 8. Threat model

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
| Chrome's own URL-prediction service suggesting a URL you typed manually | Outside our reach; onboarding step 5 explains it and links to the setting. |
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

```ts
async function openVaulted(url: string, opts: { force?: boolean } = {}) {
  const allowed = await chrome.extension.isAllowedIncognitoAccess();
  if (allowed) {
    const reuse = settings.reuseIncognitoWindow;
    const existing = reuse ? await findIncognitoWindow() : null;
    if (existing) return chrome.tabs.create({ windowId: existing.id, url });
    return chrome.windows.create({ incognito: true, url, focused: true });
  }
  if (!opts.force) return { status: 'NEEDS_INCOGNITO_ACCESS' };   // UI shows the guided prompt
  return chrome.windows.create({ url, focused: true });            // explicit user fallback only
}
```

**The guided prompt.** Chrome does not allow an extension to navigate to `chrome://extensions`
programmatically, and there is no API to request incognito access. So the prompt:

1. explains in one sentence what "Allow in Incognito" does and why VaultaMark needs it
2. shows `chrome://extensions/?id=<our id>` with a **Copy** button and "paste this in your address bar"
3. illustrates the toggle's location in words plus a bundled screenshot asset
4. offers **Re-check** (calls `isAllowedIncognitoAccess()` again and updates live)
5. offers the fallback: *Open in a normal window this once* — with a plain warning that the visit
   will be recorded in history, plus an opt-in checkbox to queue a history cleanup for that domain
   afterwards (Phase 9)

`incognito: "spanning"` in the manifest means one shared service worker across normal and incognito
windows, so an unlocked vault stays unlocked when the incognito window opens. With `"split"` we would
get a second, independently-locked instance — worse in every way for this product.

The access result is cached for the session and invalidated on `chrome.management.onEnabled` and on
every explicit re-check.

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

Fallback when the cache has no entry (Chrome returns a generic globe): an inline SVG letter avatar
generated from the first character of the registrable domain, coloured by a hash of the host. Purely
local, deterministic, no network.

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
  "includesThumbs": false,
  "payload": "<b64url of seal(exportKey, gzip(pad(JSON)), aad{v:1,purpose:'export',id:''})>",
  "thumbs": { "<itemId>": "<b64url sealed>" }    // present only when includesThumbs
}
```

The payload plaintext is `{ items: VaultItem[] }` — the complete item set including tombstones
younger than the purge window (so a merge-mode import does not resurrect deleted items).

Import modes:

- **Merge** — runs the Phase-7 merge engine with an *empty base*, which by the table in §6.4 yields
  adds for new ids and conflicts for divergent same-id items. Nothing is ever destroyed.
- **Replace** — double confirmation plus a typed vault name; a one-shot rollback snapshot of the
  previous vault is kept in `storage.local` for 24 hours.

**Plain HTML export** uses the Netscape bookmark-file format so any browser can import it. It is
plaintext by definition. Gates: a dialog stating that the file reveals every vaulted URL to anything
that reads it, and that importing it into Chrome puts those URLs back into the omnibox; then a typed
`EXPORT UNENCRYPTED` confirmation. The generated file begins with an HTML comment carrying the same
warning.

Both exports are delivered with `URL.createObjectURL` + a synthetic `<a download>` click, so the
`downloads` permission is never needed.

---

## 12. History hygiene

### 12.1 Registrable-domain extraction

**Decision:** bundle a *trimmed* Public Suffix List (ICANN section only, ~9,000 entries, ~60 KB gzipped,
committed as a build-time-generated asset with a documented regeneration script). A naive
"last two labels" heuristic is wrong for `co.uk`, `com.au`, `github.io`, and several hundred other
common suffixes — and being wrong here means either failing to clean a domain the user asked to clean,
or cleaning a *different* site's history. Both are unacceptable, so the 60 KB is worth it.

The list is a static asset, never fetched at runtime. Regeneration is a manual `npm run update-psl`
that writes a dated file and requires a PR — no auto-updating from a URL (that would be remote data
influencing a security-relevant decision).

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

Non-vaulted domains are never passed to `deleteUrl`. Phase 9's test asserts the exact call list.

### 12.3 Quick-close

Optional, **off by default**, `Ctrl+Shift+X`: close the active tab and delete that tab's domain's
history entries. The settings copy states plainly that this deletes real browsing history for that
domain, not merely VaultaMark-related entries.

### 12.4 The URL-prediction reminder

Chrome's "Autocomplete searches and URLs" setting sends what you type to your default search engine
and can suggest URLs from signals we do not control. Onboarding step 5 and the Settings → Privacy
section explain this and provide a copy-able `chrome://settings/?search=autocomplete` link with
instructions. We cannot change the setting for the user, and we say so.

---

## 13. Drive integration

### 13.1 Scope choice

`https://www.googleapis.com/auth/drive.file` — "See, edit, create, and delete only the specific
Google Drive files you use with this app."

| | `drive.file` | `drive` (full) |
| --- | --- | --- |
| Sensitivity tier | Sensitive | **Restricted** |
| Verification | OAuth consent form + demo video | The same **plus an annual CASA Tier-2 security assessment** by an approved third-party assessor (paid, weeks of calendar time, annual renewal) |
| Access | only files this app created | the user's entire Drive |
| Fits our need? | **yes** | overkill |

We only ever create and manage our own vault file, so `drive.file` is both sufficient and a far better
privacy story to put in a Store listing. The cost: if the user manually recreates or moves the file
outside our flow, we lose visibility of it and recovery goes through Import. That tradeoff is
documented in the UI.

`drive.appdata` (the hidden app folder) was considered and rejected: the requirement is that the vault
file be a **normal, user-visible file** the user can see, back up, and copy.

### 13.2 Authentication

Primary: `chrome.identity.getAuthToken({ interactive: true, scopes: [...] })`. No client secret ships
in the package; the OAuth client is bound to the extension ID. On a `401`, call
`chrome.identity.removeCachedAuthToken` and retry once interactively.

Fallback for Chrome profiles not signed into Google: `chrome.identity.launchWebAuthFlow` with PKCE
(`code_challenge_method=S256`), a Web-application OAuth client, and the redirect URI
`https://<extension-id>.chromiumapp.org/`. No client secret is required with PKCE, which is why this
fallback is acceptable to ship in a public package. Refresh tokens are stored in
`chrome.storage.local` **encrypted with `k_items`**, so an unlocked vault is required to refresh.

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
  │    reads og:image:secure_url | og:image:url | og:image | twitter:image | twitter:image:src
  │    reads og:title (≤300 chars), og:description (≤600 chars)
  │    resolves relative URLs against document.baseURI
  │    fetch(imageUrl, { credentials: 'omit', mode: 'cors', signal: AbortSignal.timeout(8000) })
  │      ↳ IN PAGE CONTEXT: the page's origin already served this image to this page
  │      ↳ abort above 5 MB
  │    returns { image?: ArrayBuffer, contentType?, ogTitle?, ogDescription? }
  │
  ├─ SW: validate.ts   (§14.2)
  ├─ SW: process.ts    createImageBitmap → OffscreenCanvas → ≤320 px → WebP q0.75 → ≤40 KB
  ├─ SW: seal(k_thumbs, bytes, aad{v:2, purpose:'thumb', id:itemId})
  └─ SW: store.ts      storage.local (LRU-capped) + provider.putThumb() when heavyTier
```

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
| Host | Reject `localhost`, any IP literal, `*.local`, and these ranges: `10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `::1`, `fc00::/7`, `fe80::/10`. (SSRF hygiene: the fetch happens in the page, but the URL is also logged and could be reused.) |
| Content type | Must start with `image/`. **`image/svg+xml` is rejected outright** — SVG is a script vector. |
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
produces a vault that looks different on every device for no reason the user asked for. The opt-in is
offered once, in context, the first time a user adds a bookmark that has an OG image.

### 14.5 UI

- **Eye icon** on rows whose item has `thumb` metadata → toggles an inline expanded preview.
- **Hover preview** after 200 ms, positioned to stay in-viewport, suppressed under
  `prefers-reduced-motion` and on touch/coarse pointers.
- **Refresh preview** in the detail pane: states plainly that re-capturing requires opening the page,
  then (on click only) opens it in an incognito window, injects the capture script, stores the
  result, and closes the window. Never automatic, never in the background, never on a timer.
- **Graceful absence**: an item with `thumb` metadata whose bytes are unavailable (authored on a
  Drive machine, viewed on a Chrome-tier machine) renders favicon + title with a quiet
  "preview stored in Drive" affordance. No spinner, no layout shift, no error toast.

### 14.6 Cache management

`storage.local` thumbnails are capped (default **8 MB** without `unlimitedStorage`; see §5.1) and
evicted least-recently-viewed first. Evicted thumbnails are re-fetched from Drive on demand when
`capabilities.heavyTier` is true. `vm.thumbsLru` tracks last-viewed times. Deleting an item deletes
its thumbnail locally and calls `provider.deleteThumb()`.

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
