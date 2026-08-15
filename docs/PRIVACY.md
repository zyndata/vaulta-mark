---
title: Privacy Policy
---

# VaultaMark Privacy Policy

**Applies to:** the VaultaMark Chrome extension (all versions)
**Last updated:** 2026-08-05

*Published at <https://zyndata.github.io/vaulta-mark/PRIVACY>, which is the URL given to the Chrome
Web Store and must stay stable across releases. GitHub Pages serves it from this file on the `main`
branch, so it always shows the policy as of the last release rather than as of the latest commit —
see [RELEASE §8](RELEASE.md#8-store-listing-checklist). The content has not changed since it was
written in Phase 9; only its address is new.*

---

## The short version

**VaultaMark collects nothing.**

There is no VaultaMark server. There is no account. There is no telemetry, no analytics, no crash
reporting, no update ping, and no unique identifier of any kind. Nobody — including the developer —
can see your bookmarks, your usage, or that you installed the extension at all.

Your bookmarks stay on your own devices, encrypted. If you choose to turn on Google Drive sync, they
also go to **your own** Google Drive, still encrypted, where the developer has no access.

---

## What VaultaMark stores, and where

Everything VaultaMark stores is **encrypted with a key derived from your master password**, which is
never stored and never transmitted.

| Data | Where it lives | Encrypted? |
| --- | --- | --- |
| Bookmark URLs, titles, folder names, tags, notes, timestamps | `chrome.storage.local` on your device | ✅ Yes |
| Page preview images (thumbnails), when enabled | `chrome.storage.local`, and your Google Drive if connected | ✅ Yes |
| The same bookmark data, for syncing | `chrome.storage.sync` (your Chrome profile sync) **or** a file in your own Google Drive — whichever you chose | ✅ Yes |
| Vault header: encryption parameters, a random salt, your wrapped key, revision counters | Alongside the vault | ⚠️ Plaintext by necessity — see below |
| Settings: theme, idle-lock timeout, which sync tier is active, feature toggles | `chrome.storage.local` | Plaintext, contains no bookmark data |
| Setup progress: which of the five first-run screens you reached | `chrome.storage.local` | Plaintext — a step number and two yes/no answers, nothing else |
| Your master password | **Nowhere.** Not stored, not transmitted, not recoverable. | — |
| The unlocked key, while the vault is unlocked | `chrome.storage.session` — memory only, never written to disk, cleared when Chrome exits | — |

**The vault header is plaintext and cannot be otherwise:** the extension must read the encryption
parameters before it can derive a key from your password. The header reveals that a vault exists and
roughly how large it is. It reveals nothing about its contents. Ciphertext length is padded to a
256-byte boundary to blunt size-based inference, but padding reduces the leak rather than removing it.

Technical detail — the exact key hierarchy, cipher, and wire format — is public in
[ARCHITECTURE §4](ARCHITECTURE.md#4-cryptography) and
[ARCHITECTURE §8](ARCHITECTURE.md#8-threat-model).

## What VaultaMark sends over the network

**By default: nothing at all.** Browsing your vault, searching it, opening a bookmark, and adding one
generate **zero** network requests from the extension. This is enforced by an automated test that
fails the build if any request is observed.

There are exactly two exceptions, both under your control:

1. **Google Drive sync — only if you turn it on.** You grant access once via Google's own OAuth
   screen, using the `drive.file` scope. That scope means VaultaMark can only see files it created
   itself; it cannot read anything else in your Drive. It uploads and downloads one encrypted vault
   file (and, if thumbnails are enabled, one encrypted file per thumbnail) to
   `https://www.googleapis.com/`. **The contents are encrypted before they leave your device** —
   Google stores ciphertext and cannot read your bookmarks. Your use of Google Drive is governed by
   [Google's Privacy Policy](https://policies.google.com/privacy). You can disconnect at any time in
   Settings, and delete the file yourself from your Drive.

2. **The page's own preview image, at the moment you save a bookmark** — and only if thumbnails are
   enabled. The image is fetched **by a script running in that page's own context**, from the origin
   that just served you the page. No new party learns anything, and the extension itself makes no
   third-party request. The image is downscaled, encrypted, and stored. It is never re-fetched
   afterwards, so viewing your vault later contacts nobody.

Site icons (favicons) come from Chrome's **local** favicon cache. VaultaMark never uses a third-party
favicon service — doing so would hand that service a list of every domain you have vaulted.

## What VaultaMark never does

- No first-party server, backend, or API. None exists.
- No accounts, sign-up, email address, or licence check.
- No telemetry, analytics, usage statistics, A/B tests, feature flags, or "anonymous" metrics.
- No crash or error reporting to any service.
- No advertising, no advertising identifiers, no fingerprinting.
- **No selling, sharing, renting, or transferring your data.** There is no data to sell.
- No remote code. Every executable byte ships inside the extension package; the extension cannot load
  or run code from the internet, and its Content Security Policy forbids it.
- No reading of pages you visit. The extension only reads a page's title, URL, and preview metadata
  at the exact moment **you** ask it to save that page.
- No access to your Chrome bookmarks, history, or Drive unless you grant those permissions in
  context, for a specific feature.

## Permissions and why they exist

Permissions marked **optional** are not granted at install time. Chrome asks you the first time you
use the feature that needs one, and you can revoke it afterwards.

| Permission | Why | When |
| --- | --- | --- |
| `storage` | Stores the encrypted vault and your settings, and syncs the encrypted vault between your own Chrome profiles. | Always |
| `activeTab` | Reads the title and URL of the current tab **when you explicitly save it**, plus that page's preview metadata at that moment. | On your action only |
| `scripting` | Injects one small script into the current tab, only when you save it, to read that preview metadata. | On your action only |
| `contextMenus` | Adds the "Save to VaultaMark" right-click entry. | Always |
| `alarms` | Locks the vault automatically after your configured idle timeout. | Always |
| `favicon` | Shows each bookmark's site icon from Chrome's **local** cache, so no icon request goes to a third party. | Always |
| `identity` + `https://www.googleapis.com/*` | Obtains an OAuth token for the `drive.file` scope and transfers the encrypted vault file. | **Optional** — only if you enable Drive sync |
| `history` | Removes history entries so vaulted URLs stop appearing in address-bar autocomplete. | **Optional** — only when you run the cleanup tool or switch on one of the history settings |
| `bookmarks` | Imports your existing Chrome bookmarks into the vault, and deletes the originals afterwards **only** if you separately ask it to. | **Optional** — only during import |
| `idle` | Locks the vault when your system goes idle. | **Optional** — only if you enable it |

VaultaMark requests **no host permissions at install time**.

## The history tools

Saving a page to your vault does not remove it from Chrome's browsing history, and history
autocompletes in the address bar on its own. VaultaMark offers three ways to close that gap. All
three are **off until you turn them on**, all three need the optional `history` permission, and all
three delete **real browsing history** — not merely entries related to VaultaMark.

- **Clear history for vaulted sites.** Shows you the exact count and the list of sites first, and
  deletes nothing until you confirm. The list of sites is worked out on your device from the
  decrypted vault at the moment you press the button, and is never stored, logged or transmitted.
  Sites you have not vaulted are never touched — VaultaMark re-checks every result against the real
  site name before deleting anything, because Chrome's history search matches on substrings and
  would otherwise return a stranger's site whose name happens to contain yours.
- **Clear on lock.** The same cleanup, run automatically each time the vault locks, without asking.
- **Quick-close (Ctrl+Shift+X).** Closes the current tab and deletes that site's history in one
  keystroke. This one is deliberately *not* limited to sites in your vault, and it says so where it
  is switched on.

There is a fourth thing VaultaMark cannot do for you: Chrome's own **"Autocomplete searches and
URLs"** setting sends what you type to your default search engine and can suggest addresses from
signals no extension can see. The setup guide and Settings → Privacy explain it and give you the
address of the Chrome setting page. Extensions are not permitted to open or change Chrome's settings
pages, so this one is yours to do, and we say so rather than leaving you to assume it is handled.

## Incognito windows

Vaulted links open in an incognito window by design, so the pages you open from the vault leave no
history, cache, or cookies behind in your normal profile. For this to work you must allow the
extension in incognito mode — Chrome shows that setting on the extension's details page, and
VaultaMark explains it during setup. That setting grants nothing to the developer; it affects only
how the extension behaves in your own browser.

## Data retention and deletion

- **Delete a bookmark:** it becomes a tombstone (an encrypted record saying "this was deleted") so
  the deletion propagates to your other devices instead of being undone by a stale copy. Tombstones
  are purged automatically after 90 days.
- **Delete everything:** removing the extension from Chrome deletes its local storage. If you used
  Chrome sync, clearing the vault in Settings before uninstalling also removes the synced copy.
- **Google Drive:** disconnecting stops future syncing. The encrypted file remains in **your** Drive
  until you delete it — it is your file, in your account, and VaultaMark deliberately cannot delete
  files it did not create. The Settings screen tells you exactly where to find it.
- **No developer-side retention exists**, because no developer-side storage exists.

## Children

VaultaMark is not directed at children and knowingly collects no information from anyone, of any age.

## Security

There is **no password recovery**. The master password is never stored or transmitted, and no
recovery key exists — not held by the developer, not by Google, not by anyone. If you forget it, your
vault is permanently unreadable. That is the design, and it is the reason nobody can be compelled to
hand over your bookmarks. Use the encrypted export as your backup.

VaultaMark is licensed GPL-3.0-only and its cryptography is fully documented, but the source is not
published yet and it has not had a formal third-party security audit. Report vulnerabilities
privately: see [SECURITY.md](../SECURITY.md).

## Changes to this policy

Material changes are recorded in [CHANGELOG.md](../CHANGELOG.md) and reflected in the "Last updated"
date above. Because the extension collects nothing, no change to this policy can retroactively expose
data that was never gathered.

## Contact

Questions about this policy: open an issue at
<https://github.com/zyndata/vaulta-mark/issues>. Security reports go **privately** to
<https://github.com/zyndata/vaulta-mark/security/advisories/new> instead.
