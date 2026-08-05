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

The full user-journey suite arrives in **Phase 12** (PLAN.md §9).

Things the harness gets wrong if you do not know them:

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
