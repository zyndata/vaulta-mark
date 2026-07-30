# End-to-end tests

| Spec | Phase | Covers |
| --- | --- | --- |
| `lock.spec.ts` | 4 | create a vault, unlock, wrong password, auto-lock on an expired session, panic-lock |

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
- INV-4 is an E2E assertion: route-intercept every request the extension context makes and assert
  the "browse the vault" scenario records **zero** of them.
