/**
 * @vitest-environment jsdom
 *
 * The UI kit. It is 150 lines standing in for a framework (D3), so it gets tested like one: if `h`
 * mishandles a boolean attribute or `render` leaks a listener, every screen in the extension is
 * subtly wrong and nothing else would catch it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  append,
  applyTheme,
  createStore,
  h,
  localize,
  msg,
  qs,
  render,
} from '../../../src/ui/dom.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

beforeEach(() => {
  installChromeMock();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  uninstallChromeMock();
});

describe('h', () => {
  it('builds an element with attributes and children', () => {
    const element = h('p', { class: 'vm-small', id: 'x' }, 'hello ', h('strong', null, 'world'));
    expect(element.outerHTML).toBe('<p class="vm-small" id="x">hello <strong>world</strong></p>');
  });

  it('spells a boolean attribute the way HTML does, and drops a false one', () => {
    expect(h('button', { disabled: true }).outerHTML).toBe('<button disabled=""></button>');
    expect(h('button', { disabled: false }).outerHTML).toBe('<button></button>');
    expect(h('button', { disabled: undefined }).outerHTML).toBe('<button></button>');
  });

  it('stringifies numbers, so a size or an index needs no ceremony at the call site', () => {
    expect(h('option', { value: 10 }, 10).outerHTML).toBe('<option value="10">10</option>');
  });

  it('takes listeners from on* keys', () => {
    const clicks: string[] = [];
    const button = h('button', { onclick: () => clicks.push('click') });
    button.click();
    expect(clicks).toEqual(['click']);
  });

  it('accepts no attributes at all', () => {
    expect(h('span').outerHTML).toBe('<span></span>');
  });
});

describe('append and render', () => {
  it('skips null, undefined and false so `cond && h(…)` reads inline', () => {
    const parent = h('div');
    append(parent, 'a', null, undefined, false, 0, 'b');
    expect(parent.textContent).toBe('a0b');
  });

  it('replaces everything under the parent', () => {
    const parent = h('div', null, h('span', null, 'old'));
    render(parent, h('span', null, 'new'));
    expect(parent.innerHTML).toBe('<span>new</span>');
    render(parent);
    expect(parent.innerHTML).toBe('');
  });
});

describe('qs', () => {
  it('finds an element', () => {
    document.body.append(h('div', { id: 'root' }));
    expect(qs(document, '#root').id).toBe('root');
  });

  it('throws rather than returning null, because a missing node is a bug in the HTML', () => {
    expect(() => qs(document, '#nope')).toThrow(/No element matches "#nope"/);
  });
});

describe('msg and localize', () => {
  it('goes through chrome.i18n, with and without substitutions', () => {
    const getMessage = vi.spyOn(chrome.i18n, 'getMessage');
    msg('someKey');
    msg('otherKey', ['1', '2']);
    expect(getMessage).toHaveBeenNthCalledWith(1, 'someKey');
    expect(getMessage).toHaveBeenNthCalledWith(2, 'otherKey', ['1', '2']);
  });

  it('fills every data-i18n element and ignores the rest', () => {
    document.body.append(
      h('p', { 'data-i18n': 'popupLoading' }),
      h('p', { class: 'untouched' }, 'literal'),
    );
    localize(document);
    // The mock returns the key, which makes a missing string obvious.
    expect(document.body.querySelector('[data-i18n]')?.textContent).toBe('popupLoading');
    expect(document.body.querySelector('.untouched')?.textContent).toBe('literal');
  });
});

describe('createStore', () => {
  it('notifies subscribers on a real change and skips a no-op', () => {
    const store = createStore(1);
    const seen: number[] = [];
    store.subscribe((value) => seen.push(value));

    store.set(2);
    store.set(2);
    store.update((current) => current + 1);
    store.update((current) => current);

    expect(store.get()).toBe(3);
    expect(seen).toEqual([2, 3]);
  });

  it('unsubscribes', () => {
    const store = createStore('a');
    const seen: string[] = [];
    const off = store.subscribe((value) => seen.push(value));
    off();
    store.set('b');
    expect(seen).toEqual([]);
  });

  it('survives a subscriber that unsubscribes during a notification', () => {
    const store = createStore(0);
    const seen: number[] = [];
    const off = store.subscribe((value) => {
      seen.push(value);
      off();
    });
    store.set(1);
    store.set(2);
    expect(seen).toEqual([1]);
  });
});

describe('applyTheme', () => {
  it('pins an explicit theme and hands "system" back to prefers-color-scheme', () => {
    const root = document.documentElement;
    applyTheme('dark', root);
    expect(root.getAttribute('data-theme')).toBe('dark');
    applyTheme('light', root);
    expect(root.getAttribute('data-theme')).toBe('light');
    applyTheme('system', root);
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});
