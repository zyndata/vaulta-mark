/**
 * The native-import picker's checkboxes, and the selection they build.
 *
 * Ticking a folder has imported everything inside it since Phase 8 — `expandSelection` closes the
 * selection downward — but the children's boxes stayed empty, so nothing on screen said so. The
 * boxes now cascade, and this pins the three things that can go wrong with a tri-state tree:
 *
 * - a folder that is ticked brings its whole subtree, in the boxes *and* in the set;
 * - a folder with only some of its contents ticked is `indeterminate` and **not** in the set, since
 *   a folder in the set is a folder whose entire subtree comes along;
 * - unticking one child of a full folder leaves the ancestors mixed rather than empty.
 *
 * A unit test rather than an E2E, and that is not a preference: this picker only appears once the
 * optional `bookmarks` permission is granted, and `chrome.permissions.request` answers with a
 * browser-level prompt no automated context can accept (DEVELOPMENT §5.2).
 *
 * `src/manager/**` is excluded from the coverage gates as import-time DOM glue; this is here for the
 * same reason `dnd.test.ts` is — the decision under test is bookkeeping, and it is wrong in ways a
 * screenshot would not show.
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';
import type { NativeNodeView } from '../../../src/shared/messages.js';

/** Chrome's shape, one level deeper than the fixture in `native-bookmarks.test.ts`. */
const NODES: readonly NativeNodeView[] = [
  {
    id: '1',
    title: 'Bookmarks bar',
    children: [
      { id: '10', title: 'Example', url: 'https://example.com/' },
      {
        id: '11',
        title: 'Work',
        children: [
          { id: '110', title: 'Spec', url: 'https://example.com/spec' },
          { id: '111', title: 'Notes', url: 'https://example.com/notes' },
        ],
      },
    ],
  },
  { id: '2', title: 'Other bookmarks', children: [{ id: '20', title: 'Elsewhere', url: 'https://elsewhere.test/' }] },
];

let nativeTree: typeof import('../../../src/manager/io.js').nativeTree;

beforeEach(async () => {
  installChromeMock();
  // jsdom keeps one document for the whole file, so a tree left over from the previous test would
  // be counted by the next one that looks at the page.
  document.body.replaceChildren();
  ({ nativeTree } = await import('../../../src/manager/io.js'));
});

afterEach(() => {
  uninstallChromeMock();
});

/** The picker, plus the two things a test wants to do to it. */
function picker(): {
  checked: Set<string>;
  click: (id: string) => void;
  box: (id: string) => HTMLInputElement;
  state: (id: string) => 'on' | 'mixed' | 'off';
} {
  const checked = new Set<string>();
  const tree = nativeTree(NODES, checked);
  document.body.append(tree);

  const box = (id: string): HTMLInputElement => {
    const found = tree.querySelector<HTMLInputElement>(`#vm-native-${id}`);
    if (found === null) throw new Error(`no checkbox for ${id}`);
    return found;
  };
  return {
    checked,
    box,
    // A real click, so the `change` handler runs exactly as it does for a user.
    click: (id) => {
      box(id).click();
    },
    state: (id) => {
      const input = box(id);
      return input.checked ? 'on' : input.indeterminate ? 'mixed' : 'off';
    },
  };
}

describe('ticking a folder', () => {
  it('ticks everything inside it, boxes and all', () => {
    const tree = picker();
    tree.click('11');

    expect(tree.state('11')).toBe('on');
    expect(tree.state('110')).toBe('on');
    expect(tree.state('111')).toBe('on');
    expect([...tree.checked].sort()).toEqual(['11', '110', '111']);
  });

  it('reaches every level, not just its own children', () => {
    const tree = picker();
    tree.click('1');

    expect(['1', '10', '11', '110', '111'].map(tree.state)).toEqual(['on', 'on', 'on', 'on', 'on']);
    // And nothing outside the folder that was ticked.
    expect(tree.state('2')).toBe('off');
    expect(tree.state('20')).toBe('off');
  });

  it('unticks the same subtree again', () => {
    const tree = picker();
    tree.click('1');
    tree.click('1');

    expect(tree.checked.size).toBe(0);
    expect(['1', '10', '11', '110'].map(tree.state)).toEqual(['off', 'off', 'off', 'off']);
  });
});

describe('a folder with only part of it ticked', () => {
  it('is mixed, and is not itself in the selection', () => {
    const tree = picker();
    tree.click('110');

    // In the set it would mean "import this whole folder", which is the opposite of what one ticked
    // child says. `expandSelection` brings the ancestors along as folders regardless, so the filing
    // still survives the import.
    expect(tree.state('11')).toBe('mixed');
    expect(tree.state('1')).toBe('mixed');
    expect([...tree.checked]).toEqual(['110']);
  });

  it('fills in when the last of its contents is ticked', () => {
    const tree = picker();
    tree.click('110');
    tree.click('111');

    expect(tree.state('11')).toBe('on');
    expect([...tree.checked].sort()).toEqual(['11', '110', '111']);
    // The grandparent still has an unticked bookmark of its own.
    expect(tree.state('1')).toBe('mixed');
  });

  it('empties when the last ticked thing is unticked', () => {
    const tree = picker();
    tree.click('110');
    tree.click('110');

    expect(tree.state('11')).toBe('off');
    expect(tree.state('1')).toBe('off');
    expect(tree.checked.size).toBe(0);
  });
});

describe('unticking one thing inside a ticked folder', () => {
  it('leaves the folder mixed rather than full or empty', () => {
    const tree = picker();
    tree.click('1');
    tree.click('110');

    expect(tree.state('110')).toBe('off');
    expect(tree.state('11')).toBe('mixed');
    expect(tree.state('1')).toBe('mixed');
    // The folders are out of the set — neither brings its whole subtree any more — and everything
    // still ticked is in it.
    expect([...tree.checked].sort()).toEqual(['10', '111']);
  });
});

describe('the rows themselves', () => {
  it('shows a bookmark address and a folder none', () => {
    const tree = nativeTree(NODES, new Set());
    const rows = [...tree.querySelectorAll('.vm-native-row')];
    const withUrl = rows.filter((row) => row.querySelector('.vm-native-url') !== null);
    expect(rows).toHaveLength(7);
    expect(withUrl).toHaveLength(4);
  });

  it('puts titles in as text, never as markup', () => {
    const hostile: readonly NativeNodeView[] = [
      { id: 'x', title: '<img src=x onerror=alert(1)>', url: 'https://example.com/' },
    ];
    const tree = nativeTree(hostile, new Set());
    expect(tree.querySelector('img')).toBeNull();
    expect(tree.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
