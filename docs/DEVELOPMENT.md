# VaultaMark — Development

Everything you need to build, load, and test the extension locally.

**Requirements:** Node 24 LTS (pinned in [`.nvmrc`](../.nvmrc)) and npm. Nothing else — no global
tools, no Docker, no browser download for the unit tests.

```bash
npm ci          # exact dependency tree from package-lock.json
npm run verify  # the gate: lint + type-check + test + build + invariant scan
```

---

## 1. The scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite build in watch mode. Rebuilds `dist/` on every save. |
| `npm run build` | Production build → `dist/`. |
| `npm run zip` | Packages `dist/` → `release/vaulta-mark-<version>.zip` and prints its SHA-256. |
| `npm run update-psl` | Refetches the Public Suffix List into `src/history/public-suffix.ts`. **Manual, and deliberately so** — that list decides which history entries a cleanup deletes, so it is never fetched at runtime and every refresh is a reviewed diff (ARCHITECTURE §12.1). |
| `npm run test` | Vitest unit + integration, with coverage and its thresholds. |
| `npm run test:watch` | Vitest in watch mode, no coverage. |
| `npm run test:e2e` | Playwright, against a **built** `dist/`. See §5. |
| `npm run lint` | ESLint (type-aware) over `src/`, `test/`, `build/`, `scripts/`. |
| `npm run format` | Prettier over the code (not the Markdown — prose is wrapped by hand). |
| `npm run type-check` | `tsc --noEmit` over the whole repository. |
| `npm run verify:invariants` | The INV-1/2/3/8/9 scanners, against the real `dist/`. |
| `npm run verify` | All of the above in the order CI runs them. **Run this before every push.** |

`npm run verify` is the real gate. CI runs the same steps, but GitHub can only *require* a status
check on a pull request, and this repository pushes straight to `dev` — so CI is the backstop that
catches what the local run missed, not the thing that stops a bad commit.
See [BRANCH_PROTECTION.md](BRANCH_PROTECTION.md).

---

## 2. Loading the extension in Chrome

1. `npm run build`
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. **Load unpacked** → select the `dist/` directory
5. For anything involving opening a vaulted link: open the extension's **Details** page and turn on
   **Allow in incognito**. The manifest is `"incognito": "spanning"` (D29), so the same service
   worker — and the same unlocked session — serves incognito windows.

While `npm run dev` is running, Chrome does **not** reload the extension by itself. After a
rebuild, press the **reload** ⟳ button on the extension card. Reloading the extension restarts the
service worker, which clears `chrome.storage.session` — i.e. it locks the vault. That is correct
behaviour, not a bug.

To watch the service worker's console: the extension card has a **service worker** link. It is
inactive most of the time; MV3 terminates it after roughly 30 seconds of idle and restarts it on the
next event. Anything that assumes module-scope state survived a gap between events is a bug.

**The extension id changes** every time you load an unpacked build from a fresh directory. For a
stable id (needed for OAuth in Phase 10), add a `key` to the manifest — see
[RELEASE.md §5.4](RELEASE.md#54-stable-extension-id-for-local-development).

---

## 3. How the build fits together

```
build/manifest.ts   ─┐
build/version.ts    ─┼─► build/mv3-plugin.ts ─► dist/manifest.json
package.json        ─┘

src/popup/popup.html    ─► dist/popup.html    + dist/assets/popup-<hash>.{js,css}
src/manager/manager.html ─► dist/manager.html + dist/assets/manager-<hash>.{js,css}
src/background/index.ts  ─► dist/background.js      (ES module, one file, never split)
src/content/og-capture.ts ─► dist/og-capture.js     (IIFE, one file — Phase 11)
public/**                ─► dist/**                (icons, _locales)
```

Three things are worth knowing:

- **The service worker is built in its own pass**, as a single un-split file. A code-split service
  worker will eventually try to `import()` a chunk after MV3 terminated it — a failure that never
  shows up in development and always shows up in the field.
- **The content script is built in a third pass**, as an IIFE, because
  `chrome.scripting.executeScript({ files })` needs one self-contained file. That pass is skipped
  while `src/content/og-capture.ts` does not exist yet.
- **HTML entries are flattened** from `src/popup/popup.html` to `dist/popup.html`. Their script and
  style references are root-absolute (`/assets/…`), which resolves against the extension's own
  origin.

We use an in-repo plugin (~130 lines) rather than `@crxjs/vite-plugin` — the reasoning is D2 in
[PLAN.md](../PLAN.md) and [ARCHITECTURE.md §2](ARCHITECTURE.md#2-build-system).

---

## 4. Tests

| Tier | Where | Runner |
| --- | --- | --- |
| Unit | `test/unit/**/*.test.ts` | Vitest, Node environment |
| Integration | `test/integration/**/*.test.ts` | Vitest, against the `chrome.*` mock |
| E2E | `test/e2e/**` | Playwright, real Chromium with `dist/` loaded |

`chrome.*` is mocked by [`test/mocks/chrome.ts`](../test/mocks/chrome.ts). It is not a stub: the
`storage.sync` area enforces Chrome's real caps — `QUOTA_BYTES`, `QUOTA_BYTES_PER_ITEM`,
`MAX_ITEMS`, and both write-rate ceilings — against an injectable clock, so a test can exhaust a
rate budget without waiting a minute:

```ts
import { createChromeMock, createClock } from '../mocks/chrome';

const clock = createClock();
const { chrome, storage } = createChromeMock({ clock });
await chrome.storage.sync.set({ 'vm.s.b0.0': part });
clock.advance(61_000); // the write-rate window slides
```

Use `installChromeMock()` when the code under test reads the global `chrome` at import time (the
service worker does), and remember `vi.resetModules()` so each test imports it fresh.

Tests that touch the DOM opt into jsdom with a `@vitest-environment jsdom` docblock at the top of the
file — the default environment is Node, because everything except `src/ui/**` runs without a document.

**Coverage gates** live in `vitest.config.ts` and fail the run, locally and in CI. They start at
70 % lines / 60 % branches globally; the 90 %/85 % gates for `src/crypto`, `src/vault`, `src/storage`,
`src/background`, `src/shared`, `src/ui` and (from Phase 7) `src/sync` are added as those modules land
(D33). Ratchet up, never down. `src/popup/**` and `src/manager/**` are excluded: they run on import
and wire listeners to a live `chrome` and a live document, so they are covered by the E2E suite.

**Two tests hold a stopwatch** — the worker's cold start and a 500-item unlock, both budgets from
[ARCHITECTURE §7.2](ARCHITECTURE.md). A stopwatch measures the machine as much as the code, so each
has a tight number (the spec's, and the one a user feels) and a relaxed one at 3×. Which applies is
decided once in `vitest.config.ts` and read through
[`test/helpers/budget.ts`](../test/helpers/budget.ts):

| Run | Tier |
| --- | --- |
| `npm run test`, `npm run verify`, anything on CI | relaxed |
| a file or name filter on the command line — `npx vitest run test/unit/background/message-router.test.ts` | tight |
| `VM_BUDGET_TIER=tight` / `=relaxed` | as told |

The reason is that the whole-suite run puts ninety-odd files on four cores, and both budgets were
measured failing that way *at commits predating the code they gate*. A gate that goes red for a
reason other than the code trains you to re-run it, and then it is not a gate. The cost is real and
named in the helper's header: nothing holds the tight line unattended, so **run those two files by
name after touching the worker's import graph or the unlock path.**

---

## 5. The E2E suite

`npm run test:e2e` runs Playwright against a **built** `dist/`, so `npm run build` first. Specs and
the harness rules are listed in [`test/e2e/README.md`](../test/e2e/README.md); the two that cost the
most time to rediscover are that an MV3 extension needs a **persistent context** launched with
`--load-extension` rather than Playwright's default browser fixture, and that it needs
`channel: 'chromium'` — the default headless build does not run extensions at all.

### 5.1 Sync across two profiles, by hand

Two things about sync cannot be automated, and both need doing before a release that touches
`src/sync/**`.

Playwright cannot sign a browser into a Google account, so `test/e2e/adopt.spec.ts` replicates
`chrome.storage.sync` between two persistent contexts by hand — accurate, but it proves our side of
the boundary rather than Chrome's. And `chrome.storage.sync` replication for an **unpacked**
extension is undocumented; it works because both profiles derive the same extension id from the same
`dist` path, which is a property of load-unpacked rather than a guarantee.

The manual pass, on two profiles signed into one Google account:

1. In both, `chrome://settings/syncSetup` → *Manage what you sync* → **Extensions** on.
   `chrome.storage.sync` rides that datatype; with it off nothing replicates.
2. Load the same `dist/` in both via *Load unpacked*, and check the ids on `chrome://extensions`
   **match**. Two different ids are two different extensions and nothing will ever sync.
3. Profile A: create a vault, add a few bookmarks, click the sync line in the manager's toolbar.
   It should settle on *Last synced now*.
4. Profile B, after replication lands (seconds, occasionally a minute or two): open the popup. It
   must offer **"There is already a vault on your other computer"**, not the create form. The check
   runs on popup open, so reopen it if replication was still in flight.
5. A deliberately wrong password first: refused, screen unchanged, no vault created.
6. The real password: profile B lands on the unlocked popup with profile A's bookmarks, folders,
   tags and notes intact.
7. Both directions: add on B, sync, sync A, and the bookmark appears — then the reverse.
8. The conflict path: rename the *same* bookmark differently on both without syncing in between,
   then sync A and sync B. B should raise the banner and show both versions side by side.

### 5.2 Native-bookmark import, by hand

The other thing Playwright cannot do. `chrome.permissions.request` needs a user gesture and answers
with a **browser-level** prompt that no automated context can accept, so the whole native-import
path is covered against a mocked `chrome.bookmarks` in
`test/unit/import/native-bookmarks.test.ts` and verified by hand before any release touching
`src/import/**`.

On a profile with real bookmarks in it — several folders, at least one nested, and ideally something
the vault will refuse such as a `javascript:` bookmarklet or a `file://` link:

1. Load `dist/` unpacked, create or unlock a vault, and open the manager → **Import & export** →
   *Import from this browser*.
2. It must say the permission has **not** been granted and offer the button, not silently show an
   empty tree. Press it: Chrome's own prompt appears. **Decline it once** — the page should say so
   and change nothing.
3. Accept it. The tree appears with *Bookmarks bar* and *Other bookmarks* at the top level, matching
   `chrome://bookmarks`.
4. Tick one nested folder and one loose bookmark, and copy them in. Check in the vault that the
   folder structure came across — a ticked bookmark brings its ancestor folders with it — and that
   the count of skipped items matches the bookmarks you expected to be refused.
5. **Check `chrome://bookmarks` is untouched.** This is the assertion that matters: an import is a
   read (INV-5).
6. Now press *Delete the originals from Chrome*. Confirm, and check that exactly the ticked items are
   gone from `chrome://bookmarks` and nothing else is. Chrome refuses to delete its own permanent
   folders, so a selection including *Bookmarks bar* should report those as failures and still
   delete everything else.
7. Type one of the deleted bookmarks' addresses into the omnibox: it should no longer be suggested.
   That is the whole point of the second step, and the only way to see it is to look.
8. Take the permission back on `chrome://extensions` and confirm the screen returns to step 2.

### 5.3 History cleanup, by hand

`chrome.permissions.request` is the same obstacle as in §5.2, and the consequence here is larger: the
feature deletes real browsing history. The logic is covered against a mocked `chrome.history` in
`test/unit/history/**` and `test/unit/background/history.test.ts` — including the exact `search` and
`deleteUrl` call lists — but the permission prompt and Chrome's own history page need eyes.

**Use a scratch profile.** This deletes browsing history for real, and there is no undo.

1. In a profile with some history, visit two or three pages you are willing to lose, and one page on
   a site you are **not** going to vault whose domain name *contains* one you are — `example.com`
   vaulted and `notexample.community` visited is the shape that catches the bug this feature exists
   to avoid.
2. Vault the first pages. Open the manager → **Settings** → *Privacy*.
3. It must explain the permission and offer the button, not reach for it. Press it and **decline
   once**: the panel says so and the history settings stay off.
4. Accept, then press *Check what would be removed*. Read the count and the sites under *Review the
   list* (it opens itself for a short list) and check them against `chrome://history` yourself. The
   unvaulted look-alike must **not** be listed.
5. Press *Remove* on **one** site and confirm. Only that site's entries go; the rest of the list
   stays on screen with the count above it reduced, and `chrome://history` agrees.
6. Press *Remove all* and confirm. The reported number should match what is left in the list. Check
   `chrome://history`: the vaulted sites are gone and the look-alike is still there.
7. Type one of the removed addresses into the omnibox. It should no longer be suggested — that is
   the whole point, and the only way to see it is to look.
8. Switch *Clear vaulted sites on lock* on, visit a vaulted site again, lock the vault, and check
   `chrome://history`.
9. Switch *Quick-close* on, open any page, press **Ctrl+Shift+X**. The tab closes and that site's
   history goes — including for a site that is not in the vault, which is what the setting says it
   does.
10. Take the permission back on `chrome://extensions` and confirm the panel returns to step 3.

### 5.4 Drive sync, by hand

Nothing automated can do this one. Playwright cannot sign into Google, `chrome.identity` needs a
real account, and a mocked `fetch` — which is what `test/unit/sync/drive/**` and
`test/integration/two-device-drive.test.ts` run against — proves the client is correct without
proving Google agrees with it. PLAN Phase 10 says so explicitly: a mocked-only Drive integration is
not sufficient evidence.

**Prerequisites**, once, from [RELEASE §5](RELEASE.md#5-google-cloud--oauth-setup):

1. A Google Cloud project with the Drive API enabled and the consent screen configured for
   **`drive.file` only**.
2. A stable unpacked extension id (§5.4 there) — `VM_MANIFEST_KEY` in `.env.local`.
3. `VM_OAUTH_CLIENT_ID` in the same file. Without it the manifest carries no `oauth2` block and the
   settings screen says Drive is unavailable, which is the correct behaviour and is what
   `manager.spec.ts` asserts.

Start from the template — `cp .env.example .env.local` — and see [RELEASE §5.5](RELEASE.md#55-envlocal--where-both-values-live)
for how the file reaches the build. Two things to know before you debug a Drive section that still
says "no Google project configured": the values arrive through `loadEnv` in `vite.config.ts`, so a
build from an older checkout will ignore the file entirely; and **`VM_MANIFEST_KEY` is applied only
in development mode**, so use `npm run dev` (or `npx vite build --mode development`) if you need the
stable id the OAuth client is registered against. Check `dist/manifest.json` for `oauth2` and `key`
before blaming Google.

Then build, load `dist/` unpacked, and:

1. **Connect.** Manager → **Settings** → *Sync* → *Connect Google Drive*. The optional permission
   prompt comes first (from the page), then Google's consent screen. It must name `drive.file` and
   nothing else — if it asks for anything wider, stop and check `build/manifest.ts`.
2. The section should now show the account address and a *Open the vault file in Drive* button. Press
   it: `My Drive/VaultaMark/vaultamark-vault.vmv` exists, is a normal file you can download, and its
   contents are JSON whose `buckets` are base64 nobody can read.
3. **Converge.** Repeat §5.1 with a second profile, connecting Drive there too rather than relying on
   Chrome sync. An edit on one appears on the other after the debounce; `peek()` traffic is visible
   in DevTools → Network on the service worker, and a check with nothing to do must be **one**
   request with no payload.
4. **Migrate back.** *Switch back to Chrome sync*. It must copy, verify, then flip — and the Drive
   file must still be there afterwards. Tick *Also delete the copy in my Drive* and confirm the
   folder goes.
5. **Refuse.** With more bookmarks than Chrome sync can hold (Phase 8's import makes this quick),
   try to switch back. It must refuse with both numbers and leave you on Drive.
6. **The other sign-in route.** Sign the profile out of Chrome (not out of Google) and connect again:
   `getAuthToken` fails and `launchWebAuthFlow` takes over. Lock the vault, restart the browser, and
   sync — the refresh token is sealed under the vault key, so this must work only after unlocking.
7. **Take it back.** Revoke VaultaMark from
   `myaccount.google.com` → *Data & privacy* → *Third-party apps*, then press *Sync now*. The status
   must say sync needs you to sign in again, not fail silently.

Write the result up in the commit message, as Phase 7's two-profile pass was.

### 5.5 Thumbnails on the real web, by hand

`test/e2e/thumbs.spec.ts` proves the pipeline end to end in a real Chromium — decode, downscale,
encode, seal, store, render, degrade — against an image the test built itself. Two things it cannot
prove, both for reasons the harness cannot get past:

- **`activeTab` cannot be granted.** It comes from a click on the toolbar button, and Playwright
  drives pages, not browser chrome. So the E2E replaces `chrome.tabs.query` and
  `chrome.scripting.executeScript` with stand-ins, exactly as `popup.spec.ts` replaces
  `chrome.windows.create`. Whether the real injection reaches a real page is a question for a real
  click.
- **The page-context fetch is the whole risk (R5).** Whether a given site's CSP allows it, and
  whether its CDN sends permissive CORS, is a property of that site — and no mock has an opinion.

So, with `dist/` loaded unpacked and Drive connected (§5.4):

1. Save twenty or so pages you would actually save, from a spread of sites: a newspaper, a GitHub
   repository, a Wikipedia article, a YouTube video, a shop, a blog on someone's own domain, a
   documentation site, a social post. Use the toolbar button, so `activeTab` is real.
2. In the manager, count how many rows have an eye. **That number over twenty is the real-world
   coverage figure risk R5 asks for** — write it into ARCHITECTURE §14 and into this file, with the
   date and the sample, because it will drift as the web's CSPs tighten.
3. For a page with no preview, check DevTools → Network *on the page* (not on the worker): a CSP
   refusal and a CORS refusal look different, and the split is worth recording.
4. **Refresh.** Open one of the saved pages, click the toolbar button on it, and press
   *Refresh preview* on the "already saved" notice. The picture must update.
5. **Check the second device.** With Drive connected on both, the pictures must appear on the other
   profile — evicted-and-refetched is the path §14.6 describes, so clearing `vm.thumbs.*` in
   `chrome.storage.local` on one profile and reopening the manager should refill it from Drive with
   one request per picture looked at, and none for pictures nobody looks at.
6. **Check nothing leaks.** `chrome://extensions` → service worker → Application → Storage: every
   `vm.thumbs.*` value is base64 that does not begin `iVBOR`, `/9j/` or `UklGR`.

---

## 6. The invariant scanners

`npm run verify:invariants` runs two scripts against the **built** `dist/`, because the point is to
catch what a dependency or a plugin smuggled into the bundle, which source-level linting cannot see:

- [`scripts/verify-manifest.mjs`](../scripts/verify-manifest.mjs) — MV3, the exact CSP string, and
  the permission set diffed against [`build/permissions.lock.json`](../build/permissions.lock.json).
  **Adding a permission means editing that lock file in the same commit, with a CHANGELOG entry.**
- [`scripts/verify-no-remote-code.mjs`](../scripts/verify-no-remote-code.mjs) — `eval`, the
  `Function` constructor, remote or computed `import()`, `importScripts`, WASM, `sendBeacon`,
  `XMLHttpRequest`, `blob:`/`data:` script URLs, and any absolute URL not in
  [`build/url-allowlist.json`](../build/url-allowlist.json).

ESLint enforces the same bans at the source level, so you find out while typing rather than at the
end of `verify`. If a scanner fires on something legitimate, the fix is a narrower rule or an
allowlist entry in a reviewed commit — never a disabled check. The invariants are listed with their
rationale in [PLAN.md §4](../PLAN.md#4-hard-invariants).

---

## 7. Conventions worth knowing before your first commit

- **No runtime dependencies.** `dependencies` in `package.json` is empty and stays empty; adding one
  needs a written case (D4). Dev dependencies are unrestricted.
- **No user-facing string outside `public/_locales/en/messages.json`.** Markup carries `data-i18n`
  keys; the page fills them in.
- **Never log** a password, key, URL, title, note or tag — not at any level, not in a `catch`.
- **Crypto and vault-format changes are spec-first**: update `docs/ARCHITECTURE.md` and bump
  `SCHEMA_VERSION` with a migration and a fixture, in the same commit.
- Commit with [Conventional Commits](https://www.conventionalcommits.org/) and update
  `CHANGELOG.md` under `## [Unreleased]` in the same commit as any user-visible change.
