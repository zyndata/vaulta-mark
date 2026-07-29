import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The lint rules that carry a hard invariant are the `no-restricted-syntax` blocks below. They
 * are the first line of defence; `npm run verify:invariants` is the second, and it scans the
 * built output rather than the source, so a rule disabled here still fails the build there.
 * See PLAN.md §4.
 */
const REMOTE_CODE_BANS = [
  {
    selector: "CallExpression[callee.name='eval']",
    message: 'INV-1: no eval. The CSP forbids it and the invariant scanner fails the build on it.',
  },
  {
    selector: "NewExpression[callee.name='Function'], CallExpression[callee.name='Function']",
    message: 'INV-1: the Function constructor is eval by another name.',
  },
  {
    selector: "MemberExpression[property.name='sendBeacon']",
    message: 'INV-8: no telemetry, no analytics, no beacons. Ever.',
  },
  {
    selector: "NewExpression[callee.name='XMLHttpRequest']",
    message: 'Use fetch, and only on the Drive path (INV-4).',
  },
  {
    selector: "MemberExpression[object.name='WebAssembly']",
    message: "INV-1/INV-2: we ship no WASM — it would require 'wasm-unsafe-eval' in the CSP.",
  },
];

const BOOKMARKS_BAN = {
  selector: "MemberExpression[object.name='chrome'][property.name='bookmarks']",
  message:
    'INV-5: chrome.bookmarks never stores vault items — that is the whole point of the product. ' +
    'It is read-only to us, and only in src/import/native-bookmarks.ts.',
};

const ABSOLUTE_URL_BAN = {
  selector: 'Literal[value=/^https?:\\/\\/(?!www\\.googleapis\\.com|accounts\\.google\\.com)/]',
  message:
    'INV-3: absolute URLs in shipped code must be on the allowlist in build/url-allowlist.json.',
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'node_modules/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // `noUncheckedIndexedAccess` is on, so bracket access into a Record or a DOMStringMap is
      // the form that gets you the `| undefined` you are supposed to handle.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      'no-restricted-syntax': ['error', ...REMOTE_CODE_BANS, BOOKMARKS_BAN],
    },
  },

  // Shipped code carries the URL ban as well; build scripts, tests and docs tooling legitimately
  // name URLs (allowlists, fixtures, the scanner's own test inputs).
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...REMOTE_CODE_BANS, BOOKMARKS_BAN, ABSOLUTE_URL_BAN],
    },
  },

  // The only module allowed to read Chrome's bookmark tree, and only to import from it (Phase 8).
  {
    files: ['src/import/native-bookmarks.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...REMOTE_CODE_BANS, ABSOLUTE_URL_BAN],
    },
  },

  {
    files: ['build/**/*.ts', 'scripts/**/*.mjs', '*.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },

  // Hand-written Node scripts: typed by JSDoc, not worth the type-aware rule set.
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
  },

  {
    files: ['test/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // Tests deliberately feed the wrong shapes to the code under test, and a wrong assumption
      // in a test fails the test — which is the point — rather than shipping.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
