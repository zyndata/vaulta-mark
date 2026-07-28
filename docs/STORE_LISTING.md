# Chrome Web Store listing — drafts and asset checklist

Working drafts, written in Phase 0 and finalized in Phase 13. Nothing here is final copy; the point is
that no listing field arrives as a blank page on submission day, and that the permission
justifications are written while the reasoning is fresh rather than reconstructed months later.

The submission process itself — accounts, secrets, the upload workflow — is in
[RELEASE §6–§8](RELEASE.md#6-chrome-web-store-setup-and-the-four-secrets).

---

## 1. Asset checklist

| Asset | Spec | Status |
| --- | --- | --- |
| Store icon | 128 × 128 PNG, square, no transparent padding tricks | Phase 13 |
| Screenshots | 1280 × 800 **or** 640 × 400 PNG/JPEG, 1–5 of them | Phase 13 |
| Small promo tile | 440 × 280 PNG | Phase 13 |
| Marquee promo tile | 1400 × 560 PNG — only needed if the listing is ever considered for featuring | Optional |
| Short description | ≤ 132 characters | **draft below** |
| Detailed description | Leads with the differentiators; states the no-recovery warning; explains both sync tiers | **draft below** |
| Category | Productivity | fixed |
| Language | English (United States) | fixed |
| Privacy policy URL | GitHub Pages URL for [PRIVACY.md](PRIVACY.md) | Phase 9 |
| Single-purpose statement | one sentence, below | **draft below** |
| Permission justifications | one or two sentences each, below | **draft below** |
| Data-usage disclosures | "No data collected" across the board | Phase 13 |
| Support URL | <https://github.com/zyndata/vaulta-mark/issues> | fixed |
| Homepage URL | <https://github.com/zyndata/vaulta-mark> | fixed |

### Screenshots to capture (Phase 13)

Five, in this order — the first one is what most people will judge the extension on:

1. **The vault list**, populated with favicons and a couple of preview thumbnails. Realistic but
   synthetic bookmarks — never a real vault, never a real personal URL.
2. **The add flow** — the popup mid-save on an ordinary article page.
3. **Search, tags, and folders** — a `tag:` filter narrowing a few hundred items.
4. **Sync settings** — the two tiers side by side, Drive disconnected, quota bar visible.
5. **The unlock screen** — plus the no-recovery warning, so the constraint is visible before install.

Blur nothing, because nothing real appears. Use light mode for 1–4 and dark mode for 5, so both
themes are visible in the strip.

## 2. Short description (≤ 132 characters)

> Password-encrypted bookmarks kept out of Chrome's bookmarks and omnibox. Opens in incognito.
> Optional sync via your own Google Drive.

**131 characters.** Settled in [PLAN.md §11](../PLAN.md#11-risks--open-questions); Phase 13 may adjust
only for length or clarity.

## 3. Detailed description (draft)

> **Bookmarks Chrome doesn't know about.**
>
> VaultaMark keeps your bookmarks in a password-encrypted vault stored completely outside Chrome's
> bookmark and history systems. Chrome never learns those URLs are bookmarked — so they can never
> surface in address-bar autocomplete while someone is watching you type.
>
> **What makes it different**
>
> • **Synced through your own Google Drive.** Optional and opt-in, using the narrow `drive.file`
>   scope — the extension can only see the file it created. There is no VaultaMark server, because
>   there is no VaultaMark company.
> • **Stored entirely outside Chrome's bookmarks.** This is the whole point. Vaulted URLs cannot
>   autocomplete in the address bar.
> • **Link previews, captured once.** The page's preview image is saved when you bookmark it, then
>   encrypted. Browsing your vault afterwards makes zero network requests.
> • **Every vaulted link opens in an incognito window.** No history, no cache, no trace.
> • **One-click history cleanup** for domains you have vaulted — closing the "but I visited it once"
>   leak that bookmark-only tools miss.
> • **Zero config by default.** Chrome sync works immediately, with no sign-in and no extra
>   permissions. Connect Drive when you want more room and previews.
>
> **How the encryption works**
>
> Your master password is stretched with PBKDF2-HMAC-SHA256 (600,000 iterations) into a key that
> unwraps a random 256-bit vault key. Every title, URL, folder name, tag, note, and thumbnail is
> encrypted with AES-256-GCM before it is stored anywhere. The password is never stored and never
> transmitted. The full specification is public and the build is reproducible from source.
>
> **⚠️ There is no password recovery**
>
> None. Not by the developer, not by Google, not by anyone. No recovery key exists, and no backdoor
> exists. If you forget your master password, your vault is permanently unreadable — that is the
> design, and it is the reason nobody can be compelled to hand over your bookmarks. Use the built-in
> encrypted export as your backup.
>
> **Privacy**
>
> No telemetry. No analytics. No error reporting. No accounts. No network requests at all, except to
> your own Google Drive when you have connected it. This is enforced by automated checks that fail
> the build, not just promised in a listing.
>
> **Two sync tiers**
>
> Chrome sync (default): no setup, roughly 600 bookmarks, no thumbnails.
> Google Drive (opt-in): effectively unlimited, with encrypted preview thumbnails.
>
> Open source, GPL-3.0-only: <https://github.com/zyndata/vaulta-mark>

**Phase 13 checks before submission:** every claim above is true of the shipped build (especially the
capacity figure, which Phase 7 measures for real), and no sentence promises a feature that slipped.

## 4. Single-purpose statement

> Store, organize, and open bookmarks from a password-encrypted vault that is kept separate from
> Chrome's own bookmarks.

Chrome Web Store policy requires one narrow purpose. Every permission below must trace back to this
sentence — if one does not, the permission is the thing that is wrong.

## 5. Permission justifications

Each field has a character limit; keep each to one or two sentences. Copy verbatim from
[RELEASE §8](RELEASE.md#8-store-listing-checklist) — these two tables must stay identical.

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

**No host permissions are requested at install time.** `activeTab` is granted by all four save entry
points (toolbar button, context menu, keyboard shortcut, popup), which is why preview capture needs
no broad host access. If a reviewer asks why an extension that reads page metadata has no host
permission, that is the answer.

## 6. Data-usage disclosures

The dashboard asks about each category. The answer is the same everywhere:

| Question | Answer |
| --- | --- |
| Personally identifiable information | **Not collected** |
| Health, financial, authentication information | **Not collected** |
| Personal communications | **Not collected** |
| Location | **Not collected** |
| Web history | **Not collected** — the vault is on the user's device, encrypted with their password; the developer has no access to it and no server exists to receive it |
| User activity | **Not collected** |
| Website content | **Not collected** — a page's title and preview image are read only at the moment the user saves that page, and are stored encrypted on the user's own device |

Three certifications, all true:

- ✅ I do not sell or transfer user data to third parties, outside of the approved use cases.
- ✅ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes.

The only data transfer that happens at all is the user moving **their own encrypted file** into
**their own Google Drive**, at their instruction — which is the user's transfer, not the developer's.

## 7. Remote code

Answer: **"No, I am not using remote code."**

Every executable byte is in the package. The Content Security Policy is exactly
`script-src 'self'; object-src 'self'; frame-ancestors 'none'`, with no `unsafe-eval`, no
`unsafe-inline`, and no WASM relaxation. The build runs automated scanners
([INV-1 / INV-2](../PLAN.md#4-hard-invariants)) that fail if a remote script tag, a remote `import()`,
`eval`, or `new Function` appears anywhere in the output. Those scripts are in the repository — a
useful thing to point a reviewer at if the question comes back.

## 8. Likely review questions, and the answers

Prepared in advance, because the review turnaround on a bad answer is a week.

| Question | Answer |
| --- | --- |
| Why `scripting` with no host permission? | Injection happens only into the active tab, only after a user gesture, under `activeTab`. |
| Why does a bookmark manager want `history`? | It is **optional** and requested only when the user runs history cleanup. That feature exists because a URL in history autocompletes in the omnibox, which defeats the extension's entire purpose. |
| Why `bookmarks`? | **Optional**, requested only for importing existing bookmarks. Deleting the originals is a separate, separately confirmed action, never automatic. |
| Where does the OAuth token go? | Nowhere. `chrome.identity` holds it; it is used against `https://www.googleapis.com/` and never persisted by the extension. |
| Can the developer read user vaults? | No. Keys are derived from a password that is never stored or transmitted, and no server exists to receive anything. |
| What happens if a user forgets the password? | The vault is unreadable, permanently. Stated in the listing, at vault creation with a typed acknowledgement, and in onboarding. |
