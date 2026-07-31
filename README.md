# VaultaMark

> **Encrypted bookmarks that never touch your omnibox — synced through your own Google Drive.**

<!-- badges: CI · latest release · license · Chrome Web Store — added in Phase 1 / Phase 13 -->

VaultaMark is a Manifest V3 Chrome extension that keeps your bookmarks in a password-encrypted vault
stored **completely outside** Chrome's bookmark and history systems. Chrome never learns those URLs
are bookmarks, so they can never appear in address-bar autocomplete. Everything opens in an incognito
window. Nothing leaves your machine unless you explicitly connect your own Google Drive.

**Repository:** <https://github.com/zyndata/vaulta-mark>

**Status: in development, repository private.** The extension is being built in numbered phases — see
[PLAN.md](PLAN.md) for the plan and the current phase. There is no installable release yet, and
whether the source is published is a decision for later ([PLAN.md §2.5, D36](PLAN.md#25-project--process)).
GPL-3.0-only is the license it will carry if and when it is distributed.

---

## Why VaultaMark

- **Synced through *your own* Google Drive.** Optional, opt-in, `drive.file` scope only — the
  extension can only see the file it created. There is no VaultaMark server, because there is no
  VaultaMark company.
- **Stored entirely outside `chrome.bookmarks`.** This is the whole point: vaulted URLs cannot
  autocomplete in the address bar, because Chrome does not know they are bookmarks.
- **Discord-style link previews.** The page's Open Graph image is captured **once**, when you save the
  bookmark, then encrypted. Browsing your vault makes **zero** network requests, ever.
- **Every vaulted link opens in an incognito window.** No history, no cache, no trace.
- **One-click history cleanup for vaulted domains** — closes the "but I visited it once" leak that
  bookmark-only tools miss.
- **Zero config by default.** Chrome sync works out of the box with no OAuth and no extra
  permissions. Connect Drive when you want more room and previews.

## Screenshots

<!-- Phase 13 -->

## Install

Not yet available. The Chrome Web Store listing ships with 1.0.0 (Phase 13), and this section will
then cover: the Store link, building from source, and verifying the published zip's SHA-256 against
your own build.

Until then, see [Development](#development) to build and load it unpacked.

## How it works

Your master password never leaves your machine and is never stored. It is stretched with
**PBKDF2-HMAC-SHA256 (600,000 iterations)** and a per-vault random salt into a key-encryption key,
which unwraps a random 256-bit vault key. Every title, URL, folder name, tag, note, and thumbnail is
encrypted with **AES-256-GCM** — 96-bit random IV, authenticated, with additional data binding each
ciphertext to its schema version, purpose, and slot — before it touches storage of any kind.

There is no password verifier blob: a wrong password simply fails the authentication tag. Plaintext is
compressed and padded to a 256-byte boundary before encryption, so ciphertext size says little about
what is inside. While the vault is unlocked, the key lives in `chrome.storage.session` — memory only,
never on disk, gone when Chrome exits or the idle timer fires.

Full specification: [docs/ARCHITECTURE.md §4](docs/ARCHITECTURE.md#4-cryptography).

## What it protects — and what it doesn't

**Protects against:** someone browsing your machine or your Chrome profile; address-bar autocomplete
revealing vaulted URLs while you type; anyone reading `chrome.storage` on disk or in a profile backup;
Google, or anyone with access to your Drive, reading the vault; a stolen exported backup file.

**Does not protect against:** a compromised operating system or user account while the vault is
unlocked; a keylogger; another extension with debugger access to our pages; a weak master password
(there is a strength meter and a 10-character floor, but the rest is yours); an attacker who already
has your unlocked machine.

**Known, documented leaks:** the plaintext vault header (encryption parameters and a revision
counter — it reveals that a vault exists and roughly how big it is, nothing about its contents),
ciphertext length, and the existence and timestamps of the Drive file if you sync there.

Full threat model: [docs/ARCHITECTURE.md §8](docs/ARCHITECTURE.md#8-threat-model). Reporting policy:
[SECURITY.md](SECURITY.md).

## ⚠️ The one warning

**There is no password recovery. None.** Not by us, not by Google, not by anyone. The master password
is never stored or transmitted, and no recovery key exists. If you forget it, your vault is
permanently unreadable — that is the design, not a limitation. It is also the reason nobody can be
compelled to hand your bookmarks over.

Use the encrypted export as your backup. Keep the password somewhere you trust.

## Sync tiers

| | **Chrome sync** (default) | **Google Drive** (opt-in) |
| --- | --- | --- |
| Setup | none | one OAuth grant, `drive.file` scope |
| Capacity | ~600 bookmarks comfortably, ~1,000 measured | effectively unlimited |
| Links, titles, tags, notes, folders | ✅ | ✅ |
| Favicons | ✅ | ✅ |
| OG-image thumbnails | ❌ | ✅ |
| Where it lives | your Chrome profile sync | a normal file in your own Drive |

Both tiers store **ciphertext only**. You can switch either direction; Drive is never required, and
disconnecting it leaves the file in your Drive for you to delete.

## Permissions

VaultaMark requests **no host permissions at install time** and no permission that produces an install
warning. History, bookmarks, Drive, and idle access are **optional** and requested only when you use
the feature that needs them.

| Permission | Why | |
| --- | --- | --- |
| `storage` | Stores the encrypted vault and your settings; syncs the encrypted vault between your own Chrome profiles. | required |
| `activeTab` | Reads the current tab's title, URL, and preview metadata **at the moment you save it**. | required |
| `scripting` | Injects one script into that tab, only when you save it, to read the preview metadata. | required |
| `contextMenus` | Adds the "Save to VaultaMark" right-click entry. | required |
| `alarms` | Auto-locks the vault after your idle timeout. | required |
| `favicon` | Shows site icons from Chrome's **local** cache — never a third-party favicon service. | required |
| `identity` + `googleapis.com` | Google Drive sync. | optional |
| `history` | History cleanup for vaulted domains. | optional |
| `bookmarks` | Importing your existing Chrome bookmarks. | optional |
| `idle` | Locking on system idle. | optional |

Why `scripting` needs no host permission: `activeTab` is granted by all four save entry points
(toolbar, context menu, keyboard shortcut, popup), so the extension never needs broad access to the
sites you visit.

## Privacy

**No telemetry. No analytics. No error reporting. No accounts. No network calls at all** — except to
your own Google Drive, and only once you have connected it. This is enforced in CI, not just promised:
see the [hard invariants](PLAN.md#4-hard-invariants), one of which is an end-to-end test asserting
that browsing the vault produces **zero** network requests.

Privacy policy: [docs/PRIVACY.md](docs/PRIVACY.md)

## Development

**Requirements:** Node 24 LTS (pinned in [`.nvmrc`](.nvmrc)) and npm. Nothing else.

```bash
npm ci
npm run build        # → dist/, load unpacked in chrome://extensions
npm run dev          # watch build
npm run verify       # lint + type-check + tests + build + invariant scan
```

Then `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`. To exercise
"open in incognito", also enable **Allow in incognito** on the extension's details page.

The three test tiers — Vitest unit, Vitest integration, and Playwright E2E against a real Chromium
with the extension loaded — are `npm run test` and `npm run test:e2e`. Full setup, the build layout,
and the invariant scanners: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

> The extension builds, loads and is usable: an encrypted vault, a full bookmark manager, and
> zero-configuration sync across your own Chrome profiles. Google Drive sync, thumbnails, and
> import/export arrive in the phases described in [PLAN.md](PLAN.md).

## Architecture

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — component map, crypto, vault format, storage layout,
the sync and merge algorithm, the threat model, Drive integration, and thumbnails. It is normative:
the code follows the spec, and a change to one lands with a change to the other.

## Releases

[docs/RELEASE.md](docs/RELEASE.md) — branching, CI, tagging, Google Cloud and OAuth setup, and Chrome
Web Store publishing. User-visible changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Contributing

The repository is private and not taking outside contributions yet. If that changes,
[CONTRIBUTING.md](CONTRIBUTING.md) is the entry point — branching model, Conventional Commits, DCO sign-off, how to run
the tests, and the rules that are not negotiable (zero runtime dependencies, no remote code, no
plaintext anywhere, and no crypto pull request without a linked issue first).
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies to everyone here.

## Security

Report vulnerabilities **privately** through
[GitHub Security Advisories](https://github.com/zyndata/vaulta-mark/security/advisories/new) — see
[SECURITY.md](SECURITY.md) for scope, timelines, and what to include. Please do not open a public
issue for a security problem. While the repository is private, that form is reachable only by
accounts with access to it.

## License

[GPL-3.0-only](LICENSE) — Copyright (C) 2026 zyndata.

VaultaMark is a security tool. Copyleft keeps every fork auditable, which is the point. The license
applies to the code as distributed; the repository is private for now, and publishing the source is a
separate decision that has not been made.
