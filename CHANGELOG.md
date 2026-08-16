# Changelog

All notable changes to VaultaMark are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is maintained **by hand**, in the same commit as the change it describes. It is written for
users; commit subjects are written for whoever reads the history. See
[docs/RELEASE.md §1](docs/RELEASE.md#1-branching-model) for how commit types map to the sections
below.

## [Unreleased]

### Added

- **Releases now carry a provenance attestation** beside the checksum. The checksum says your
  download matches what was published; the attestation says the file came out of this repository's
  release workflow, from a named commit, rather than being uploaded by hand. Check it with
  `gh attestation verify --owner zyndata vaulta-mark-<version>.zip`.

### Changed

- **A build can now be given its own OAuth client id for development** (`VM_OAUTH_CLIENT_ID_DEV`),
  used only when the manifest pins an unpacked extension id. A Google OAuth client for an extension
  authorises exactly one extension id, so publishing to the Store created a second id that needed a
  second client. Nothing about the published extension changes, and a build with the variable unset —
  which is every source build and every CI run — behaves exactly as before.

### Fixed

- **The Store description is one sentence shorter**, because the old one was one character too long
  for Chrome to accept: 133 against a hard limit of 132. It reads "…Optional sync via your Google
  Drive" now rather than "your **own** Google Drive". Nothing about the extension changed; the
  package simply could not be uploaded. `npm run verify` measures both the name and the description
  against the Store's limits from now on, so the next one is caught before the upload rather than by
  it.

### Security

- **The release pipeline no longer trusts a mutable name.** Every GitHub Action the three workflows
  use is pinned to a full commit hash rather than a version tag, the Chrome Web Store upload tool is
  installed at an exact version with install hooks disabled, and the tag typed into the release form
  reaches the shell as data rather than as script. The workflow token is no longer left in the
  checkout for later steps to read. None of this changes the extension you install; it narrows what
  would have to go wrong elsewhere for a release to be built from something other than the tagged
  source.

## [1.0.0] - 2026-08-15

The first release. Everything below is new, because there was nothing before it.

### Added

- **The source is public, under GPL-3.0-only.** VaultaMark asks you to trust it with a password
  nobody can recover, so the code that does the encrypting is readable, forkable, and checkable
  against the extension you installed. Every release is built from a tag by a GitHub Actions
  workflow and its SHA-256 is published in the release notes — you can now build the same tag
  yourself and compare. The cryptography has still not had a formal third-party audit, and
  `SECURITY.md` says so; publishing makes the claims checkable rather than proven.
- **The privacy policy has a permanent address:** <https://zyndata.github.io/vaulta-mark/PRIVACY>.
  It is the same document that has shipped in the repository since Phase 9, served from the released
  branch, so it always describes the version you can actually install.

- **Releases are published with a checksum.** Every GitHub Release carries the packaged extension
  and a `SHA256SUMS` file beside it, so a downloaded package can be checked against what was built
  from the tag. The `README` says plainly how far that goes: the zip container is byte-for-byte
  reproducible by construction, the bundle inside it is not promised to be, and a matching hash
  therefore proves a great deal while a differing one proves nothing on its own.

- **Page previews.** When you save a page, VaultaMark now keeps the preview picture the page
  publishes for social media — the one you see when a link is pasted into a chat — and shows it
  beside the bookmark. An eye on a row opens it; hovering a row opens it after a moment; the item's
  detail pane shows it inline. Press **p** on the list for the same thing from the keyboard.
  - **The toolbar popup has the eye too**, just left of the delete button, on the rows that have
    something to show and on no others. Hover it for the preview, or press it — it is a button, so
    Enter and Space work as well.
  - **The picture is read once, when you save the page, and never again.** Browsing your vault makes
    no network requests of any kind, exactly as before. There is no re-fetching, no background
    refresh and no timer; refreshing a preview is a button you press, on a page you have open.
  - **It is fetched by the page, not by VaultaMark.** The picture is pulled using the page's own
    connection, for an image that page had already loaded, so no new party learns anything about
    what you save. The cost is honest: some sites forbid it, and those bookmarks simply have no
    preview. The favicon is always there.
  - **Everything about it is encrypted**, with a key of its own derived from your master password —
    the picture is as unreadable to Google Drive, or to anyone with your disk, as the bookmark is.
  - Pictures are re-encoded to at most 320 pixels and 40 KB before they are stored. That is also
    what removes any camera metadata — location included — that the original carried: what is kept
    is a new image, not the site's file.
  - **Screenshots are never taken.** If a page publishes no preview picture, there is no preview.
  - With Google Drive connected, previews sync to your other computers and are kept there; this
    computer holds up to 8 MB of them as a cache and re-fetches what it drops. On Chrome sync, which
    has nowhere to keep pictures, previews are **off** — VaultaMark offers once, in context, to keep
    them on this computer only, and the setting is in Settings → Browsing afterwards.
  - A bookmark whose preview lives on another computer shows its favicon and title with a quiet
    note, not a spinner and not an error.
- **Google Drive sync.** Settings → Sync now offers to connect your own Google Drive and move the
  vault there. It holds thousands of bookmarks instead of hundreds, and it is where page previews
  will live. Chrome sync stays the default and needs nothing from you; Drive is opt-in, and the
  permission is asked for at the moment you press the button.
  - **VaultaMark can only see the files it creates in your Drive.** That is the whole of the access
    it asks for — the `drive.file` scope — and it cannot read anything else there. What it does
    store is encrypted with your master password before it leaves your computer, so Google cannot
    read it either. The file is an ordinary, visible file in a folder called `VaultaMark`: you can
    find it, copy it, back it up.
  - **Switching either way is a copy, a check, and only then a switch.** If the copy does not read
    back as exactly what was sent, nothing is changed and you stay where you were. Moving *back* to
    Chrome sync is refused when the vault has outgrown it, with the numbers — "this holds 2,400
    bookmarks and about 600 would fit" — rather than a half-migration.
  - **Disconnecting leaves your Drive file alone**, because it is your file. Deleting it is a
    separate checkbox. Moving *to* Drive does clear the copy in Chrome sync, because two systems of
    record is how a merge loses an edit — your other computers will ask you to connect Drive too.
  - Nothing is polled. VaultaMark checks whether anything changed when the browser starts, when it
    wakes up, and when you come back to the computer — at most once a minute, and each check is a
    few hundred bytes rather than a download.
  - A build made from source with no Google project behind it now **says what to do about it**.
    Settings → Sync shows the setup steps together with the two values that have to be carried to
    the Google Cloud console — this installation's extension ID and the one permitted scope — each
    with a Copy button. It replaces a single line stating that Drive was unavailable. Nobody
    installing VaultaMark from the Chrome Web Store ever sees this panel: those builds arrive
    configured. There is deliberately no link to the console, and the panel says why.
- **Your preferences now follow your vault.** A second computer that joins your vault arrives with
  your theme, your auto-lock timeout, your sort order and your privacy toggles already set, instead
  of the defaults. They are stored inside the encrypted vault like everything else.
  - The two things that stay per-computer are the manager's column widths and which sync backend
    that computer uses — a laptop should not inherit a desktop's columns, and a profile with no
    Drive connection should not be told to use Drive.
  - If two computers change the same preference, the more recent one wins and nothing asks you about
    it. A theme is not worth a dialog.

### Fixed

- Settings → Sync said "The copy in Chrome sync **has been** removed" while Chrome sync was still
  the only place the vault was kept. It sat above the *Connect Google Drive* button and described,
  in the past tense, something that happens when you press it. It now says what moving to Drive
  will do.

- **Enter now confirms in a dialog that asks a yes-or-no question.** Pressing Delete on a bookmark
  or a folder raises "are you sure?", and Enter did nothing there but close it the same way Escape
  does — because the button that had the keyboard was *Cancel*. Enter answers the question and
  Escape backs out, in every dialog that has one thing to confirm. The question about what to do
  with a folder's contents is unchanged: it offers two real answers and preselects neither.

- **"Refresh preview" left the old preview in place.** A page that had stopped publishing a preview —
  or a bookmark you had pointed at a different address — kept the picture and the words of the page
  that used to be there, under a notice saying the page offered no preview picture. Refreshing now
  writes down what the page shows *now*, including that it shows nothing: the stale picture and its
  words are removed. A refresh that could not read the page at all — a restricted page, or one you
  did not open VaultaMark on — still changes nothing, because it learned nothing.

- **Changing a bookmark's address now clears the preview that came with the old one.** The picture
  and the summary described the page that used to be there; keeping them beside a different address
  was simply wrong, and nothing in the manager could remove them. Saving the same address back — a
  retitle, say — leaves the preview alone.

- **Refreshing a preview is now two clicks, not three.** Opening VaultaMark on a page you have
  already saved says so straight away, with **Open it** and **Refresh preview** beside the notice.
  Until now that notice appeared only after you pressed *Add this page* — an add in the middle of a
  refresh, which is not what anyone reads when they are trying to refresh something. The manager's
  button, which can only open the page (re-capturing needs the page in front of you), now says
  exactly where to press next.

- **A bookmark could be lost if two of them were saved at the same instant.** Chrome hands the
  extension its next instruction without waiting for the previous one to finish, so saving from the
  keyboard shortcut while the popup was also saving — or two manager windows at once — could commit
  both changes under one revision number. The bookmark itself survived on the computer it was made
  on; what was lost was the record that anything had happened, so your other computers would never
  have been told about it. Writes are now serialised.

- **"There is already a different vault there" is now a question with two answers, not a dead end.**
  Connecting Google Drive to a folder that already holds another vault used to report the refusal and
  stop there — on a screen whose only other control was the button that had just been refused. The
  same message also told you the other vault had "another master password", which is often simply not
  true and sent people hunting for a password problem that did not exist: **a vault created a second
  time is a new vault whatever password you give it**, so a computer that lost its copy — a reinstall,
  a cleared profile — and made a new one with the same password lands here too, which is the most
  common way to see this at all.

  Both answers are now offered wherever the mismatch is reported, in Settings → Sync and under the
  Drive connection, and neither happens on a single press:

  - **Use the synced vault on this computer.** This is the one you want when the copy in sync is the
    one with your bookmarks in it. You type the master password that opens *it*, this computer's own
    vault is erased, and this computer joins the synced one exactly as a second computer does — its
    bookmarks, folders, tags and notes appear here and the two keep each other up to date. The dialog
    says how many bookmarks this computer would lose before you confirm, and points you at a backup
    first if there are any. Nothing is erased until the password has been proven and the whole vault
    decrypted, so a typo costs a second and a half and nothing else. It is refused while the vault is
    locked: knowing some other vault's password must never be a way to delete yours.
  - **Overwrite the synced copy with this vault.** What existed before, now reachable from the Drive
    connection too, where "the synced copy" had meant the wrong thing entirely.

  This is also the door a second computer needed and did not have: joining a vault that lives in
  Google Drive was impossible unless the vault had reached that Drive from this computer.

- **The vault file from your Google Drive can now be restored from.** Downloading
  `vaultamark-vault.vmv` out of your own Drive and opening it under Import & export → *Restore from a
  backup* used to be refused as "not a VaultaMark export" — it is a VaultaMark vault, just the synced
  one rather than a backup, and the two shared a file extension and nothing else. Both are accepted
  now, with the same master password, and the confirmation says which of the two you opened and when
  it was last changed. This matters most in the case nobody plans for: a Drive account you have lost
  access to, and a file you had saved.

- **Sizes in Settings → Sync are readable.** A connected Drive reported `6010430 kB of 15728640 kB
  used`. It now says `5.7 GB of 15 GB used`, and a Chrome sync vault still says `42 kB of 100 kB`.

- **Folders in the sidebar can be dragged and deleted like anything else.** A folder can be dragged
  onto another folder — or onto *All bookmarks* to bring it back to the top level — and pressing
  **Delete** with a folder selected in the tree asks the same question the detail pane asks, rather
  than doing nothing at all. Dropping bookmarks *into* the sidebar already worked; dragging the
  folders themselves did not.

- **"Also delete the copy in my Drive" is asked at the moment it applies.** It was a checkbox sitting
  permanently on the settings page, above the disconnect button, which read like a preference about
  some future deletion. It is a question about one action, so it is now asked when you press *Switch
  back to Chrome sync* — still off by default, still explaining what leaving the file costs.

- **"Destroy my vault" now really destroys it, sync included.** It used to erase only this computer's
  copy and leave the encrypted one in sync — so the extension came straight back offering to restore
  the vault you had just destroyed, and if you made a new one instead, even with the same master
  password, the two could never sync with each other: a new vault gets a new key, and nothing can
  open the old copy with it. The result was a permanent *"The synced copy belongs to a different
  vault"* that nothing on screen could clear. Destroying now removes the synced copy as well, and
  says which of the two things it managed. There is a checkbox to leave the synced copy behind, for
  the one case that is really for — another computer is still using the vault — and it explains what
  unticking it costs.
- **A vault mismatch has a way out.** When two vaults end up sharing one sync area, Settings → Sync
  now offers *"Overwrite the synced copy with this vault"*, and explains the alternative: move this
  vault to Google Drive and leave the other where it is. Before, the message named the problem and
  the only thing you could click was the sync status itself — which retried the merge that cannot
  work and looked like it did nothing.

- **Building with Google Drive configured now actually works.** `VM_OAUTH_CLIENT_ID` and
  `VM_MANIFEST_KEY` were documented as living in a gitignored `.env.local`, but nothing read that
  file: Vite does not load env files into `process.env`, so the build saw neither value and produced
  a package with no Drive support, which then correctly reported itself as having no Google project.
  `vite.config.ts` now loads them properly, an environment variable still works for CI, and
  `.env.example` is there to copy. Affects people building from source only — the published package
  is unchanged.

- **Pinning a development build's extension ID is one command**, `npm run dev-key`. It replaces a
  two-tool recipe that needed Chrome and OpenSSL on the path, produced a `.crx` only to discard it,
  and left the ID to be read off `chrome://extensions` afterwards. The new script prints the ID it
  produces and refuses to overwrite an existing key without `--force`, because a new key is a new ID
  and would silently unbind an OAuth client already registered against the old one. Build tooling
  only; nothing in the extension changed.

- **`drive.file` needs no OAuth verification, and the docs said it did.** RELEASE, ARCHITECTURE and
  PLAN all described the scope as *Sensitive* and budgeted a consent-screen review with a demo video
  into the release schedule; it is **non-sensitive**, the only Drive scope that is, and apps using
  only non-sensitive scopes are exempt from verification altogether. What publication does require
  is moving the consent screen out of Testing status — whose seven-day refresh-token lifetime would
  otherwise break Drive weekly, and only for users not signed into Chrome. Documentation only.

### Removed

- **The setup guide no longer has a screen section about Chrome's own address suggestions.** It asked
  you to open a Chrome settings page and switch something off there. VaultaMark cannot open that
  page, cannot change the setting, and cannot check afterwards whether it was changed — so it was the
  one part of setup nobody could actually finish in the guide. The point it made is real and is in
  `docs/PRIVACY.md`, which is where something we cannot do anything about belongs.

### Added

- **Previews now show what the page says about itself, not just its picture.** A preview card
  carries the page's own headline and one-line summary underneath the image — the same two things
  you see when a link is pasted into a chat app. VaultaMark has been reading and encrypting them
  since previews arrived; they simply had nowhere to appear until now.
  - **Pages with no picture get a card too.** Most of the web publishes no preview image, and a
    good deal of it still says what it is about in a sentence. Those bookmarks used to show
    nothing at all; now the eye appears on the row and opens their words.
  - Nothing new is fetched, stored or asked for. This is text that was already in your vault.

- **You can now put your bookmarks in your own order.** The sort menu has a sixth entry, *My own
  order*, and under it you can drag a bookmark between two others to place it exactly where you
  want — a line shows where it will land, which is how you can tell it apart from dropping it
  *into* a folder. Folders in the sidebar can be dragged between their neighbours the same way,
  which also moves them into or out of nesting.
  - **The keyboard does all of it**: **Alt+↑** and **Alt+↓** move whatever is selected one place,
    in the list and in the folder tree alike. Hold a multiple selection and it travels together.
  - Reordering is offered only where a position is a thing you can see: under *My own order*,
    inside a folder, with the search box empty. Everywhere else — a search, a tag, *Untagged*, or
    any of the five orders VaultaMark works out for you — the gesture is simply not offered, rather
    than accepted and then quietly ignored. Pressing the shortcut there says so.

- **A "create a diagnostic report" button**, in Settings → About. Reporting a problem with an
  encrypted bookmark manager is awkward: "sync stopped working" is not enough to act on, and the
  obvious way to say more is the one thing this extension exists to prevent. So the button produces
  a short report of counts and settings — how many bookmarks, which sync backend, what the last
  sync error was, which permissions you have granted — and **no addresses, titles, folder or tag
  names, notes, account details or tokens of any kind**. It is shown to you in full before anything
  is copied, so you can read what you are about to paste; and if Chrome refuses the clipboard, the
  report stays on screen to copy by hand.

### Changed

- **A real icon.** The blue square with a bookmark on it was a placeholder from the first week. The
  icon is now a bookmark with a keyhole cut through it — the two things this extension is, in the
  order you read them. The 16- and 32-pixel versions are drawn separately rather than shrunk, since
  the keyhole's slot is smaller than a pixel at that size and turned into a smudge.

- **Connecting or disconnecting Google Drive now says which step it is on.** It used to say "Asking
  Google for permission…" and then nothing else — through the authorization, the copy of your whole
  vault, the read-back that checks the copy arrived intact, and the switch. On a slow connection
  that is a screen that looks frozen for a minute. Disconnecting no longer claims to be asking
  Google for anything, either, which was never true in that direction.
- **Every screen is now checked for accessibility, not just the main one.** VaultaMark has two HTML
  files and about a dozen screens, and each is a different thing to a screen reader — the setup
  flow's five steps, the popup's four, the manager's list, dialogs, settings, import and export, and
  the incognito prompt. All of them are now audited automatically on every change, for labelling,
  structure and 4.5:1 contrast in both light and dark. `docs/ACCESSIBILITY.md` is new and lists
  every keyboard shortcut in the product, along with the three things a keyboard genuinely cannot
  do and why.
- **A screen reader is told more of what is on screen.** The unlocked popup now has a name of its
  own instead of answering "where am I" with the product name, exactly as the locked one does; the
  bookmark list says which keys do what, which a sighted user reads off the toolbar; and the
  expand arrows beside folders are no longer read out as part of the folder's name, while gaining
  a tooltip for the mouse.

- **Size and speed are now measured on every build and refused when they slip.** The package is
  156 KB zipped against a 400 KB ceiling; the popup paints in under 30 ms against a 100 ms one.
  Nothing about this is visible, which is the point — a bundle grows one import at a time and the
  day it crosses a line is not a day anybody notices.

- **The build toolchain was taken to Vite 8, Vitest 4 and ESLint 10 in one deliberate step**, which
  clears every outstanding dependency advisory: `npm audit` now reports none at all, where it had
  been reporting five. Nothing about this reaches an installed extension — VaultaMark ships zero
  runtime dependencies, and the package is byte-for-byte the same shape as before — but a
  development toolchain nobody has updated is a supply-chain problem in a security tool, and this
  is where the project had scheduled paying it off.
  - Vite 8 bundles with Rolldown rather than Rollup. Three consequences were real enough to be
    worth recording: the minifier is now `oxc` (Vite 8 ships no esbuild), the build plugin has to
    re-emit the two HTML documents rather than move them inside the bundle (Rolldown ignores that
    assignment, which had silently produced a package containing no HTML at all), and the Vite
    config is loaded by Node's own type stripping, so its imports name their extensions.

- **The setup guide no longer says Google Drive is "coming in the next release".** It is here; the
  comparison table marks it *Optional*, and Settings → Sync connects it whenever you want.
- `build/url-allowlist.json` gained `https://oauth2.googleapis.com/` — the OAuth token endpoint,
  reached only by the sign-in fallback for Chrome profiles that are not signed into Google. No new
  permission: `identity` and the Google APIs origin have been declared optional since the first
  release, and both are still requested only when you connect Drive.

- **Installing VaultaMark now opens a five-screen setup guide**, once, on first install and never on
  an update. It covers what the extension is for, creating your master password, allowing the
  extension in incognito, which sync tier you are on, and — last — the two things Chrome still does
  that a vault cannot reach.
  - **The no-recovery warning cannot be skipped.** There is no password recovery of any kind, and the
    only way past that screen is to create a vault, which means typing the confirmation sentence. No
    button, no keyboard shortcut and no reload gets around it.
  - **Allowing incognito can be postponed but not ignored.** It is a Chrome checkbox no extension is
    allowed to reach, so the screen explains it, hands you the address to paste, and re-checks on
    demand. Choosing *Skip for now* is a real answer — and leaves a reminder in the manager that
    clears itself the moment you turn the setting on.
  - The sync screen puts Chrome sync and Google Drive side by side with what each actually gives you,
    including the ways Chrome sync is smaller. Drive is marked as arriving in a later release rather
    than hidden, so nobody chooses in the dark.
  - You can run the guide again at any time from **Settings → About**. It changes nothing — your
    vault, password and settings are untouched.
- **Vaulted pages can be cleared out of Chrome's history.** Saving a page to the vault never put it
  in Chrome's bookmarks, but a page you *visited* before you saved it is still in your history,
  still autocompleting in the address bar. Settings → Privacy now finds those entries and removes
  them.
  - **It shows you the count and the list before it deletes anything**, and asks once more after
    that. "This will remove 143 entries across 27 sites" — with the sites, so you can disagree.
  - **It only ever touches sites that are in your vault.** Chrome's history search matches on
    substrings, so asking it about `example.com` also returns `notexample.community` and a blog post
    that merely mentions the name. Every result is re-checked against the real site name before
    anything is deleted, using a bundled copy of the Public Suffix List — which is what makes
    `bbc.co.uk`, `example.com.au` and one person's `alice.github.io` come out right instead of
    taking every British site, every Australian site, or everybody's GitHub Pages with them.
  - The permission to read and delete history is asked for **at that moment**, with the reason on
    screen, and never at install. You can hand it straight back.
  - Two optional extras, both off by default and both plainly labelled as deleting real browsing
    history: **clear vaulted sites on every lock**, and **quick-close** (Ctrl+Shift+X) — close the
    current tab and delete that site's history in one keystroke.
- **Settings gained a Privacy section and an About section.** Privacy holds the history tools. About
  holds the version, the licence, what the extension does and does not do with your data, and the
  button that replays the setup guide.
- **You can get your bookmarks out, and back in again.** *Import & export* in the manager saves an
  encrypted `.vmv` file holding every bookmark, folder, tag and note — locked with your vault
  password or with one of its own, whichever you choose. It is a file you can keep anywhere: on a
  drive, in a backup, in a cloud folder, all of which can read it exactly as well as they can read
  your vault, which is to say not at all. It is also the answer to the question the rest of
  VaultaMark cannot answer on its own: what happens when the computer is gone.
- **Opening a backup shows you what is in it before anything changes** — how many bookmarks, how
  many folders, when it was made, and how much of it this vault already has. Then you choose:
  **merge** it into what you have, or **replace** everything with it.
  - Merge never destroys anything. New bookmarks are added; where the file and your vault disagree
    about the same bookmark, both versions are kept and you settle it afterwards, on the same screen
    that settles disagreements between two computers. That includes a bookmark you deleted after the
    backup was taken: the file says it is alive and your vault says it went, and a merge asks rather
    than quietly undoing your deletion.
  - Replace asks twice — a typed phrase, then a second confirmation naming the number of bookmarks
    about to go — and keeps a copy of your old vault for **24 hours**, so the wrong file is one
    button away from being undone rather than a disaster.
- **A wrong password and a damaged file say different things.** "That password does not open this
  backup" sends you to look for the password; "this file is damaged" sends you to your other copy.
  Getting those two the wrong way round is how a good backup ends up deleted, so the file is built
  to tell them apart.
- **Import the bookmarks already in this browser.** VaultaMark asks for permission to read them only
  when you use this, shows the tree with checkboxes, and copies what you tick into the vault with
  the folder structure intact. You can hand the permission straight back afterwards.
- **Deleting the browser's copies is a separate step, and it is the one that matters.** Copying a
  bookmark into the vault does not take it out of the address bar's suggestions — deleting Chrome's
  own copy does. So it has its own button, its own confirmation and its own summary of exactly what
  will go. Nothing is ever deleted from Chrome as a side effect of an import.
- Long imports and exports show a progress bar rather than a window that has stopped responding.
- **Your bookmarks are on your other computers now**, with nothing to set up. Every Chrome signed
  into the same Google account gets the same vault, still encrypted — Google replicates a blob it
  cannot read, and VaultaMark makes no network request of its own to make that happen. There is a
  line in the toolbar saying when it last synced; clicking it syncs now.
- **Setting up your second computer is just your master password.** Install VaultaMark on another
  Chrome profile signed into the same account and it says *there is already a vault on your other
  computer* — type the password and this machine joins it, with every folder, tag and note. There is
  nothing to export, copy across or scan, because everything needed to open the vault is already in
  the encrypted copy Chrome synced over. If you would rather keep a separate vault on that computer,
  you can, and it says up front that the two will not sync with each other.
- **A vault edited in two places at once is merged, not overwritten.** Rename a bookmark on the
  laptop and add a note to it on the desktop, and you end up with both. Tags added on either machine
  are kept, tags you removed stay removed, and a bookmark deleted on one machine does not come back
  from the other.
- **When two devices genuinely disagree, you are asked.** Change the same field on both, or edit
  something on one machine that you deleted on the other, and nothing is thrown away: a banner
  appears, and a page shows both versions side by side with the fields that differ marked. Keep this
  device's, keep the other one's, or keep both. Until you decide, the disputed bookmark shows this
  device's version and everything *else* in your vault keeps syncing normally — a disagreement about
  one bookmark does not hold up the rest.
- **Settings shows how full Chrome sync is**, with a bar that changes colour at 70 % and again at
  95 %. Chrome's storage is small — around a thousand bookmarks, fewer if you write long notes — and
  the warning arrives early enough to be a decision rather than a rescue. Google Drive, which holds
  far more, arrives in a later version.
- **There is a manager now** — a full page rather than a popup, and the place the vault actually
  lives. Folders down the left with the count of everything inside them, your bookmarks in the
  middle, and whatever you have selected on the right, ready to edit.
- **Folders, nested as deep as you like.** Deleting one asks what should happen to what is inside:
  keep it, one level up, or delete it too. There is no default and no preselected answer, because
  one of those two loses a subtree and the other rearranges your tree.
- **Tags and notes on any bookmark.** Tags are chips rather than a comma-separated box, so what you
  see is what gets stored. Renaming a tag renames it on every bookmark that carries it, from the
  sidebar. Notes hold about four thousand characters, with a counter, and are truncated rather than
  refused — nobody should lose what they typed to a limit they could not see coming.
- **Search that understands what you are asking.** Bare words match titles, addresses, tags and
  notes; `tag:`, `folder:`, `host:` and `in:note` narrow it. Matches are highlighted in the results,
  so it is clear *why* something matched. It searches the whole vault, or just the folder you are
  standing in.
- **Sorting** by date added, date modified, title, recently opened or most opened, and it is
  remembered. A search with real words in it is ordered by best match instead — a result that is
  third because it happens to be older is a search that failed — and the control says so rather than
  sitting there doing nothing.
- **Select many and act on them at once.** Click, ctrl-click, shift-click for a range, or select
  everything in view; then move, tag, untag or delete the lot. A bulk delete is one **Undo**, not
  one per bookmark. If any part of a bulk action is impossible, none of it happens — you are told,
  rather than left with half of it done.
- **The keyboard works.** `/` jumps to search, `j`/`k` walk the list, Enter opens, `e` edits, Delete
  removes, Escape clears. The folder tree takes arrow keys the way a tree should.
- **Five thousand bookmarks scroll smoothly**, because only the rows on screen exist. Screen readers
  are still told the real size of the list, not the size of the window onto it.
- **Settings moved somewhere they fit**, and gained two things the popup had no room for: changing
  your master password — which re-wraps a 32-byte key and leaves every bookmark exactly where it
  was, so it is instant however large your vault — and destroying the vault, behind a typed phrase
  and then a second confirmation.
- An accessibility pass over the whole manager: it is one tab stop per region rather than one per
  row, every control has a name, selection is marked with a bar as well as a colour, and automated
  checks find no critical or serious problems.
- **Drag bookmarks into folders** — onto a folder in the list, onto one in the sidebar, or onto
  **All bookmarks** to bring them back out. Dragging one of several selected bookmarks takes all of
  them. A folder cannot be dropped inside itself, so the gesture refuses instead of failing. Nothing
  about a bookmark travels on the drag itself: what leaves the page is a list of internal ids, never
  a title or an address, because a drag can end in any other application on your computer.
- **The columns can be resized.** Drag the divider beside the sidebar or the detail pane, or focus
  it and use the arrow keys; double-click restores the default. The widths are remembered, and both
  panes now start wider than they did.
- Dialogs say *why* they will not close. Renaming a tag to nothing, or opening the bulk-tag box and
  filling in neither field, used to look like a broken button.

- **You can put bookmarks in the vault now, and open them.** Four ways to save the page you are
  looking at: the **Add this page** button in the popup, **Add to VaultaMark** in the right-click
  menu, **Add link to VaultaMark** on a link you have not opened, and
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>. The keyboard shortcut and the right-click menu have
  no window to answer in, so they report on the toolbar button itself — a tick, or a reason.
- **The popup is the vault**: every bookmark you have, newest first, in a list that scrolls — no
  "showing 20 of 143" between you and your own collection. A filter box that searches the whole
  vault rather than just what is on screen, a favicon and a host on every row, and one click to open.
  Deleting shows an **Undo** for eight seconds, and undo brings back the same bookmark rather than
  making a second copy of it — which matters once your other computers are involved.
- **Bookmarks open in an incognito window**, which is the point of the whole thing: the address never
  reaches your history or the address bar's suggestions. Chrome only lets an extension do that once
  you switch on "Allow in Incognito" by hand, and there is no way for us to ask you in a dialog — so
  until you have, nothing opens and you get a page that explains it, hands you the address to paste,
  and re-checks when you come back. If you would rather open something in a normal window this once,
  there is a button that says exactly that, and what it costs. By default every bookmark opens in the
  incognito window you already have, rather than piling up a window each.
- **Favicons come from Chrome's own cache** and nothing else. A favicon service would hand every site
  in your vault to a third party every time the list drew itself, which would undo the point of
  vaulting them. Sites this browser has never visited get a coloured initial instead.
- Adding a page you already have says so, and offers to open it, instead of quietly making a
  duplicate. Pages the browser will not let us reopen later — its own settings pages, files on your
  computer — are refused when you save them, with the reason, rather than becoming an entry that
  does nothing when clicked.
- Two new settings, both in the popup: **reuse the incognito window I already have open** (on), and
  **remove tracking parameters when saving** (off — a few sites need parameters that look like
  tracking, and rewriting what you saved is not something to do quietly).
- **The extension does something now.** Click the toolbar button and you can create a vault, unlock
  it, lock it, and choose when it locks itself. There is still nothing to *put* in it from the
  interface — adding bookmarks arrives in the next phase — but the vault underneath is the real one.
- Creating a vault asks you to **type a phrase to confirm** you have understood that there is no
  password recovery. Not a checkbox: a checkbox is a reflex, and this is the one mistake nobody can
  undo for you. The phrase is matched loosely — capitalisation and stray spaces do not count — since
  the point is that you read it, not that you can copy a string. The strength meter is live as you
  type, and a password weaker than "good" asks a second time before it is accepted — it is never
  refused. Fewer than 10 characters is refused, and the create button says which requirement it is
  still waiting on rather than sitting there greyed out.
- **The vault stays unlocked while you work, and locks itself when you stop.** Default 10 minutes of
  inactivity, selectable between 1 minute and an hour, or *Never*. Chrome shuts our background
  process down every 30 seconds or so of idle; the vault survives that without asking for your
  password again, and locks on the deadline regardless of whether Chrome remembered to wake us. Even
  on *Never*, the vault locks when you close Chrome — the key is never written to disk.
- Optional **lock when you switch to another app** (off by default). It locks the moment Chrome loses
  focus, so you re-enter your password on every switch back — worth it for some people, and not the
  sort of thing to turn on for you. Moving between Chrome windows does not lock, so opening a
  bookmark never locks the vault behind it. Also a **panic lock** on
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> that drops the key immediately and closes the
  extension's own windows. A lock you asked for finishes saving first; a panic lock does not wait.
- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> opens the manager page. All shortcuts are rebindable
  at `chrome://extensions/shortcuts`.
- Old deleted bookmarks are cleared out on a background schedule once their 90 days are up, rather
  than only when something else happens to touch the vault.
- **The vault itself** (`src/vault/`, `src/storage/`). There is a real, working, encrypted bookmark
  vault now: it can be created with a master password, unlocked, filled with bookmarks and folders,
  searched, locked, and reopened. There is still no interface to any of it — the popup and the
  manager page arrive in the next phase — but everything underneath them is in place and tested.
- Bookmarks live in a tree of folders, with tags, notes and free ordering. Deleting something leaves
  a tombstone rather than a hole, so a delete on one computer is not quietly undone by another
  computer that was switched off at the time; tombstones are cleaned up after 90 days.
- Search over titles, addresses, tags and notes, built fresh each time the vault is unlocked and
  discarded when it locks. It is never written to disk — a search index is your bookmarks
  rearranged, and storing one would undo the encryption. Accents fold, so `beyonce` finds `Beyoncé`,
  and partial words match: `github` finds `https://github.com/…` without your having to type the
  address.
- Your vault is stored in **sixteen separately-encrypted buckets** rather than one blob. Editing one
  bookmark rewrites one bucket, not the whole collection. That is what will make syncing through
  Chrome's small storage quota practical in a later phase, and it means a burst of edits costs one
  write instead of one per keystroke.
- **Changing your master password re-encrypts 32 bytes and nothing else.** No re-encryption of the
  vault, no long conversion, no window in which half your bookmarks are readable with the old
  password and half with the new one. Your bookmarks themselves are never touched.
- The vault format is versioned, with a migration path that runs against a committed test fixture
  rather than existing only in theory. A vault written by a *newer* VaultaMark refuses to open and
  says so, rather than silently discarding whatever the newer version added.
- A test asserts the promise this product is built on: after adding, editing, deleting and reopening
  a vault, no title, address, tag, note or folder name can be found anywhere in the extension's
  storage — not in plain text, and not merely encoded. The only thing readable is the header, which
  holds the key-derivation settings it must hold, plus how many buckets exist and how many times the
  vault has changed.
- The cryptography that the vault will be built on (`src/crypto/`). Nothing is stored or encrypted
  yet — no UI reaches it — but the primitives are complete, specified and tested: PBKDF2-HMAC-SHA256
  at 600,000 iterations turns your master password into a key-encryption key; that unwraps a random
  256-bit data key; and HKDF splits the data key into separate keys for bookmarks, thumbnails and
  integrity tags, so no key is ever used for two jobs. Bookmark data is gzipped, padded to a
  256-byte boundary so its size gives little away, and sealed with AES-256-GCM.
- **There is still no password recovery, by design.** A wrong password is detected because the data
  key fails to decrypt, and nothing distinguishes "wrong password" from "no vault for you" — there
  is no verifier stored anywhere and no back door to add one to.
- A master-password strength meter that runs entirely on your machine: length, character variety,
  keyboard walks, repeats and sequences, plus a bundled list of ~2,000 common passwords that is
  checked after undoing leetspeak, so `P@ssw0rd!!` is recognised for what it is. Passwords must be
  at least 10 characters; below "good" you are warned, never blocked. The list ships with the
  extension and is never looked up over the network.
- Known-answer tests against published vectors — RFC 6070 and pinned PBKDF2-SHA256 vectors for the
  key derivation, RFC 5869 for HKDF, the NIST-referenced GCM vectors for the cipher — plus a pinned
  sample of VaultaMark's own sealed format, so an accidental change to the on-disk layout fails a
  test instead of silently making existing vaults unreadable. Every single-bit change to a sealed
  blob is tested to be rejected.
- `crypto.subtle` is now confined to `src/crypto/` by an ESLint rule, and that directory carries a
  90 % line / 85 % branch coverage gate.
- The extension now builds and loads: `npm run build` produces a Manifest V3 package in `dist/`
  that Chrome accepts via **Load unpacked**. It does nothing yet — a placeholder popup that reports
  the build version and whether the background service is running, an empty manager page, and a
  service worker that answers a heartbeat. The vault, the UI and sync arrive in later phases.
- Toolchain: TypeScript (strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`),
  Vite 5 with an in-repo MV3 build plugin, ESLint 9 with type-aware rules, Prettier, Vitest with
  coverage gates, and a Playwright harness. **Zero runtime dependencies**, as designed.
- `manifest.json` is generated from a typed source (`build/manifest.ts`): the six required
  permissions and no host permissions at install time, optional `identity`/`history`/`bookmarks`/
  `idle`, `incognito: "spanning"`, the strict CSP, the three keyboard shortcuts, no content scripts,
  and nothing exposed to web pages.
- Invariant scanners that run against the real build output, not the source: `verify-manifest.mjs`
  (Manifest V3, exact CSP, permission set diffed against `build/permissions.lock.json`) and
  `verify-no-remote-code.mjs` (`eval`, the `Function` constructor, remote or computed `import()`,
  `importScripts`, WASM, `sendBeacon`, `XMLHttpRequest`, `blob:`/`data:` script URLs, and any
  absolute URL outside `build/url-allowlist.json`). Both run in `npm run verify` and in CI, and the
  same bans are enforced at the source level by ESLint.
- `npm run zip` packages `dist/` into `release/vaulta-mark-<version>.zip` — deterministic, so a
  published zip can be hash-compared against a local build — excluding source maps, and printing
  the archive's SHA-256.
- A `chrome.*` test mock that enforces `chrome.storage.sync`'s real limits: per-item and total byte
  quotas, item count, and both write-rate ceilings, against an injectable clock.
- `.github/workflows/ci.yml` — lint, type-check, test with coverage, build, and the invariant
  scanners on every push to `dev`/`main` and on every pull request.
- `.github/workflows/codeql.yml` — CodeQL for JavaScript/TypeScript. Code scanning generally needs
  GitHub Advanced Security on a private repository, so this may not run until the repository is
  public (see `docs/BRANCH_PROTECTION.md` §5).
- `docs/DEVELOPMENT.md` — how to build, load the extension in Chrome, run each test tier, and what
  the invariant scanners check.
- `LICENSE` — GPL-3.0-only, the verbatim license text.
- `CONTRIBUTING.md` — branching model, Conventional Commits, DCO sign-off, how to run the test
  suite, the zero-runtime-dependencies rule, and the crypto-changes-need-an-issue-first rule.
- `SECURITY.md` — private reporting via GitHub Security Advisories, 90-day coordinated disclosure,
  what is in and out of scope, the no-warranty statement, and the no-password-recovery statement.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- Issue templates for bug reports and feature requests, a pull-request checklist, and an issue-chooser
  that routes security reports to the private advisory form instead of a public issue.
- `.github/dependabot.yml` — weekly npm and monthly GitHub Actions updates, minor and patch bumps
  grouped into one pull request per ecosystem.
- `docs/PRIVACY.md` — privacy policy: nothing is collected, no server exists, and the only network
  traffic is to the user's own Google Drive once they connect it.
- `docs/STORE_LISTING.md` — Chrome Web Store drafts: descriptions, single-purpose statement,
  per-permission justifications, data-usage answers, and the asset checklist.
- `docs/BRANCH_PROTECTION.md` — the branch, tag, and repository settings a maintainer applies by
  hand, and the reason CI cannot block a direct push.

### Changed

- **The manager's settings are a full screen instead of a small dialog.** They had grown to eight
  sections read through a box a third of the window wide, which meant scrolling twice — once inside
  the dialog and once past it. They now take the whole window, like *Import & export*, and lay out in
  two columns when the window is wide enough, so most of the settings are visible at once.
- **The reminder about Chrome's own address suggestions is in the setup guide only.** It was in
  Settings → Privacy as well, and it is a one-time instruction to change something in Chrome rather
  than anything VaultaMark controls — a permanent copy of it sat among the toggles as a section that
  could never be finished. *Settings → About → Replay the setup guide* is the way back to it.
- **The vault-creation screen is one screen now, not two.** The popup and the setup guide were about
  to have their own versions of the same question, and a no-recovery warning that is a typed sentence
  in one window and something weaker in the other is two products. Both use the same form.
- **The security settings say the vault always locks when Chrome restarts**, rather than offering it
  as a switch. It has always been true — the unlocked key is held in memory only and goes when Chrome
  exits — and a toggle that can only ever be on is a claim about control that does not exist.
- The extension declares a fourth keyboard shortcut, **Ctrl+Shift+X** for quick-close. It does
  nothing at all until you switch quick-close on in Settings; it is declared from the start so it is
  visible on Chrome's shortcuts page, where you can move it off a combination you already use.
- **There is no unencrypted export.** One was built — a plain bookmarks file any browser can
  import, behind a typed `EXPORT UNENCRYPTED` and a warning written into the file itself — and then
  removed, because the gate was the only good thing about it. Importing such a file into a browser
  puts every address back into the suggestions VaultaMark exists to keep them out of, which is the
  product running backwards. The encrypted `.vmv` backup is how a vault leaves VaultaMark.
- **The backup dialog only asks you to repeat a password when there is a new one to repeat.**
  Choosing *use a different password* brings the second field out; using your vault password does
  not show a box you are not allowed to fill in.
- A password that turns out to be wrong is now answered **in the dialog you typed it into**, with
  the file you picked still selected — rather than closing it and leaving a red line on the page
  behind, which cost you the file as well as the password.
- The **Choose file** button now looks like the other buttons around it rather than like a piece of
  the browser that wandered in.
- **Deleting a bookmark asks first**, in the popup and in the manager alike, in the same words and
  the same dialog. **Undo** is still there afterwards — it is the safety net for the delete you
  meant, while the question is for the "×" your pointer found on its way to the row, and for the
  Delete key pressed at a list you had not noticed was focused.
- **The undo offer shows how long is left**, as a shaded band that fills across the message and
  reaches the far edge exactly as the offer expires — rather than a number in the dialog before it.
  How long you have to change your mind matters after the delete, not a second before it.
- **Tracking parameters are removed by default** when you save a page. They are campaign tags —
  `utm_*`, `fbclid`, `gclid` — that no site needs to find the page, and leaving them made the same
  article saved from two newsletters look like two bookmarks. Turning the setting on offers, once
  and only if you have any, to clean the addresses already in your vault; nothing is rewritten
  without you pressing the button that says so, and nothing is ever deleted.
- **The popup's settings are a screen of their own**, reached from the row of buttons along the
  bottom — **Lock now**, **Open the manager**, **Settings**, spread across the width so each keeps
  its own place — instead of an expander that pushed the list around when it opened. The version
  number lives on that screen now, which gave the bookmark list back the line it was using in the
  corner: that corner is **Add this page**.
- **The popup is one size, whatever it is showing.** It used to grow when you opened the settings
  and shrink when you came back, moving the buttons under your pointer. It is now as tall as Chrome
  will allow a popup to be and a tenth wider than before, so the bookmark list gets every row that
  fits, and titles and addresses get about six more characters before they are cut off.
- The popup keeps its settings, and they are now also in the manager, where there is room to explain
  them.
- The popup is a real interface rather than a build-version placeholder, and both extension pages now
  share one set of design tokens with light and dark themes.
- Every button in both pages now responds to the pointer, from one set of hover rules rather than a
  per-component decision — a button that does nothing when you hover it reads as a button that is
  switched off.

### Fixed

- Work that has to happen at the moment the vault locks — clearing history for vaulted sites — would
  have been skipped most of the time. The service worker is shut down every thirty seconds or so, and
  the lock that matters is usually the one that wakes it back up: an idle timer, or a click on a
  popup that has just started. It now reopens the vault for that last piece of work rather than
  finding nothing there and moving on.
- The manager's three-column layout stayed on screen underneath the conflict screen — invisible only
  in the sense that something else was drawn over it, and still taking the clicks meant for what was
  on top.
- **An import preview could claim more bookmarks were already here than the file contained** —
  "38 of them are already in this vault" under a line reading "28 bookmarks in 1 folders". It was
  counting deleted bookmarks the file still carries, which the two numbers above it do not. A count
  larger than the thing it is a subset of is not a preview, it is a reason to distrust the screen.
- The import preview's counts now agree with themselves: "1 bookmark in 1 folder", "One of them is
  already in this vault", and a backup with no folders in it says so rather than reading "in 0
  folders".
- **A merge import that finds disagreements now takes you straight to the screen that settles
  them**, instead of announcing a number on a page that cannot act on it.
- **Long operations say they are working.** Opening a backup, sealing one, and applying an import
  each spend over a second deriving a key from your password before there is anything to count —
  during which the dialog or the page used to sit there looking like it had swallowed the press.
- The **Confirm password** field in the backup dialog stayed on screen when *use my vault password*
  was selected, despite being marked hidden.
- Focus outlines were cut off on every full-width box in the popup — the master password, its
  repeat, the typed confirmation and the bookmark filter — by the box that scrolls them. The
  bookmark filter lost the top of its outline as well, being the first thing in that box, and the
  bookmark list's scrollbar sat in the same column as the outline's right edge, crowding it.
- **Long lists of conflicts could not be scrolled.** The conflict screen and the import/export
  screen were both taller than the window with nothing to scroll them, so anything past the fold was
  simply gone — with nine disagreements to settle and four of them reachable, and no scrollbar
  anywhere to say the rest existed. Both screens scroll now.
- **Two screens could be on the page at once.** Opening import/export from the conflict screen left
  both, one under the other; and settling the last conflict while looking at import/export brought
  the bookmark list back on top of it. The manager now shows exactly one of its three screens at a
  time.
- **Importing this browser's bookmarks twice made a second copy of every folder.** The bookmarks
  inside were correctly recognised as ones the vault already had, so what it left behind was a set
  of empty duplicate folders beside the real ones. A folder is now matched to the one already in the
  same place under the same name, and importing the same selection again adds nothing.
- The focus outline on a password field in a dialog was sliced off at both edges by the box around
  it.
- The "Allow reading bookmarks" button sat hard against the paragraph above it while every other
  button on that screen was spaced away from its own.
- Nothing was lost to a browser that closed mid-sync. A sync that is interrupted after writing part
  of the vault leaves a copy that does not add up; the next device to look at it notices, and repairs
  it from its own copy rather than reading half a vault.
- The popup's **Undo** disappeared after about three seconds instead of the eight it offers. Deleting
  a bookmark schedules a sync; the sync settled a moment later, and the popup rebuilt itself on the
  news — taking the undo with it. It now lasts as long as it says.
- Double-clicking a folder in the manager's list selected it twice and opened nothing. It opens the
  folder now, the way double-clicking a folder does everywhere else.
- Folder names in the sidebar sat adrift in the middle of their row while the tags underneath
  started at the left edge — two lists in one column, indented differently for no visible reason.
  Both start at the left now.
- The sidebar had a horizontal scrollbar along the bottom at every width, because the folder rows
  were three pixels wider than the column they were in. Long tag names now shorten with an ellipsis
  instead of pushing the rename button out of view.
- Clicking a bookmark in the manager did not give the list the keyboard, so the arrow keys scrolled
  past the row you had just selected instead of moving to it, and Delete did nothing at all. Both
  work now, on the row you clicked.
- Picking a tag in the sidebar and then **Untagged** kept showing the tagged bookmarks, with both
  entries lit up as if they were somehow both true. Going somewhere clears the filter that got you
  there, and a tag now filters your whole vault rather than quietly only the folder you were
  standing in.

- Opening a bookmark recorded that you had opened it 300 milliseconds later, which Chrome was free to
  never get around to — the count and the timestamp could be lost. They are written immediately now,
  which matters because you can sort by them.
- Two bookmarks saved in the same millisecond could swap places between one look at the list and the
  next. The order is now fully determined, so a list that has not changed does not rearrange itself
  under you.
- The 10-character minimum master password is now enforced where the vault is written, not only in
  the interface — so no future code path can create a permanently weak vault by forgetting to check.
  Length is counted in characters as a person counts them, so ten emoji are ten characters.
- Documentation now states that the repository is **private for now** and that publishing the source
  is a later decision — including what that blocks (GitHub Pages for the privacy-policy URL, private
  vulnerability reporting, the Store listing's repository link) and a checklist for the day it
  changes.
- `README.md` — filled in: the five differentiators, how the encryption works, what the vault does
  and does not protect against, the two sync tiers, the permission table, and the no-recovery
  warning. Screenshots and install instructions follow the first release. The Development section
  now points at `docs/DEVELOPMENT.md` and describes a toolchain that exists.

<!-- Sections are added as they are needed: Added · Changed · Deprecated · Removed · Fixed · Security -->

[Unreleased]: https://github.com/zyndata/vaulta-mark/compare/v1.0.0...dev
[1.0.0]: https://github.com/zyndata/vaulta-mark/releases/tag/v1.0.0
