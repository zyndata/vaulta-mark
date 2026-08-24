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

// Kept in step with build/url-allowlist.json by hand, and deliberately so: the scanner checks the
// built output and this checks the source, and an assertion that imports the value it is asserting
// proves nothing. oauth2.googleapis.com is the OAuth token endpoint (ARCHITECTURE §13.2).
const ABSOLUTE_URL_BAN = {
  selector:
    'Literal[value=/^https?:\\/\\/(?!www\\.googleapis\\.com|accounts\\.google\\.com|oauth2\\.googleapis\\.com)/]',
  message:
    'INV-3: absolute URLs in shipped code must be on the allowlist in build/url-allowlist.json.',
};

// Every primitive, parameter and error path lives in one directory that can be read end to end and
// audited as a unit. A second call site for crypto.subtle is how a vault ends up with two envelope
// formats, or an AES-GCM key with an IV nobody checked. PLAN.md Phase 2, ARCHITECTURE §4.
const SUBTLE_BAN = {
  selector: "MemberExpression[property.name='subtle']",
  message: 'crypto.subtle is confined to src/crypto/**. Call the module that wraps the primitive.',
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
      'no-restricted-syntax': [
        'error',
        ...REMOTE_CODE_BANS,
        BOOKMARKS_BAN,
        ABSOLUTE_URL_BAN,
        SUBTLE_BAN,
      ],
    },
  },

  // The only module allowed to read Chrome's bookmark tree, and only to import from it (Phase 8).
  {
    files: ['src/import/native-bookmarks.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...REMOTE_CODE_BANS, ABSOLUTE_URL_BAN, SUBTLE_BAN],
    },
  },

  /**
   * Vendored third-party source (ARCHITECTURE §15).
   *
   * The invariant bans stay on — a vendored file is shipped code and INV-1, INV-5 and INV-8 do not
   * care who wrote it. What comes off is the house style, because the file is byte-identical to
   * upstream on purpose: it is reviewed as a diff against the published package, and reformatting
   * it to our taste would throw that away to satisfy a rule about how *we* write loops.
   *
   * The rules are listed one by one rather than switched off wholesale, so a future vendored file
   * that trips a *different* one surfaces as a decision to make instead of as silence.
   */
  {
    files: ['src/vendor/**'],
    rules: {
      '@typescript-eslint/prefer-for-of': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-useless-assignment': 'off',
    },
  },

  // The one place WebCrypto is reachable. Everything else on this list still applies.
  {
    files: ['src/crypto/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...REMOTE_CODE_BANS, BOOKMARKS_BAN, ABSOLUTE_URL_BAN],
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
