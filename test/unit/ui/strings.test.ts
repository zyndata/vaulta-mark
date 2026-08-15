/**
 * @vitest-environment jsdom
 *
 * The code → `_locales` key tables.
 *
 * The assertion worth having here is not that a table maps `WRONG_PASSWORD` to something — it is
 * that **every key these tables name exists in `_locales/en/messages.json`**. TypeScript proves the
 * tables are exhaustive over the union; nothing but a test proves the strings on the other side are
 * real, and a missing one renders as an empty string, which reads exactly like "nothing went wrong".
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MIN_PASSWORD_LENGTH } from '../../../src/crypto/password.js';
import { ERROR_KEYS, LOCK_REASON_KEYS, WARNING_KEYS, errorText } from '../../../src/ui/strings.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

// Resolved from the working directory rather than from `import.meta.url`: under the jsdom
// environment `import.meta.url` is an `http:` URL, and `fileURLToPath` refuses it. Vitest always
// runs from the project root.
const MESSAGES = JSON.parse(
  readFileSync(resolve('public/_locales/en/messages.json'), 'utf8'),
) as Record<string, { message: string }>;

beforeEach(() => {
  installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('the tables', () => {
  it.each([
    ['ERROR_KEYS', ERROR_KEYS],
    ['WARNING_KEYS', WARNING_KEYS],
    ['LOCK_REASON_KEYS', LOCK_REASON_KEYS],
  ])('names only strings that exist in _locales (%s)', (_name, table) => {
    for (const [code, key] of Object.entries(table)) {
      expect(MESSAGES[key], `${code} → ${key}`).toBeDefined();
      expect(MESSAGES[key]?.message).not.toBe('');
    }
  });

  it('gives every code a distinct string, so two failures never read the same', () => {
    const keys = Object.values(ERROR_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('errorText', () => {
  it('passes the minimum length to the one message that has a placeholder for it', () => {
    // The mock's `getMessage` answers with the key, so what is worth asserting is the *call*: the
    // string on the other side has a `$MINIMUM$` in it, and a caller that forgot the substitution
    // would ship a sentence with a dollar sign in it to every user.
    const spy = vi.spyOn(chrome.i18n, 'getMessage');
    errorText('PASSWORD_TOO_SHORT');
    expect(spy).toHaveBeenCalledWith('errorPasswordTooShort', [String(MIN_PASSWORD_LENGTH)]);
    expect(MESSAGES['errorPasswordTooShort']?.message).toContain('$MINIMUM$');
  });

  it('asks for exactly one string, with no substitutions, for every other code', () => {
    for (const code of Object.keys(ERROR_KEYS) as (keyof typeof ERROR_KEYS)[]) {
      if (code === 'PASSWORD_TOO_SHORT') continue;
      const spy = vi.spyOn(chrome.i18n, 'getMessage');
      expect(errorText(code), code).toBe(ERROR_KEYS[code]);
      expect(spy, code).toHaveBeenCalledWith(ERROR_KEYS[code]);
      // …and the message it named has no placeholder left unfilled.
      expect(MESSAGES[ERROR_KEYS[code]]?.message, code).not.toMatch(/\$[A-Z]+\$/u);
      spy.mockRestore();
    }
  });
});
