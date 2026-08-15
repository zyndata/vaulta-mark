# Accessibility

What VaultaMark commits to, how it is checked, and the keyboard-only walkthrough PLAN §9 Phase 12
asks for. Written for two readers: someone deciding whether this extension is usable for them, and
whoever changes the UI next.

The short version: **every screen is operable with a keyboard alone, and there is no action that a
pointer can perform and a keyboard cannot.** Dragging is a shortcut throughout, never the only route.

---

## 1. What is enforced, and where

| Commitment | Enforced by |
| --- | --- |
| Zero critical or serious axe violations, on every document | `test/e2e/a11y.ts`, called from `manager.spec.ts`, `popup.spec.ts` and `onboarding.spec.ts` |
| 4.5:1 contrast in light **and** dark | The same run — `color-contrast` is in the WCAG 2 AA tag set and is deliberately not excluded |
| Every user-facing string is translatable | `scripts/verify-strings.mjs` (INV-10) |
| `prefers-reduced-motion` is honoured everywhere | Every `transition` and `animation` in `src/**/*.css` has a `@media (prefers-reduced-motion: reduce)` rule; the hover preview checks it in script (`src/ui/thumb.ts`) |
| Focus rings are never clipped | `test/e2e/focus-ring.spec.ts`, which **measures** rather than reads the CSS |

**A "page" here means a document, not a URL.** VaultaMark ships two HTML files and about a dozen
documents: the popup alone is create, unlock, unlocked and settings; the manager is the list, a
selection, a modal, settings, import/export, the conflict screen, the incognito prompt and five
onboarding steps. Each is a different tree to assistive technology, and testing "the page" would
reach only the first of each pair. The axe assertions are therefore spread through the specs, at the
point where each document is already on screen — see the note at the top of `test/e2e/a11y.ts`.

---

## 2. The keyboard-only walkthrough

Run this with the mouse unplugged, or with the pointer parked off-screen. It is the manual pass; the
automated suite covers the assertions but cannot tell you whether the *order* things happen in makes
sense.

### 2.1 First run

1. Install. The setup flow opens on its own.
2. **Tab** through step 1 and press **Enter** on *Next*. Every step's controls are in reading order,
   and the step counter is the first thing a screen reader reaches after the heading.
3. Step 2 is a form. Tab reaches password, repeat, the strength meter's description, and the typed
   confirmation. *Create vault* stays disabled until the phrase is typed — and pressing *Next*
   instead says why, in the live region, rather than doing nothing.
4. Step 3 cannot be completed from here by anybody: the "Allow in Incognito" checkbox is on a Chrome
   page no extension can reach. The address is selectable text with a **Copy** button, and *Skip for
   now* is a real answer that leaves a persistent nudge in the manager.
5. Steps 4 and 5 are read-only and a permission button respectively. **Enter** on *Finish setup*.

### 2.2 The popup

The popup is a single tab ring, top to bottom: the filter, each row, the row's delete button, then
the three footer buttons. **Escape** closes it, as it does any Chrome popup.

- **Tab** to the filter and type. The list narrows as you type; the count below it is a live region,
  so a screen reader hears how many matched without moving.
- **Tab** to a row and press **Enter** to open it. If "Allow in Incognito" is off, this opens the
  guided prompt in a tab rather than opening the bookmark — which is the product working, not
  failing, and the prompt says so.
- After a delete, the undo offer is a button in the tab ring for the full eight seconds. The bar
  drawing the deadline is decoration; the button is the thing, and it is reachable.

### 2.3 The manager

**`/`** focuses the search box from anywhere on the page that is not already a text field.

The window is four tab stops in order: the search box, the sidebar tree, the list, the detail pane.
The sidebar and the list are **one stop each**, not one per row — that is what a roving tabindex and
`aria-activedescendant` buy, and it is why Tab does not take forty presses to cross a vault.

**In the list** (a multi-selectable `listbox`; its `aria-description` says most of this out loud):

| Key | Does |
| --- | --- |
| **↓** / **j** | Move the cursor down |
| **↑** / **k** | Move the cursor up |
| **Home** / **End** | First / last row |
| **Shift+↑ / ↓** | Extend the selection |
| **Ctrl/⌘+A** | Select everything in view |
| **Enter** | Open a bookmark in incognito; enter a folder |
| **e** | Jump to the detail pane's title field — the one place an item is edited |
| **p** | Show the preview picture, if there is one |
| **Delete** / **Backspace** | Delete the selection, with the undo offer |
| **Alt+↑ / Alt+↓** | **Move the selected items one place** (the equivalent of dragging) |
| **Escape** | Clear the selection |

**In the folder tree** (a real ARIA `tree`):

| Key | Does |
| --- | --- |
| **↑ / ↓** | Move between visible folders |
| **→** | Open a folder, or step into it if it is already open |
| **←** | Close a folder, or step out to its parent |
| **Home** / **End** | First / last visible folder |
| **Enter** / **Space** | Go to that folder |
| **Delete** | Delete the folder, after asking what happens to its contents |
| **Alt+↑ / Alt+↓** | **Move the folder one place among its siblings** |

**Reordering is the one place where a pointer gesture needed a deliberate equivalent**, and Alt+arrow
is it — not a lesser version but the same operation: repeated, it reaches every position, and it
needs no "pick up / put down" mode for a screen reader to narrate. Re-parenting has always had its
keyboard route in the toolbar's *Move to…*.

Reordering only applies where a position is visible: the **My own order** sort, inside a folder, with
the search box empty. Pressing Alt+arrow anywhere else says so in the status line rather than doing
nothing silently.

**Everywhere else**: dialogs are real `<dialog>` elements, so Escape closes them and focus is
trapped and restored by the browser. The two column splitters are `role="separator"` with
`aria-valuenow`, and arrow keys resize them.

### 2.4 Browser-level shortcuts

These are Chrome commands, changeable at `chrome://extensions/shortcuts`, and they work with no
VaultaMark window open:

| Default | Does |
| --- | --- |
| **Ctrl/⌘+Shift+S** | Add the current page to the vault |
| **Ctrl/⌘+Shift+L** | Lock the vault now |
| **Ctrl/⌘+Shift+B** | Open the manager |
| **Ctrl/⌘+Shift+X** | Close this tab and forget the site (only when *Quick close* is on) |

Two of these have no window to report into, so they report on the **toolbar badge**. That is a
deliberate constraint rather than an oversight: `chrome.notifications` is a permission, and INV-9
says the permission set does not grow for a convenience.

---

## 3. Known limits

- **The toolbar button cannot be reached by keyboard from a page.** That is Chrome's, not ours;
  `Ctrl/⌘+Shift+S` exists precisely because of it.
- **"Allow in Incognito" cannot be switched on by anything we ship**, keyboard or otherwise. It is a
  checkbox on `chrome://extensions`, and `chrome://` URLs cannot be opened programmatically. The
  prompt copies the address and instructs; it does not navigate.
- **The row eye and the folder twisty are not tab stops**, and cannot be: a `listbox` may not
  contain interactive descendants and neither may a `treeitem`. **p** is the eye's equivalent, and
  **→ / ←** are the twisty's. Both are the real operation, not a workaround.
- **Screen readers have not been tested by a screen-reader user.** The automated pass proves the
  markup is right; it does not prove the experience is good. That remains open, and saying so is
  more honest than a claim the test suite does not support.
