# VaultaMark

> **Encrypted bookmarks that never touch your omnibox — synced through your own Google Drive.**

<!-- STUB — this file is filled in during Phase 0 and completed in Phase 13.
     Section order and intent are fixed; the prose in each section is still to be written.
     See PLAN.md §10 for the outline this follows. -->

<!-- badges: CI · latest release · license · Chrome Web Store — added in Phase 1 / Phase 13 -->

VaultaMark is a Manifest V3 Chrome extension that keeps your bookmarks in a password-encrypted vault
stored **completely outside** Chrome's bookmark and history systems. Chrome never learns those URLs
are bookmarks, so they can never appear in address-bar autocomplete. Everything opens in an incognito
window. Nothing leaves your machine unless you explicitly connect your own Google Drive.

**Status: in development.** See [PLAN.md](PLAN.md) for the phased implementation plan.

---

## Why VaultaMark

- **Synced through *your own* Google Drive.** Optional, opt-in, `drive.file` scope only — the app can
  only see the file it created. No VaultaMark server exists. *(No other extension in this niche does
  this.)*
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

<!-- Chrome Web Store link · build from source · how to verify the published zip's SHA-256 against
     your own build. Phase 13. -->

## How it works

<!-- The 60-second version: master password → PBKDF2-HMAC-SHA256 (600,000 iterations) → AES-256-GCM
     over every title, URL, folder name, tag, note and thumbnail → stored in chrome.storage or your
     Drive as ciphertext. Full detail: docs/ARCHITECTURE.md §4. -->

## ⚠️ The one warning

**There is no password recovery. None.** Not by us, not by Google, not by anyone. The master password
is never stored or transmitted, and no recovery key exists. If you forget it, your vault is
permanently unreadable — that is the design, not a limitation.

Use the encrypted export as your backup. Keep the password somewhere you trust.

## What it protects — and what it doesn't

<!-- Short summary table; links to SECURITY.md and docs/THREAT_MODEL.md. Phase 12. -->

Protects against: someone using your computer, address-bar autocomplete leaking vaulted URLs, anyone
reading your Chrome profile or its backups, and Google or anyone else reading your Drive contents.

Does **not** protect against: a compromised operating system, a keylogger, another extension with
debugger access, or a weak master password. Full detail in
[docs/ARCHITECTURE.md §8](docs/ARCHITECTURE.md#8-threat-model).

## Sync tiers

| | **Chrome sync** (default) | **Google Drive** (opt-in) |
| --- | --- | --- |
| Setup | none | one OAuth grant, `drive.file` scope |
| Capacity | ~600 bookmarks | effectively unlimited |
| Links, titles, tags, notes, folders | ✅ | ✅ |
| Favicons | ✅ | ✅ |
| OG-image thumbnails | ❌ | ✅ |
| Where it lives | your Chrome profile sync | a normal file in your own Drive |

## Permissions

<!-- Table: permission → why → required/optional. Copy from docs/RELEASE.md §8. Phase 13. -->

VaultaMark requests no host permissions at install time and no permission that produces an install
warning. History, bookmarks, Drive, and idle access are **optional** and requested only when you use
the feature that needs them.

## Privacy

**No telemetry. No analytics. No error reporting. No network calls at all** — except to your own
Google Drive, and only when you have connected it. This is enforced in CI, not just promised: see the
[hard invariants](PLAN.md#4-hard-invariants).

Privacy policy: [docs/PRIVACY.md](docs/PRIVACY.md)

## Development

<!-- Prereqs (Node 24 LTS), npm scripts, load-unpacked, the three test tiers. → docs/DEVELOPMENT.md.
     Phase 1. -->

```bash
npm ci
npm run build        # → dist/, load unpacked in chrome://extensions
npm run verify       # lint + type-check + tests + build + invariant scan
```

## Documentation

- [PLAN.md](PLAN.md) — the phased implementation plan
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — crypto, vault format, sync/merge, threat model
- [docs/RELEASE.md](docs/RELEASE.md) — branching, CI/CD, Chrome Web Store publishing
- [CHANGELOG.md](CHANGELOG.md) — Keep a Changelog format
- [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md)

## Security

Report vulnerabilities **privately** through GitHub Security Advisories — see
[SECURITY.md](SECURITY.md). Please do not open a public issue for a security problem.

## License

[GPL-3.0-only](LICENSE) — Copyright (C) 2026 zyndata.

VaultaMark is a security tool. Copyleft keeps every fork auditable, which is the point.
