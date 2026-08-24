# End-to-end tests

| Spec | Phase | Covers |
| --- | --- | --- |
| `lock.spec.ts` | 4 | create a vault, unlock, wrong password, auto-lock on an expired session, panic-lock |
| `popup.spec.ts` | 5 | list, filter, open (guided incognito prompt + fallback), delete, undo, **INV-4** |
| `manager.spec.ts` | 6 | folders, tags, search, bulk move, undo, drag-and-drop, resizable columns, a11y, 5,000 rows |
| `adopt.spec.ts` | 7 | a second profile joining a synced vault with the master password alone |
| `portable.spec.ts` | 8 | `.vmv` backup and restore, and a merge that produces conflicts |
| `focus-ring.spec.ts` | 8 | focus rings are not clipped by boxes that scroll — **measure, never read the CSS** |
| `onboarding.spec.ts` | 9 | the five-step first-run flow, its two gates, and that it never appears again |
| `thumbs.spec.ts` | 11 | capture at add time, the quality ladder, EXIF removal, and **INV-4** while browsing |

| `journey.spec.ts` | 12 | first run → onboarding → create → add → organise → open → lock/unlock → export/import → sync, in **one profile**, plus INV-4 over the whole arc |
| `budgets.spec.ts` | 12 | popup first paint — the one performance budget that needs a real renderer |
| `large-vault.spec.ts` | 6, moved in 12 | five thousand bookmarks in a windowed list, in a profile of its own |
| `locale-fit.spec.ts` | 18 | the popup's settings screen fits Chrome's 600 px in `en` and in synthetic locales 40 % and 200 % longer — **measure, never read the CSS** |
| `locale-fallback.spec.ts` | 18 | what Chrome does with a key a translation has not got — **per message, measured, not read** |

`manager.spec.ts` also carries the Phase-12 reordering case and the axe pass over five documents;
`popup.spec.ts` and `onboarding.spec.ts` carry the axe passes over theirs. There is no single
"a11y test" — a page here means a *document*, and there are about a dozen. See `a11y.ts`.

**Why `large-vault.spec.ts` is its own file.** It lived in `manager.spec.ts`, which shares one vault
across a dozen tests, several of which have already pushed to `chrome.storage.sync`. By the time it
ran, bulk-adding five times the Chrome-sync capacity into a 100 KB area made the worker grind:
seeding took twice as long and the manager afterwards sat on "Opening the vault…" past the default
five-second expectation. It passed alone and failed in sequence — the signature of a shared fixture,
not a product fault. Every spec now builds its own profile in `beforeAll`.

**Wall clock** (PLAN §9 Phase 12's DoD, under ten minutes in CI): about 2¼ minutes locally, of which
1½ is seeding the large vault. `workers: 1` is deliberate and is left that way — every spec has its
own persistent context now, so file-level parallelism would be safe if the budget ever gets tight,
but a serial run is what makes a flake reproducible in the order it appeared.

Things the harness gets wrong if you do not know them:

- **Launch through `extensionArgs()` in `harness.ts`, never with a hand-written `args` array.**
  Every assertion in this suite names an English sentence, and `--lang` — which decides which
  `_locales/<tag>/messages.json` Chrome renders — comes from the **operating system** when it is not
  passed. That was invisible while `en` was the only locale in the package. The moment Phase 18
  added `_locales/pl`, twelve of thirteen specs went red on a Polish-language machine and stayed
  green in CI, which runs on an English one. `extensionArgs()` pins it; `use.locale` in
  `playwright.config.ts` pins the other half.
- **`--lang` picks the locale; Playwright's `locale` decides what the page reports.** They are
  different switches. `--lang=pl` sets the browser's application locale, which selects
  `_locales/pl/messages.json`. Playwright emulates a context locale of `en-US` unless told
  otherwise, and *that* is what `chrome.i18n.getUILanguage()` answers with — so `--lang` alone gives
  a browser rendering Polish while every page in it reports `en-US`, and `src/ui/plural.ts` picks
  English's plural categories for Polish text. Pass both, always. See `locale-fallback.spec.ts`,
  which was measured wrong by exactly this.
- Playwright's default `browser` fixture cannot load an extension. Launch a **persistent context**
  (`chromium.launchPersistentContext`) with `--disable-extensions-except=<dist>` and
  `--load-extension=<dist>`, against a **built** `dist/` — run `npm run build` first.
- Pass **`channel: 'chromium'`**. Playwright's default headless build is `chromium-headless-shell`,
  which does not run extensions at all: the service worker never starts and the failure looks like a
  timeout rather than a missing feature.
- The extension id is not known ahead of time. Read it from the service-worker URL
  (`context.serviceWorkers()[0].url()`), or set a `key` in the manifest for a stable id
  (docs/RELEASE.md §5.4).
- A service worker's own `chrome.runtime.sendMessage` is **not** delivered to its own listeners.
  Drive the message contract from a page. `manager.html` is the useful one, because it has no
  broadcast listener and so does not close itself when the vault locks.
- Keyboard commands are OS-level keystrokes routed to `chrome.commands.onCommand`; headless Chromium
  gives no way to send them. Assert the *effect* here and the dispatch in the unit suite.
- **`activeTab` cannot be granted here.** It comes from a click on the toolbar button, and Playwright
  drives pages, not browser chrome — so `chrome.tabs.query` returns a tab with no `url` and the add
  fails with `NO_ACTIVE_TAB`. `popup.spec.ts` asserts that *failure* is explained rather than silent,
  and vaults through `ADD_URL` (the context-menu path) for everything after that. The active-tab path
  is covered against the tab API in `test/integration/add-and-open.test.ts`.
- A persistent context has **no incognito profile**, so `windows.create({incognito:true})` cannot be
  driven for real. Replace `chrome.windows.create` inside the service worker with a recorder and
  assert the call, as PLAN Phase 5 prescribes.
- **The install tab cannot be observed.** `chrome.runtime.onInstalled` fires while the persistent
  context is still starting, before Playwright has a page listener attached, and the tab it opens is
  gone from `context.pages()` by the time the fixture is ready. `onboarding.spec.ts` drives the URL
  that tab opens instead, which is the part that actually matters.
- **"Allow in Incognito" cannot be turned on** — it is a checkbox on `chrome://extensions` that no
  API reaches, which is the entire reason the onboarding step exists. The gate is exercised through
  the answer a real user in that situation gives: *Skip for now*.
- INV-4 is an E2E assertion: route-intercept every request the extension context makes and assert
  the "browse the vault" scenario records **zero** of them.
