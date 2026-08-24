/**
 * The injected script (ARCHITECTURE §14.1). Built to `dist/og-capture.js` as one self-contained
 * IIFE by `build/mv3-plugin.ts`, and injected with `chrome.scripting.executeScript` under an
 * `activeTab` grant at add time — never as a `content_scripts` entry, never on a page the user did
 * not just act on.
 *
 * **It publishes a function rather than returning a value**, and that is not a style choice. A
 * `files:` injection reports the completion value of the *program*, and a bundled program is
 * `(function () { … })();` — an expression statement whose value is whatever the wrapper returns,
 * which is `undefined` no matter what the module did. So the worker injects this, and then makes a
 * second, tiny `func:` injection that calls what this left behind and hands back the answer Chrome
 * *will* serialise. Overwriting on re-injection is deliberate: adding the same page twice must run
 * the current build's capture, not the one from before the extension was updated.
 *
 * There are no exports here, and there is nothing else in the file: everything worth testing lives
 * in `og.ts` next door, which is bundled into this one and has no `chrome` in it at all.
 */

import { capture, type CaptureRequest, type CaptureResult } from './og.js';

/** The name the worker's reader injection looks for. Namespaced; the page shares this global. */
const HOOK = '__vmOgCapture';

Object.defineProperty(globalThis, HOOK, {
  // The argument says what this capture is for (§10.1, D37): whether to fetch the OG picture, and
  // the icon URL the worker resolved from `tab.favIconUrl`. Absent means "the picture, as before" —
  // a worker that already holds an icon for this host asks for no icon and none is fetched.
  value: (request?: CaptureRequest): Promise<CaptureResult> =>
    capture(document, fetch, request ?? {}),
  writable: true,
  configurable: true,
  // Not enumerable: the isolated world is ours, but a property that does not show up in a
  // `for…in` over the global is one fewer thing for anything else running here to trip over.
  enumerable: false,
});
