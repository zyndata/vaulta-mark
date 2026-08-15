/**
 * The whole UI kit: a handful of DOM helpers instead of a framework (D3).
 *
 * A popup that has to paint a lock screen in one frame does not need a virtual DOM, and a security
 * tool whose selling point is that you can read all of it does not need 40 KB of runtime it did not
 * write. What the UI actually needs is: build an element tree, replace a region of the document,
 * read a localized string, and re-render when something changes. That is this file.
 *
 * `virtual-list.ts` (Phase 6) is the only other thing planned here.
 */

export type Child = Node | string | number | false | null | undefined;

type Listener = (event: Event) => void;

/**
 * Attributes, plus `onclick`-style listeners.
 *
 * `false` and `undefined` drop the attribute entirely, so `{ disabled: isBusy }` reads the way it
 * looks; `true` sets it to the empty string, which is how HTML spells a boolean attribute.
 */
export type Attrs = Record<string, string | number | boolean | Listener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') {
      element.addEventListener(name.replace(/^on/, '').toLowerCase(), value);
      continue;
    }
    element.setAttribute(name, value === true ? '' : String(value));
  }
  append(element, ...children);
  return element;
}

/** Append children, skipping the falsy ones so `cond && h(…)` works inline. */
export function append(parent: ParentNode, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : String(child));
  }
}

/** Replace everything under `parent`. The only way this kit updates the document. */
export function render(parent: ParentNode, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, ...children);
}

/**
 * `querySelector` that throws instead of returning `null`.
 *
 * A missing element is a bug in the HTML shipped alongside this code, not a runtime condition, and
 * a thrown error names it where `null` would surface three frames later as something else.
 */
export function qs(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`No element matches "${selector}".`);
  return found;
}

/** A localized string. Every user-facing string in the UI comes through here (or `localize`). */
export function msg(key: string, substitutions?: readonly string[]): string {
  return substitutions === undefined
    ? chrome.i18n.getMessage(key)
    : chrome.i18n.getMessage(key, [...substitutions]);
}

/**
 * Whether a typed confirmation matches the phrase it is confirming.
 *
 * A typed confirmation exists to make someone stop and read (the no-recovery warning here; the
 * typed vault name behind "destroy vault" in Phase 6). Being fussy about capitalisation or a
 * trailing space would only teach people that the box is broken, so it is not.
 *
 * `toLowerCase`, deliberately not `toLocaleLowerCase`: the phrase is a fixed string from
 * `_locales`, and in a Turkish locale a correctly typed lowercase "i understand" would fold to a
 * different letter than the "I" in the expected phrase and stop matching.
 */
export function matchesPhrase(typed: string, expected: string): boolean {
  const normalize = (value: string): string => value.trim().replace(/\s+/gu, ' ').toLowerCase();
  return normalize(typed) === normalize(expected);
}

/** Fill every `data-i18n` element in a static document from `_locales`. */
export function localize(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset['i18n'];
    if (key !== undefined) element.textContent = msg(key);
  }
}

/**
 * The smallest thing that deserves the name: a value, and listeners notified when it changes.
 *
 * `set` compares with `Object.is` and skips a no-op, which is what keeps a re-render from being
 * triggered by a `GET_STATE` poll that found nothing new.
 */
export interface Store<T> {
  get(): T;
  set(next: T): void;
  update(change: (current: T) => T): void;
  /** Returns an unsubscribe function. */
  subscribe(listener: (value: T) => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener(value);
    },
    update: (change) => {
      const next = change(value);
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener(value);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Apply the theme setting to the document.
 *
 * `system` removes the attribute and lets the `prefers-color-scheme` rules in `styles.css` decide;
 * an explicit choice pins it. Kept here rather than in the popup so the manager page gets it for
 * free in Phase 6.
 */
export function applyTheme(theme: 'system' | 'light' | 'dark', root: HTMLElement): void {
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
