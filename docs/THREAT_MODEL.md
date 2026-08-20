# Threat model

What VaultaMark protects, from whom, and — in the second half — a checklist in which every claim
made here is traced to the code or the test that keeps it true.

Expanded in Phase 12 from [ARCHITECTURE §8](ARCHITECTURE.md#8-threat-model), which remains the
normative summary. Where the two disagree, this file is newer and wins; §8 links here.

---

## 1. What is being protected

Three assets, in descending order of how much their loss would cost:

1. **The master password.** It is the only secret. There is no recovery, no escrow and no reset —
   losing it loses the vault, which is a deliberate trade and is confirmed by a typed sentence
   before a vault is created.
2. **Vault content**: URLs, titles, folder and tag names, notes, and preview images. The URLs are
   the sharpest of these. A title can be vague; a URL is an address.
3. **The pattern of use**: how many bookmarks there are, when they were added, how often the vault
   changes. Partially protected, and §4 is honest about which parts are not.

Two things are deliberately **not** assets:

- **The existence of the vault.** The KDF header is plaintext — it must be, since the parameters
  have to be readable before a key exists. Plausible deniability is a non-goal.
- **Which extension is installed.** Anyone with the profile can read `chrome://extensions`. The
  toolbar button's picture and tooltip can be changed (§4.7); its name there cannot.

---

## 2. Adversaries, and what stops each one

| Adversary | What they get | What stops them |
| --- | --- | --- |
| **Someone at your unlocked computer, typing in the address bar** | Nothing. Vaulted URLs are in no autocomplete source. | Vault items never enter `chrome.bookmarks` (INV-5) and opening happens in incognito, so nothing enters `chrome.history` either. Optional history cleanup closes the "you visited it once before vaulting it" path. |
| **Someone with your disk, or a backup of it** | The header, and ciphertext. | AES-256-GCM over every bucket; the key exists only under a 600,000-iteration PBKDF2 derivation of a password that is not on the disk. |
| **Someone with access to your Google account** (another signed-in device, or Google) | The same ciphertext, plus its size and change frequency. | The sync payload is sealed before it leaves the process. Chrome sync and Drive both receive bytes we cannot read either. |
| **Someone who steals an exported backup** | An independently encrypted file. | `.vmv` carries its own KDF header and its own random export key, wrapped under a KEK derived from whatever password the exporter chose — which need not be the vault's. |
| **A shoulder-surfer, or someone who walks up while you are away** | Whatever is on screen. | Idle auto-lock, lock-on-blur, and a panic lock on a keyboard shortcut. A locked vault has no key anywhere, including in `storage.session`. |
| **A network observer** | Nothing, unless Drive is on. Then: TLS to `googleapis.com`, and its timing. | Browsing the vault makes **zero** requests — asserted in the browser, not reasoned about. |
| **A hostile web page you have vaulted** | One chance to feed us bad Open Graph metadata. | Everything the page supplies is validated before use, against a hostile-input table rather than a happy path. |
| **Another extension, or a page, sending us messages** | Whatever our message router accepts. | Every request is parsed and type-narrowed before dispatch; an unrecognised shape is refused rather than coerced. |

---

## 3. Out of scope, and why

Named rather than omitted. A threat model that lists only what it defeats is marketing.

| Scenario | Why it is out of scope |
| --- | --- |
| **A compromised operating system, malware, or a keylogger** | The password is typed on that machine. No browser extension survives this, and one claiming to would be lying. |
| **An attacker at your machine with the vault already unlocked** | They have exactly what you have. The mitigation is a short idle timeout, which is a setting rather than a defence. |
| **Another extension with `debugger` permission, or devtools open on our pages** | Chrome's extension model does not isolate us from either. |
| **A weak master password against an attacker holding your ciphertext** | 600,000 PBKDF2 iterations raise the cost of each guess; they cannot rescue `password1`. A strength meter and a ten-character floor are the whole of what we can do. |
| **Traffic analysis of Drive API calls** | Reveals that you use VaultaMark, roughly how much you keep, and how often you change it. Not what is in it. |
| **Memory forensics on a running browser with the vault open** | The key is in `storage.session` and in the JavaScript heap. JavaScript cannot guarantee erasure; `wipe.ts` is best-effort and says so. |
| **Chrome's own URL-prediction service** | Outside anything an extension can reach, switch off, or verify afterwards. Stated in `PRIVACY.md`; deliberately no longer presented as a setup step (ARCHITECTURE §12.4). |
| **A malicious build** | Reproducibility is not engineered. The published zip's SHA-256 is printed, and the source is the source. |

---

## 4. Accepted leaks

Each of these is known, is not fixed, and is not going to be without a change of design.

1. **The plaintext header** reveals that a vault exists, when it was created and last changed, how
   many revisions it has had, and — through the bucket count — a coarse size signal.
2. **Ciphertext length.** Payloads are gzipped and padded to a 256-byte boundary before sealing,
   which blurs the size of a change without hiding it. A vault that doubles is visibly a vault that
   doubled.
3. **Drive file metadata** — name, size, timestamps, and the fact of syncing — is visible to Google
   and to anyone with access to that Drive.
4. **The favicon cache.** `_favicon/` reads Chrome's *existing* local cache and creates no entry, so
   it leaks nothing; the visible cost is that a domain you have never visited shows a generic icon.
   A third-party favicon service would have leaked every vaulted domain and was refused for that
   reason (D26).
5. **The preview-image fetch at add time.** The page's own origin serves an image to the page's own
   context, for an image that page had already loaded. No new party learns anything; the origin
   sees one more request from a browser that was already there. It happens **once**, when you save,
   and never again.
6. **`vm.settings` is plaintext**, by design — the lock screen must honour the theme before a key
   exists. It is therefore incapable of holding anything that describes a bookmark, which is why
   there are no user-defined saved filters and no per-folder sort order (ARCHITECTURE §5.1).
7. **The extension is identifiable, whatever the toolbar says.** See §4.7 — it is long enough to be
   worth its own heading, because it is the one accepted leak a user can be misled about.

### 4.7 What the toolbar can and cannot change

Phase 14 made the toolbar button's **picture** and its **tooltip** settings (ARCHITECTURE §16). This
paragraph exists so that nobody, here or in the product, mistakes that for concealment.

**Variable**, from Settings → Toolbar appearance:

- the icon on the toolbar button — one of four, applied with `chrome.action.setIcon`;
- the tooltip on it — free text, applied with `chrome.action.setTitle`.

**Fixed, and not fixable:**

- the extension's **name**, in `chrome://extensions`, `chrome://apps`, the Chrome task manager and
  the profile menu. `manifest.name` is resolved at install time and **no API rewrites a manifest
  field of a running extension**;
- the extension's **id**, which is in the `chrome-extension://` origin of every page it opens and is
  visible in Chrome's own UI;
- the **Chrome Web Store listing**, which is public and is not a per-install thing at all;
- the **permissions** the extension holds, listed on its own `chrome://extensions` card.

So: a different picture is a different picture. Someone who reads a changed toolbar icon as "nobody
can tell VaultaMark is here" has a false belief, and will act on it — which is worse than never
having been offered the setting. That is why the section is named *Toolbar appearance*, why it
carries a sentence saying exactly what does not change, and why nothing in the product, the
documentation or the Store listing claims otherwise. It is also why B2 ("disguise mode / panic
camouflage", issue #19) was closed as a *rename and a narrowing* rather than built as asked — see
PLAN §5.

---

## 5. Security self-review checklist

PLAN §9 Phase 12: *"a written checklist, each item ticked with a reference to the code or test that
satisfies it."* Every row is a claim this document or PLAN §4 makes, and the reference is what would
fail if the claim stopped being true.

### 5.1 Cryptography

| # | Claim | Traced to |
| --- | --- | --- |
| C1 | The KDF is PBKDF2-HMAC-SHA256 at 600,000 iterations, and a file claiming another algorithm is refused rather than trusted | `src/crypto/kdf.ts`; `parseHeader` in `src/storage/local.ts` and `src/io/vault-file.ts` check `kdf.alg` against `KDF_ALGORITHM` — a Phase-11 fix, the cast at the bottom of that function had been asserting something nothing verified |
| C2 | Every ciphertext is AES-256-GCM with a fresh 96-bit random IV | `src/crypto/envelope.ts`; `test/unit/crypto/envelope.test.ts` |
| C3 | Crypto primitives match published vectors, not merely themselves | `test/fixtures/{kdf,hkdf,gcm}-vectors.json`, asserted in `test/unit/crypto/*.test.ts` — known-answer tests, not round-trips |
| C4 | Every sealed payload is bound to its purpose and schema version, so a bucket cannot be replayed as a header or as a conflict record | `AadPurpose` in `src/crypto/envelope.ts`; `test/unit/storage/codec.test.ts` |
| C5 | `crypto.subtle` appears in exactly one directory | ESLint rule confined to `src/crypto/**`, enforced by `npm run lint` |
| C6 | Sub-keys are derived, never reused: items, HMAC and thumbnails each have their own | `#adoptKeys` in `src/storage/repo.ts`; `src/crypto/keys.ts` |
| C7 | Bucket integrity is keyed, so a truncated or swapped bucket is detected before it is parsed | `HMAC-SHA256(k_hmac, json)` tag in `src/storage/codec.ts`; `test/unit/storage/codec.test.ts` |
| C8 | A minimum password length is enforced at the boundary, not merely suggested in the UI | `MIN_PASSWORD_LENGTH` in `src/crypto/password.ts`, thrown as `WeakPasswordError` from `repo.create`/`changePassword` |

### 5.2 Key custody and locking

| # | Claim | Traced to |
| --- | --- | --- |
| K1 | The unlocked key lives in `chrome.storage.session`, restricted to trusted contexts | `configureSessionAccess` in `src/background/session.ts` sets `TRUSTED_CONTEXTS` explicitly, so a future Chrome default cannot quietly widen it |
| K2 | After `lock()`, `storage.session` is empty and no module holds a key (INV-7) | `test/integration/lock-cycle.test.ts`; `test/e2e/lock.spec.ts` |
| K3 | A lock fires its hooks even when the worker was killed since unlocking | `rehydrateForLock()` in `session.ts` — the Phase-9 bug: `lock()` ran off the *cached* repository, and MV3 kills the worker every ~30 s, so the locks that matter found `null` and skipped the work |
| K4 | An expired idle window locks even if the alarm never fired | `unlockedUntil` is the authority and the alarm is a convenience; `session.state()` locks on read. `test/unit/background/autolock.test.ts` |
| K5 | A wrong password costs nothing — no vault is erased before the new one is proven | `repo.adoptOver` decrypts every bucket before `clearVault()`; `test/unit/background/syncing.test.ts` |
| K6 | The password is never logged, at any level | No logging of secrets anywhere; the diagnostics report is a closed field list (see D3) |

### 5.3 Storage and the invariants

| # | Claim | Traced to |
| --- | --- | --- |
| S1 | No plaintext vault content in `storage.local`, `storage.sync` or on Drive (INV-6) | `test/integration/vault-lifecycle.test.ts` asserts it directly; `test/e2e/journey.spec.ts` and `manager.spec.ts` re-assert it against a real `chrome.storage.sync` |
| S2 | Vault items never enter `chrome.bookmarks` (INV-5) | ESLint bans the API outside `src/import/native-bookmarks.ts`; `build/permissions.lock.json` keeps `bookmarks` optional |
| S3 | The history-cleanup queue never reaches disk — a vaulted URL's host is vault content | `vm.historyQueue` is in `storage.session`, ARCHITECTURE §9 |
| S4 | Buckets are written before the header, always, so a crash leaves a header pointing at the old revision | `flush()` ordering in `src/storage/repo.ts`; INV-6 assertion in `test/integration/vault-lifecycle.test.ts` |
| S5 | Two overlapping writes cannot lose one another | `apply` serialises (Phase 12); `test/unit/storage/repo.test.ts` — verified to fail without the fix, at revision 2 of an expected 21 |
| S6 | Destroying a vault clears the synced copy too, or says plainly that it could not | `DESTROY_VAULT` carries `deleteRemote` (default true) and answers with `remoteRemoved: boolean \| null`; post-Phase-11 fix |

### 5.4 Network and code loading

| # | Claim | Traced to |
| --- | --- | --- |
| N1 | No remote code, no `eval`, no `new Function`, no WASM (INV-1) | `scripts/verify-no-remote-code.mjs` against the real `dist/`; `test/unit/scripts/verify-no-remote-code.test.ts` |
| N2 | The CSP is exactly the specified string (INV-2) | `scripts/verify-manifest.mjs`; `test/unit/build/manifest.test.ts` |
| N3 | No absolute URL outside `build/url-allowlist.json` (INV-3) | Same scanner, plus its ESLint mirror |
| N4 | Browsing the vault makes zero network requests (INV-4) | Asserted in a real browser: `popup.spec.ts`, `journey.spec.ts`, `large-vault.spec.ts` and `thumbs.spec.ts` route-intercept every request and require the list to be empty |
| N5 | No telemetry, analytics or error reporting, ever (INV-8) | Same scanner as N1; and there is nothing to disable, because there is nothing there |
| N6 | Only the `drive.file` scope is ever requested | `DRIVE_SCOPE` in `src/sync/drive/auth.ts`; `test/unit/sync/drive/auth.test.ts` |
| N7 | The permission set cannot grow silently (INV-9) | `scripts/verify-manifest.mjs` diffs the manifest against `build/permissions.lock.json` |

### 5.5 Hostile input

| # | Claim | Traced to |
| --- | --- | --- |
| H1 | Open Graph metadata from a page is treated as hostile | `src/thumbs/validate.ts`; `test/unit/thumbs/validate.test.ts` is a hostile-input table, not a happy path |
| H2 | Image bytes are re-encoded rather than stored, which is also what removes EXIF | `src/thumbs/process.ts`; `test/e2e/thumbs.spec.ts` splices a real APP1 segment into a 4000×3000 JPEG and proves it does not survive — against an input the same test proves carried it |
| H3 | Imported files are parsed defensively, and an unrelated JSON file fails as *not ours* rather than as corrupt | `src/io/vault-file.ts` — recognition is positive on the backup (`magic`) and structural on the container, never "whatever is left" |
| H4 | A URL typed into the detail pane goes through the same gate as one saved from a page | `vaultableUrl` in `organize.editItem` — the edit box is a second door into the vault |
| H5 | Every wire message is parsed before dispatch; an unknown shape is refused | `parseRequest`/`parseResponse` in `src/shared/messages.ts`; `test/unit/shared/messages.test.ts` |
| H6 | History deletion filters by registrable domain first, because `chrome.history.search` matches substrings | `src/history/domain.ts` with the full public-suffix list, both sections; `test/unit/background/history.test.ts` asserts the exact `deleteUrl` list against a profile seeded with look-alikes |

### 5.6 What leaves the extension

| # | Claim | Traced to |
| --- | --- | --- |
| D1 | A drag carries item ids and nothing else — no title, no URL — because a drag can end in any application | `src/manager/dnd.ts`; a private MIME type and no `text/plain` at all |
| D2 | An export reveals nothing about its contents | `test/e2e/portable.spec.ts` and `journey.spec.ts` search the produced file for the titles and hosts that are in it |
| D3 | The diagnostics report carries counts, booleans and enums only — no URLs, titles, names, notes, ids, addresses or tokens | `src/shared/diagnostics.ts` is a closed field list, never an object walk; `test/unit/background/diagnostics.test.ts` seeds distinctive strings and searches the whole report for each |
| D4 | No user-facing string escapes `_locales` (INV-10) | `scripts/verify-strings.mjs`; `test/unit/scripts/verify-strings.test.ts` |
| D5 | Nothing in the product claims the extension can be hidden — the toolbar's picture and tooltip are variable, its name, id and listing are not (§4.7) | `settingsToolbarUnchanged` in `_locales`, asserted on screen by `test/e2e/manager.spec.ts`; the section is named *Toolbar appearance* in `_locales` and in ARCHITECTURE §16 |

### 5.7 Dependencies

| # | Claim | Traced to |
| --- | --- | --- |
| P1 | Zero runtime dependencies | `package.json` has no `dependencies`; N1's scanner refuses a remote import; `release/bundle-report.md` lists what is actually in the package |
| P2 | `npm audit` reports nothing outstanding | Phase 12 cleared the backlog: Vite 8, Vitest 4, ESLint 10 in one step. **Zero advisories at the time of writing.** Reviewed at the end of every phase (PLAN §0) |
| P3 | A toolchain advisory cannot reach a user | Nothing from npm ships (P1), which is what made the Phase-12 batching decision safe in the first place (PLAN R11) |

---

## 6. Residual risk

The honest summary, for someone deciding whether to trust this:

- **Your password is the whole of it.** Everything above assumes it is strong and is not on the
  machine an attacker controls. Neither assumption is enforceable from inside a browser.
- **An unlocked vault on a compromised machine is an open vault.** The idle timeout is a mitigation,
  not a boundary.
- **The pattern is visible even when the content is not.** Anyone with your synced blob can see it
  change, and roughly by how much.
- **No screen-reader user and no third party has reviewed this.** The checklist above is
  self-review, which is what PLAN §9 asks for at this stage and is not the same as an audit. That
  is stated here rather than left to be assumed.
