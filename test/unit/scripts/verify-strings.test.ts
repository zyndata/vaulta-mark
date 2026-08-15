/**
 * The user-facing-string scanner (INV-10, Phase 12).
 *
 * Two halves, tested separately for a reason. `scanSource` is where the judgement lives — what
 * counts as prose, which positions a reader's eye actually reaches — and it is fed hand-written
 * snippets here, including the ones a looser rule would have got wrong. `scanRepository` is run
 * once against the real tree, which is the assertion that the repository is *currently* clean;
 * a scanner that only ever sees fixtures proves nothing about the product.
 */

import { scanRepository, scanSource } from '../../../scripts/verify-strings.mjs';

interface Scan {
  keys: Set<string>;
  problems: string[];
}

const scan = (source: string, defined = new Set<string>()): Scan =>
  scanSource('sample.ts', source, defined);

describe('untranslated prose', () => {
  it('catches a sentence typed straight into an element', () => {
    const { problems } = scan(`const p = h('p', null, 'Your vault is locked');`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('untranslated text in h()');
    expect(problems[0]).toContain('sample.ts:1');
  });

  it('catches an untranslated label on a control, which is all some people get', () => {
    const { problems } = scan(`const b = h('button', { 'aria-label': 'Delete bookmark' });`);
    expect(problems[0]).toContain('untranslated aria-label attribute');
  });

  it('catches a placeholder and a title as readily as body text', () => {
    const { problems } = scan(`
      const a = h('input', { placeholder: 'Search your bookmarks' });
      const b = h('span', { title: 'Collapse this folder' });
    `);
    expect(problems).toHaveLength(2);
  });

  it('catches an assignment as well as a construction', () => {
    const { problems } = scan(`node.textContent = 'Nothing here yet';`);
    expect(problems[0]).toContain('untranslated textContent');
  });

  it('catches setAttribute, which bypasses the h() attrs object entirely', () => {
    const { problems } = scan(`el.setAttribute('aria-label', 'Bookmarks in this folder');`);
    expect(problems[0]).toContain('untranslated aria-label attribute');
  });

  it('passes text that came from _locales', () => {
    const { problems } = scan(`
      const p = h('p', { title: msg('rowTitle') }, msg('vaultEmpty'));
      node.textContent = msg('managerLocked');
    `);
    expect(problems).toEqual([]);
  });

  /*
   * The false-positive cases, which are what decide whether anyone leaves the check switched on.
   * A rule loose enough to flag a class name gets an allowlist, then an ignore comment, then a
   * `--no-verify`, and the codebase is unchecked again with a script still claiming otherwise.
   */
  it('leaves class names, roles, selectors and ids alone', () => {
    const { problems } = scan(`
      const row = h('div', { class: 'vm-row is-cursor', role: 'option', id: item.id });
      node.textContent = '';
      el.setAttribute('aria-activedescendant', row.id);
      const found = qs(root, '.vm-list .vm-row');
    `);
    expect(problems).toEqual([]);
  });

  it('leaves a non-text attribute alone even when its value reads like a sentence', () => {
    // `content` on a meta tag, a `data-` payload, a URL: none of them is read to anyone.
    const { problems } = scan(`const m = h('meta', { content: 'width=device-width, initial-scale=1' });`);
    expect(problems).toEqual([]);
  });

  it('leaves the product name alone, because it is not translated', () => {
    expect(scan(`const h1 = h('h1', null, 'VaultaMark');`).problems).toEqual([]);
  });

  it('leaves a value the code computes alone — it is prose only if it is written here', () => {
    const { problems } = scan(`const p = h('p', null, item.title, folder.name);`);
    expect(problems).toEqual([]);
  });
});

describe('key references', () => {
  it('reports a key that does not exist, which renders as nothing at all', () => {
    const { problems } = scan(`const t = msg('vaultEmpyt');`, new Set(['vaultEmpty']));
    expect(problems[0]).toContain(`msg('vaultEmpyt') has no entry`);
  });

  it('claims a whole family when the key is built from a value', () => {
    // `msg(`strength${score}`)` picks one of five, and none of the five is named anywhere.
    const defined = new Set(['strength0', 'strength1', 'strength2', 'unrelated']);
    const { keys } = scan('const t = msg(`strength${String(score)}`);', defined);
    expect([...keys]).toEqual(expect.arrayContaining(['strength0', 'strength1', 'strength2']));
    expect(keys.has('unrelated')).toBe(false);
  });

  it('counts a key held as a record value, one call away from msg()', () => {
    // `src/ui/strings.ts` is built this way, and a sweep that missed it would report every
    // `ErrorCode` string as dead and invite someone to delete seventeen working messages.
    const { keys } = scan(`const ERRORS = { WRONG_PASSWORD: 'errorWrongPassword' };`);
    expect(keys.has('errorWrongPassword')).toBe(true);
  });
});

describe('the repository as it stands', () => {
  it('has no untranslated string and no dead message key', () => {
    const { problems } = scanRepository();
    expect(problems).toEqual([]);
  });
});
