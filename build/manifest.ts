/**
 * The single source of truth for `manifest.json`.
 *
 * Emitted by `build/mv3-plugin.ts` at build time and re-checked against
 * `build/permissions.lock.json` by `scripts/verify-manifest.mjs` (INV-2, INV-9).
 * Spec: docs/ARCHITECTURE.md §2 "`manifest.json` (generated)".
 */

import { toChromeVersion } from './version.ts';

/**
 * INV-2. Exact, byte-for-byte. `scripts/verify-manifest.mjs` asserts the same literal
 * independently — the duplication is the point, so a change here cannot silently pass.
 */
export const EXTENSION_PAGES_CSP = "script-src 'self'; object-src 'self'; frame-ancestors 'none'";

/** D25 / INV-9. No host permissions at install time; `activeTab` covers every add entry point. */
export const REQUIRED_PERMISSIONS = [
  'storage',
  'activeTab',
  'scripting',
  'contextMenus',
  'alarms',
  'favicon',
] as const;

/** D26. Requested in context, at first use, never at install. */
export const OPTIONAL_PERMISSIONS = ['identity', 'history', 'bookmarks', 'idle'] as const;

/** D21/D22. Requested together with `identity` when the user opts into Drive sync (Phase 10). */
export const OPTIONAL_HOST_PERMISSIONS = ['https://www.googleapis.com/*'] as const;

/** D4x. Chrome 116 is the floor — see PLAN.md §11, resolved decision 4. */
export const MINIMUM_CHROME_VERSION = '116';

/**
 * D22 / ARCHITECTURE §13.1. The only OAuth scope this extension ever asks for.
 *
 * `drive.file` sees nothing but the files the extension itself created. Full `drive` is a
 * *Restricted* scope, which means an annual CASA Tier-2 assessment by a paid third-party assessor
 * standing between every release and the Store. This is asserted in the manifest test as well as
 * against the auth call, because it is the one line where a widening would be invisible.
 */
export const OAUTH_SCOPES = ['https://www.googleapis.com/auth/drive.file'] as const;

export interface ManifestOptions {
  /**
   * The OAuth client id (RELEASE §5.3), from `VM_OAUTH_CLIENT_ID`.
   *
   * Absent in a plain source build, and then the `oauth2` block is **omitted entirely** rather than
   * emitted with an empty client. Chrome treats a malformed `oauth2` as a manifest error and
   * refuses to load the extension; a build with no Google project configured should still install,
   * run, and sync through Chrome — it simply cannot offer Drive, and the settings screen says so.
   */
  readonly clientId?: string | undefined;
  /**
   * The base64 public key that pins the unpacked extension id (RELEASE §5.4), from
   * `VM_MANIFEST_KEY`.
   *
   * **Development only.** The Store assigns the real id, and a `key` that disagrees with it breaks
   * the upload — so `mv3-plugin.ts` passes this for a development build and never for a production
   * one.
   */
  readonly key?: string | undefined;
}

export function buildManifest(
  packageVersion: string,
  options: ManifestOptions = {},
): chrome.runtime.ManifestV3 {
  const clientId = options.clientId ?? '';
  const key = options.key ?? '';
  return {
    manifest_version: 3,
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    version: toChromeVersion(packageVersion),
    minimum_chrome_version: MINIMUM_CHROME_VERSION,

    icons: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },

    background: {
      service_worker: 'background.js',
      type: 'module',
    },

    action: {
      default_popup: 'popup.html',
      default_title: '__MSG_actionTitle__',
      default_icon: {
        16: 'icons/icon16.png',
        32: 'icons/icon32.png',
        48: 'icons/icon48.png',
        128: 'icons/icon128.png',
      },
    },

    options_page: 'manager.html',

    // Phase 10. No client *secret* ships — the OAuth client is bound to the extension id, and the
    // `launchWebAuthFlow` fallback uses PKCE for exactly the same reason (§13.2).
    ...(clientId === '' ? {} : { oauth2: { client_id: clientId, scopes: [...OAUTH_SCOPES] } }),
    ...(key === '' ? {} : { key }),

    permissions: [...REQUIRED_PERMISSIONS],
    optional_permissions: [...OPTIONAL_PERMISSIONS],
    optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],

    content_security_policy: {
      extension_pages: EXTENSION_PAGES_CSP,
    },

    // D29. The service worker — and therefore the unlocked session — is shared with incognito
    // windows, which is what makes "open every vaulted link in incognito" work at all.
    incognito: 'spanning',

    commands: {
      'add-current-tab': {
        suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' },
        description: '__MSG_cmdAdd__',
      },
      'panic-lock': {
        suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' },
        description: '__MSG_cmdLock__',
      },
      'open-manager': {
        suggested_key: { default: 'Ctrl+Shift+B', mac: 'Command+Shift+B' },
        description: '__MSG_cmdManager__',
      },
      // Phase 9, §12.3. Inert until the user switches it on in Settings → Privacy *and* grants the
      // optional `history` permission; the binding exists from install so it is visible on
      // chrome://extensions/shortcuts, where a user can move it off a combination they already use.
      // This is the fourth and last suggested key — Chrome grants an extension no more than four.
      'quick-close': {
        suggested_key: { default: 'Ctrl+Shift+X', mac: 'Command+Shift+X' },
        description: '__MSG_cmdQuickClose__',
      },
    },

    // Deliberately empty, and verified empty: nothing we ship should be reachable from a web page.
    // The OG-capture script (Phase 11) is injected via `scripting.executeScript` under `activeTab`,
    // which is also why there is no `content_scripts` block here.
    web_accessible_resources: [],
  };
}
