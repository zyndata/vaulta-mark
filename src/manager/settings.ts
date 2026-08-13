/**
 * The settings screen: the local-only preferences, the master password, and destroying the vault.
 *
 * A screen rather than a dialog, for the same reason the conflict and import/export views are ones:
 * this is eight sections, several of them a paragraph before their control makes sense, and a
 * `<dialog>` gave them 28rem of width and 60vh of height to live in — so reading the second half of
 * it meant scrolling a box inside a page. Full window, one back button, and the sections laid out in
 * two columns when there is room for two.
 *
 * The popup has its own settings screen (`src/popup/settings.ts`) covering the subset that makes
 * sense where someone already is. Everything it offers is here too, plus the operations that need
 * more room than a popup has.
 *
 * **Destroying the vault is gated twice**, deliberately differently: a typed phrase, and then a
 * second press of the button. The typed phrase is there to make someone read (the same reasoning as
 * the no-recovery confirmation at vault creation — a checkbox is a reflex, a sentence is a
 * decision); the second press is there because the first one is the click that a mis-aimed cursor
 * makes. PLAN §9 asks for a typed *vault name*; vaults have no name, so the phrase is the sentence
 * that says what is about to happen.
 */

import { estimateStrength, MIN_PASSWORD_LENGTH, passwordLength } from '../crypto/password.js';
import { hasHistoryPermission, requestHistoryPermission } from '../history/cleanup.js';
import { DRIVE_SCOPE, requestDrivePermissions } from '../sync/drive/auth.js';
import { copyableValue } from '../ui/address.js';
import {
  onBroadcast,
  send,
  type DriveStateResponse,
  type MigrationProgressBroadcast,
  type MigrationResponse,
  type SyncStatusResponse,
} from '../shared/messages.js';
import { dialogField, dialogText, openDialog } from '../ui/dialog.js';
import { h, matchesPhrase, msg, render } from '../ui/dom.js';
import { historyCleanupPanel } from '../ui/history-cleanup.js';
import { errorText, syncErrorText } from '../ui/strings.js';
import { offerTrackingCleanup } from '../ui/tracking.js';
import { historyDeps } from './history.js';
import {
  IDLE_TIMEOUT_CHOICES,
  IDLE_TIMEOUT_NEVER,
  type VaultSettings,
} from '../vault/types.js';
import { relativeTime, syncQuotaBar } from './sync.js';

export interface SettingsDeps {
  readonly settings: VaultSettings;
  readonly patch: (patch: Partial<VaultSettings>) => Promise<void>;
  /** The page's live region. Used for outcomes that outlive this screen, like a bulk clean-up. */
  readonly say: (text: string) => void;
  readonly onBack: () => void;
  /**
   * Build this screen again from scratch.
   *
   * Used after a provider migration, which changes what half of it says — the provider name, the
   * quota bar, the whole Drive section — and is much better rebuilt than patched in six places.
   */
  readonly reopen: () => void;
  /** Called after the vault has been erased, so the shell can repaint as "no vault". */
  readonly onDestroyed: () => void;
}

/**
 * Build the screen.
 *
 * Async because two answers have to be in hand before the first paint: a quota bar that appears a
 * moment after the page does is a quota bar that moves the destroy button under the cursor, and the
 * privacy section renders a different panel depending on whether `history` has been granted.
 */
export async function settingsScreen(deps: SettingsDeps): Promise<HTMLElement> {
  const status = await send({ type: 'GET_SYNC_STATUS' });
  const drive = await send({ type: 'GET_DRIVE_STATE' });
  const historyGranted = await hasHistoryPermission();

  return h(
    'section',
    { class: 'vm-settings-page', 'aria-label': msg('settingsHeading') },
    h(
      'div',
      { class: 'vm-settings-head' },
      h('h2', null, msg('settingsHeading')),
      h(
        'button',
        { type: 'button', class: 'vm-button vm-button--inline', onclick: deps.onBack },
        msg('settingsBackToBookmarks'),
      ),
    ),
    // Two explicit columns rather than auto-placement: the sections are wildly different heights, so
    // a grid that flows them would leave a row as tall as its tallest member, and the one section
    // that must not drift up beside something innocuous is the last one in the second column.
    h(
      'div',
      { class: 'vm-settings-columns' },
      h(
        'div',
        { class: 'vm-settings-col' },
        section('settingsSectionAppearance', [appearance(deps)]),
        section('settingsSectionLock', locking(deps)),
        section('settingsSectionBrowsing', browsing(deps)),
        section('settingsSectionPrivacy', privacy(deps, historyGranted)),
      ),
      h(
        'div',
        { class: 'vm-settings-col' },
        ...(status.type === 'ERROR'
          ? []
          : [section('syncSectionHeading', sync(status, drive.type === 'ERROR' ? null : drive, deps))]),
        section('settingsSectionPassword', [changePassword()]),
        section('settingsSectionAbout', about()),
        section('settingsSectionDanger', [destroyVault(deps)], 'vm-settings-section--danger'),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ privacy */

/**
 * The history tools.
 *
 * Everything here is off until someone reads it: both controls delete real browsing history, not
 * merely "VaultaMark-related entries". Chrome's own URL prediction is explained during onboarding
 * (ARCHITECTURE §12.4) rather than repeated here — it is a one-time instruction to change a Chrome
 * setting, not something this screen can do or undo.
 */
function privacy(deps: SettingsDeps, historyGranted: boolean): HTMLElement[] {
  return [
    h('p', { class: 'vm-small vm-muted' }, msg('settingsHistoryIntro')),
    historyCleanupPanel({ ...historyDeps(deps.say), granted: historyGranted }),
    toggle(
      'vm-set-clear-on-lock',
      'settingsClearHistoryOnLock',
      'settingsClearHistoryOnLockHint',
      deps.settings.clearHistoryOnLock,
      async (checked) => {
        // The permission is asked for at the moment the switch goes on, from this click. A toggle
        // that stored `true` and then silently did nothing on every lock because nobody had granted
        // `history` is the worst kind of privacy setting.
        if (checked && !(await requestHistoryPermission())) {
          deps.say(msg('historyRefused'));
          return;
        }
        await deps.patch({ clearHistoryOnLock: checked });
      },
    ),
    toggle(
      'vm-set-quick-close',
      'settingsQuickClose',
      'settingsQuickCloseHint',
      deps.settings.quickClose,
      async (checked) => {
        if (checked && !(await requestHistoryPermission())) {
          deps.say(msg('historyRefused'));
          return;
        }
        await deps.patch({ quickClose: checked });
      },
    ),
  ];
}

/* ------------------------------------------------------------------ about */

/**
 * Version, licence, what the extension does with data, and the way back to the first-run flow.
 *
 * PLAN §9 asks for links to SECURITY.md and PRIVACY.md. They are not links, and cannot be: INV-3
 * forbids any absolute URL in the shipped package that is not on `build/url-allowlist.json`, and
 * putting `github.com` there to make an About box clickable would widen an invariant that exists to
 * keep exfiltration paths out of the build. So the substance travels instead of the link — the
 * policy in four sentences, and the repository named rather than addressed. The full documents ship
 * with the source and are what the Store listing points at.
 */
function about(): HTMLElement[] {
  return [
    h(
      'p',
      { class: 'vm-small vm-muted' },
      msg('settingsAboutVersion', [chrome.runtime.getManifest().version]),
    ),
    h('p', { class: 'vm-small vm-muted' }, msg('settingsAboutLicense')),
    h('p', null, msg('settingsAboutPrivacy')),
    h('p', { class: 'vm-small vm-muted' }, msg('settingsAboutSecurity')),
    h('p', { class: 'vm-small vm-muted' }, msg('settingsAboutProject')),
    h(
      'button',
      {
        type: 'button',
        class: 'vm-button vm-button--quiet',
        onclick: () => {
          void (async () => {
            // The stamp is cleared *before* navigating, or the page would open the flow, find a
            // completed record and fall straight through to the manager it came from.
            await send({ type: 'SET_ONBOARDING', patch: { completed: false, step: 0 } });
            location.href = chrome.runtime.getURL('manager.html?onboarding=1');
          })();
        },
      },
      msg('settingsReplayOnboarding'),
    ),
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg('settingsReplayOnboardingHint')),
  ];
}

/**
 * What sync is doing, how much room is left, and which backend it is on.
 *
 * The provider is not a picker with two radio buttons, because switching is not setting a
 * preference — it is copying a vault across, verifying it and turning the old copy off (§6.6). It
 * is one button that does the whole thing and says where it got to.
 */
function sync(
  status: SyncStatusResponse,
  drive: DriveStateResponse | null,
  deps: SettingsDeps,
): HTMLElement[] {
  const line = h(
    'p',
    { class: 'vm-small vm-muted' },
    status.lastSyncedAt === null
      ? msg('syncNever')
      : msg('syncLastSynced', [relativeTime(status.lastSyncedAt)]),
  );
  const now = h(
    'button',
    {
      type: 'button',
      class: 'vm-button vm-button--quiet',
      onclick: () => {
        void (async () => {
          const next = await send({ type: 'SYNC_NOW' });
          if (next.type === 'ERROR') deps.say(errorText(next.code));
          else if (next.error !== null) deps.say(syncErrorText(next.error));
          else if (next.lastSyncedAt !== null) {
            line.textContent = msg('syncLastSynced', [relativeTime(next.lastSyncedAt)]);
          }
        })();
      },
    },
    msg('syncNowButton'),
  );

  return [
    h(
      'p',
      { class: 'vm-small vm-muted' },
      msg(status.providerId === 'drive' ? 'syncProviderDrive' : 'syncProviderChrome'),
    ),
    line,
    // The last error, in its own line rather than only on the toolbar button: this is the screen
    // someone opens *because* something is not syncing.
    ...(status.error === null
      ? []
      : [h('p', { class: 'vm-notice' }, syncErrorText(status.error))]),
    ...(status.error === 'VAULT_MISMATCH'
      ? mismatchChoices({ from: status.providerId, keepLocal: replaceRemote }, deps)
      : []),
    // Drive reports no ceiling for a Workspace account with pooled storage, and a bar with no
    // maximum is a bar that means nothing.
    ...(status.quotaBytes === 0 ? [] : [syncQuotaBar(status)]),
    now,
    ...(drive === null ? [] : driveSection(drive, deps)),
  ];
}

/**
 * The way out of "two vaults, one sync area" — both of the ways out.
 *
 * `VAULT_MISMATCH` is the one sync error with nothing behind it to retry: the bytes in the sync area
 * were written under a different key, no merge can reconcile that, and §6.5 has nothing to say about
 * it. It is not a failure with a cause to fix, it is a **question with two right answers**, and
 * which one is right is not something this code can know:
 *
 * - *Keep this vault.* Overwrite the synced copy and let the other computers ask for this vault's
 *   password from now on.
 * - *Keep the synced one.* Erase what is in this profile and join it — the answer for a profile that
 *   lost its vault (a reinstall, a new extension id) and typed the same password into a *new* one,
 *   which is a new random DEK and is why the merge can never work.
 *
 * Both are destructive to something, so neither is preselected and neither happens on one press:
 * the first is gated on a second press, the second on a dialog that says what this profile loses and
 * asks for the other vault's password. Deliberately **not** something the engine decides on its own,
 * at any confidence.
 */
/** "Keep this vault" for a profile that already syncs where the other vault is. */
async function replaceRemote(): Promise<string | null> {
  const next = await send({ type: 'REPLACE_REMOTE_VAULT' });
  if (next.type === 'ERROR') return errorText(next.code);
  return next.error === null ? null : syncErrorText(next.error);
}

/**
 * The same answer, for a Drive connection that was refused before it flipped anything.
 *
 * `REPLACE_REMOTE_VAULT` would be wrong here and quietly so: this profile is still on Chrome sync,
 * so it would clear *that* backend and never touch the Drive folder the refusal was about.
 * Connecting again with `replaceExisting` is the same operation the button already ran, with the
 * verification and the provider flip still attached to it.
 */
async function takeOverDrive(): Promise<string | null> {
  const response = await send({ type: 'CONNECT_DRIVE', replaceExisting: true });
  if (response.type === 'ERROR') return errorText(response.code);
  return response.ok ? null : migrationFailureText(response);
}

interface MismatchDeps {
  /** Which backend holds the *other* vault — the one an adoption pulls from. */
  readonly from: 'chrome' | 'drive';
  /**
   * "Keep this vault", which is a different operation on each of the two screens that offer it.
   *
   * From the sync section it is `REPLACE_REMOTE_VAULT`: this profile already syncs there, so the
   * copy goes and the next push puts this vault in its place. From a *refused Drive connection* it
   * is the connection again with `replaceExisting`, because `providerId` is still `chrome` at that
   * point — replacing "the synced copy" would clear Chrome sync and never touch Drive at all.
   *
   * Resolves with a message to show, or `null` when it worked.
   */
  readonly keepLocal: () => Promise<string | null>;
}

function mismatchChoices(mismatch: MismatchDeps, deps: SettingsDeps): HTMLElement[] {
  const status = h('p', { class: 'vm-small', role: 'status' });

  const adopt = h(
    'button',
    { type: 'button', class: 'vm-button' },
    msg('syncMismatchKeepRemote'),
  );
  adopt.addEventListener('click', () => {
    void (async () => {
      if (!(await askAdoptRemote(mismatch.from))) return;
      // Everything on screen belongs to a vault that is no longer here. The worker has already
      // broadcast `VAULT_CHANGED`, which reloads the list behind this screen; `reopen` is what
      // rebuilds the screen itself, including whether this block should still be on it.
      deps.say(msg('syncMismatchAdopted'));
      deps.reopen();
    })();
  });

  const replace = h(
    'button',
    { type: 'button', class: 'vm-button vm-button--danger' },
    msg('syncMismatchReplace'),
  );

  let armed = false;
  replace.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      status.classList.add('vm-danger');
      status.textContent = msg('syncMismatchReplaceConfirm');
      return;
    }
    void (async () => {
      replace.disabled = true;
      status.classList.remove('vm-danger');
      status.textContent = msg('syncMismatchReplaceWorking');
      const failure = await mismatch.keepLocal();
      replace.disabled = false;
      armed = false;

      if (failure !== null) {
        status.classList.add('vm-danger');
        status.textContent = failure;
        return;
      }
      // The mismatch is gone, which changes the section that is drawing this button — including
      // whether it should still be here at all.
      deps.say(msg('syncMismatchReplaced'));
      deps.reopen();
    })();
  });

  return [
    h('p', { class: 'vm-small vm-muted' }, msg('syncMismatchExplain')),
    adopt,
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg('syncMismatchKeepRemoteHint')),
    replace,
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg('syncMismatchReplaceHint')),
    status,
  ];
}

/**
 * The synced vault's password, and what this profile gives up for it.
 *
 * The count is read rather than described: "this replaces your vault" means nothing to someone who
 * cannot remember whether this profile's vault has three bookmarks in it or three hundred, and the
 * two cases deserve different amounts of hesitation. It is the same number the replace-mode import
 * shows, from the same place.
 *
 * The request is sent from **inside** `onConfirm`, which is the post-Phase-8 rule for anything that
 * can answer "wrong password": the derivation takes a second and a half, and a dialog that closed
 * first would make someone reopen it and retype everything to fix a typo. While it is outstanding
 * the dialog disables its own buttons, so a 600,000-iteration derivation cannot be started twice.
 */
async function askAdoptRemote(from: 'chrome' | 'drive'): Promise<boolean> {
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  const tree = await send({ type: 'GET_TREE' });
  const local = tree.type === 'ERROR' ? 0 : tree.total;

  let refusal = msg('syncMismatchAdoptNeedsPassword');
  const answer = await openDialog<true>({
    heading: msg('syncMismatchAdoptHeading'),
    body: [
      dialogText('syncMismatchAdoptExplain'),
      // An empty vault is the common case here — a profile that lost its copy and made a new one to
      // find out why sync was refusing it — and it is not a warning at all, so it does not get a
      // warning's styling. "The 0 bookmarks … are erased" is what a stem and a count would have said.
      h(
        'p',
        { class: local === 0 ? 'vm-notice' : 'vm-notice vm-notice--danger' },
        local === 0
          ? msg('syncMismatchAdoptLosesNone')
          : local === 1
            ? msg('syncMismatchAdoptLosesOne')
            : msg('syncMismatchAdoptLoses', [String(local)]),
      ),
      ...(local === 0 ? [] : [dialogText('syncMismatchAdoptBackupFirst')]),
      dialogField('syncMismatchAdoptPassword', password),
    ],
    confirmLabel: msg('syncMismatchAdoptConfirm'),
    danger: true,
    focus: password,
    invalidMessage: () => refusal,
    onConfirm: async () => {
      if (password.value === '') {
        refusal = msg('syncMismatchAdoptNeedsPassword');
        return null;
      }
      const response = await send({
        type: 'ADOPT_REMOTE_VAULT',
        password: password.value,
        from,
      });
      if (response.type === 'ERROR') {
        refusal = errorText(response.code);
        return null;
      }
      // The vault is adopted by this point whatever the status says — an error here is the *next*
      // sync's, not the adoption's, and it belongs on the settings screen rather than in a dialog
      // that would look like it refused.
      return true;
    },
  });
  return answer === true;
}

/**
 * Connecting and disconnecting Drive.
 *
 * The scope sentence is not decoration. `drive.file` is the entire reason this feature could be
 * built without an annual security audit (§13.1), and "it can only see what it made" is the thing a
 * person weighing up whether to grant it needs to know — so it is on screen next to the button, not
 * in a privacy policy.
 */
function driveSection(drive: DriveStateResponse, deps: SettingsDeps): HTMLElement[] {
  const status = h('p', { class: 'vm-small', role: 'status' });
  /**
   * Where the two answers go when a connection is refused because Drive holds another vault.
   *
   * A slot rather than a sentence, because that refusal is the one migration failure that is not a
   * problem to fix: nothing is broken, nothing was changed, and there are two legitimate things to
   * do next. It used to say only that it had not worked — on a screen whose only other control was
   * the button that had just been refused.
   */
  const escape = h('div', { class: 'vm-mismatch' });

  const say = (text: string, danger = false): void => {
    status.classList.toggle('vm-danger', danger);
    status.textContent = text;
  };

  const run = async (
    button: HTMLButtonElement,
    request: 'connect' | { readonly disconnect: true; readonly deleteRemote: boolean },
  ): Promise<void> => {
    button.disabled = true;
    render(escape);

    /*
     * `authorizing` is `to.init()`, whichever way the vault is going — so on a *disconnect* the
     * backend being prepared is Chrome sync and "Asking Google for permission…" names the party
     * being left. That sentence has been on the disconnect path since Drive landed; it is fixed
     * here rather than left because this is the commit that makes the line change at all.
     */
    const phaseText = (phase: Exclude<MigrationProgressBroadcast['phase'], 'done'>): string =>
      phase === 'authorizing' && request !== 'connect'
        ? msg('syncMigratePreparing')
        : msg(MIGRATION_PHASE_KEYS[phase]);

    say(phaseText('authorizing'));

    /*
     * The worker narrates the migration; this listens for the duration of one run and no longer.
     * Uploading an entire vault, reading it back to verify it and switching over take as long as
     * they take, and this line used to say "Asking Google for permission…" through all of it — the
     * one phase that is over in a second was the only one it ever named.
     *
     * `done` is deliberately not rendered: the sentence that replaces it is the outcome, a few
     * lines below, and a "finished" that is then overwritten reads as two different results.
     */
    const stopWatching = onBroadcast((message) => {
      if (message.type !== 'MIGRATION_PROGRESS' || message.phase === 'done') return;
      say(phaseText(message.phase));
    });

    let response;
    try {
      response =
        request === 'connect'
          ? await send({ type: 'CONNECT_DRIVE' })
          : await send({ type: 'DISCONNECT_DRIVE', deleteRemote: request.deleteRemote });
    } finally {
      stopWatching();
    }
    button.disabled = false;

    if (response.type === 'ERROR') {
      say(errorText(response.code), true);
      return;
    }
    if (!response.ok) {
      say(migrationFailureText(response), true);
      if (response.reason === 'mismatch') {
        render(escape, ...mismatchChoices({ from: 'drive', keepLocal: takeOverDrive }, deps));
      }
      return;
    }
    deps.say(msg(request === 'connect' ? 'syncDriveConnected' : 'syncDriveDisconnected'));
    deps.reopen();
  };

  if (!drive.configured) return driveSetup();

  if (drive.connected) {
    const disconnect = h(
      'button',
      { type: 'button', class: 'vm-button vm-button--quiet' },
      msg('syncDriveDisconnect'),
    );
    disconnect.addEventListener('click', () => {
      void (async () => {
        const answer = await askDisconnect();
        if (answer === null) return;
        await run(disconnect, { disconnect: true, deleteRemote: answer.deleteRemote });
      })();
    });

    return [
      h('h4', null, msg('syncDriveHeading')),
      ...(drive.email === null
        ? []
        : [h('p', { class: 'vm-small vm-muted' }, msg('syncDriveAccount', [drive.email]))]),
      h('p', { class: 'vm-small vm-muted' }, msg('syncDriveScope')),
      ...(drive.fileLink === null ? [] : [openInDrive(drive.fileLink)]),
      disconnect,
      status,
      escape,
    ];
  }

  const connect = h('button', { type: 'button', class: 'vm-button' }, msg('syncDriveConnect'));
  connect.addEventListener('click', () => {
    void (async () => {
      // The permission has to be asked for **here**: `chrome.permissions.request` works only from a
      // page during a user gesture, and a service worker cannot ask at all. The worker refuses the
      // migration rather than failing obscurely if this was skipped.
      if (!(await requestDrivePermissions())) {
        say(msg('syncMigrateFailedAuth'), true);
        return;
      }
      await run(connect, 'connect');
    })();
  });

  return [
    h('h4', null, msg('syncDriveHeading')),
    h('p', { class: 'vm-small vm-muted' }, msg('syncDriveExplain')),
    h('p', { class: 'vm-small vm-muted' }, msg('syncDriveScope')),
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg('syncDriveChromeCopyGone')),
    connect,
    status,
    escape,
  ];
}

/**
 * "Switch back to Chrome sync" — and the one question that goes with it.
 *
 * The checkbox used to sit on the settings page above the button, permanently, which made it read as
 * a preference: a tick box about a Drive file with no visible connection to anything, offering to
 * delete something at some unstated later time. It is not a preference. It is a parameter of exactly
 * one action, it has no meaning until that action is taken, and the moment to ask is the moment the
 * action is asked for.
 *
 * The default is off, and stays off. Disconnecting is a reversible thing — reconnecting later finds
 * the vault where it was left — and deleting the remote copy is the one part of it that is not, so it
 * is not what happens to somebody who pressed a button and then Enter.
 */
async function askDisconnect(): Promise<{ readonly deleteRemote: boolean } | null> {
  const deleteRemote = h('input', { type: 'checkbox', id: 'vm-drive-delete' });
  const answer = await openDialog<{ deleteRemote: boolean }>({
    heading: msg('syncDriveDisconnect'),
    body: [
      dialogText('syncDriveDisconnectExplain'),
      h(
        'div',
        null,
        h(
          'div',
          { class: 'vm-checkbox' },
          deleteRemote,
          h('label', { for: 'vm-drive-delete' }, msg('syncDriveDeleteRemote')),
        ),
        h('p', { class: 'vm-hint vm-small vm-muted' }, msg('syncDriveDeleteRemoteHint')),
      ),
    ],
    confirmLabel: msg('syncDriveDisconnectConfirm'),
    onConfirm: () => ({ deleteRemote: deleteRemote.checked }),
  });
  return answer;
}

/**
 * What to do about a build with no Google project behind it (RELEASE §5).
 *
 * This is the state every build from a fresh clone starts in, and until now it said only that Drive
 * was unavailable — true, and useless to the one person who can change it. The steps live here
 * rather than only in the docs because the two values that have to be carried to the Google Cloud
 * console are *properties of the running build*: the extension id is this profile's, and reading it
 * off `chrome://extensions` or out of a build script is the step people get wrong.
 *
 * **There is no link to the console, and there cannot be.** INV-3 allows no absolute URL in `dist/`
 * outside `build/url-allowlist.json`, and widening that list so a settings screen can offer a
 * convenience link is the wrong trade — the same call as the About section in onboarding (§12.4).
 * So the console is named and not addressed, and the panel says why rather than leaving it looking
 * like an omission.
 *
 * Nothing here is actionable by a normal user, which is the point: a build from the Store has a
 * client id compiled in, `configured` is true, and this panel never renders. It is a maintainer's
 * screen that happens to live where the maintainer will be standing when they need it.
 */
function driveSetup(): HTMLElement[] {
  const step = (key: string, value?: HTMLElement): HTMLElement =>
    value === undefined ? h('li', null, msg(key)) : h('li', null, msg(key), ' ', value);

  return [
    h('h4', null, msg('syncDriveHeading')),
    h('p', { class: 'vm-notice' }, msg('syncDriveUnavailable')),
    h('p', { class: 'vm-small vm-muted' }, msg('syncDriveSetupIntro')),
    h(
      'ol',
      { class: 'vm-steps' },
      step('syncDriveSetupProject'),
      step('syncDriveSetupScope', copyableValue({ value: DRIVE_SCOPE })),
      step('syncDriveSetupPublish'),
      step('syncDriveSetupClient', copyableValue({ value: chrome.runtime.id })),
      step('syncDriveSetupEnv'),
    ),
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg('syncDriveSetupIdNote')),
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg('syncDriveSetupNoLink')),
  ];
}

/**
 * The Drive file, opened in a tab.
 *
 * The address comes from Drive's own `webViewLink` rather than being built here: INV-3 forbids
 * absolute URLs in the package, and the honest reason is the same one — we do not know where Drive
 * keeps a file, and guessing at a URL shape is how a link rots.
 */
function openInDrive(link: string): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: 'vm-button vm-button--quiet',
      onclick: () => {
        void chrome.tabs.create({ url: link });
      },
    },
    msg('syncDriveOpenFile'),
  );
}

/**
 * The running commentary, one sentence per step. Exhaustive over the broadcast's phases for the
 * same reason as the failure table below: a phase added to `sync/migration.ts` and forgotten here
 * would leave the status line stuck on the previous step rather than failing anywhere visible.
 *
 * `done` is in the type and not in this table — it is the end of the narration, not a line of it.
 */
const MIGRATION_PHASE_KEYS: Record<
  Exclude<MigrationProgressBroadcast['phase'], 'done'>,
  string
> = {
  authorizing: 'syncMigrateAuthorizing',
  uploading: 'syncMigrateUploading',
  verifying: 'syncMigrateVerifying',
  switching: 'syncMigrateSwitching',
  cleaning: 'syncMigrateCleaning',
};

/** Spelled out rather than derived, so a new failure reason breaks the build instead of the UI. */
const MIGRATION_FAILURE_KEYS: Record<
  NonNullable<MigrationResponse['reason']>,
  string
> = {
  locked: 'syncMigrateFailedLocked',
  auth: 'syncMigrateFailedAuth',
  offline: 'syncMigrateFailedOffline',
  'too-large': 'syncMigrateFailedTooLarge',
  mismatch: 'syncMigrateFailedMismatch',
  verify: 'syncMigrateFailedVerify',
  unknown: 'syncMigrateFailedUnknown',
};

function migrationFailureText(response: MigrationResponse): string {
  const reason = response.reason ?? 'unknown';
  if (reason !== 'too-large') return msg(MIGRATION_FAILURE_KEYS[reason]);
  return msg(MIGRATION_FAILURE_KEYS[reason], [
    String(response.items ?? 0),
    String(response.fits ?? 0),
  ]);
}

function section(headingKey: string, children: HTMLElement[], extraClass?: string): HTMLElement {
  return h(
    'section',
    { class: `vm-settings-section${extraClass === undefined ? '' : ` ${extraClass}`}` },
    h('h3', null, msg(headingKey)),
    ...children,
  );
}

/* ------------------------------------------------------------------ preferences */

/** Spelled out rather than derived, so a new theme value breaks the build instead of the UI. */
const THEME_LABEL_KEYS: Record<VaultSettings['theme'], string> = {
  system: 'themeSystem',
  light: 'themeLight',
  dark: 'themeDark',
};

function appearance(deps: SettingsDeps): HTMLElement {
  const select = h(
    'select',
    {
      onchange: (event: Event) => {
        void deps.patch({
          theme: (event.currentTarget as HTMLSelectElement).value as VaultSettings['theme'],
        });
      },
    },
    ...(Object.entries(THEME_LABEL_KEYS) as [VaultSettings['theme'], string][]).map(
      ([theme, key]) =>
        h('option', { value: theme, selected: theme === deps.settings.theme }, msg(key)),
    ),
  );
  return dialogField('settingsTheme', select);
}

function locking(deps: SettingsDeps): HTMLElement[] {
  const idle = h(
    'select',
    {
      onchange: (event: Event) => {
        void deps.patch({
          idleTimeoutMinutes: Number((event.currentTarget as HTMLSelectElement).value),
        });
      },
    },
    ...IDLE_TIMEOUT_CHOICES.map((minutes) =>
      h(
        'option',
        { value: String(minutes), selected: minutes === deps.settings.idleTimeoutMinutes },
        minutes === IDLE_TIMEOUT_NEVER
          ? msg('settingsIdleNever')
          : msg('settingsIdleMinutes', [String(minutes)]),
      ),
    ),
  );
  return [
    dialogField('settingsIdleTimeout', idle),
    toggle('vm-set-blur', 'settingsLockOnBlur', 'settingsLockOnBlurHint', deps.settings.lockOnBrowserBlur, (checked) =>
      deps.patch({ lockOnBrowserBlur: checked }),
    ),
    // PLAN §9 lists "require password after restart" among the security settings. It is not a
    // setting and cannot be one: the unlocked key lives in `chrome.storage.session`, which is
    // memory-backed and emptied when Chrome exits (D14), so the vault locks on restart whatever
    // anyone would have ticked. A toggle that could only ever be on and could never be turned off
    // is a lie about how much control the user has, so this states the fact instead.
    h(
      'div',
      { class: 'vm-settings-note' },
      h('p', null, msg('settingsRestartLock')),
      h('p', { class: 'vm-hint vm-small vm-muted' }, msg('settingsRestartLockHint')),
    ),
  ];
}

function browsing(deps: SettingsDeps): HTMLElement[] {
  return [
    toggle(
      'vm-set-reuse',
      'settingsReuseWindow',
      'settingsReuseWindowHint',
      deps.settings.reuseIncognitoWindow,
      (checked) => deps.patch({ reuseIncognitoWindow: checked }),
    ),
    toggle(
      'vm-set-strip',
      'settingsStripTracking',
      'settingsStripTrackingHint',
      deps.settings.stripTrackingParams,
      async (checked) => {
        await deps.patch({ stripTrackingParams: checked });
        // Only on the way on: switching it off cannot put back parameters that are already gone,
        // so there is nothing to offer.
        if (checked) await offerCleanup(deps);
      },
    ),
    // Where the one-time offer in the popup ends up living, and the only way back once it has been
    // answered (§14.4). It has no effect while Drive is connected — the heavy tier captures either
    // way — which is what the hint says rather than what a disabled control would imply.
    toggle(
      'vm-set-thumbs',
      'settingsLocalThumbnails',
      'settingsLocalThumbnailsHint',
      deps.settings.localThumbnails,
      (checked) => deps.patch({ localThumbnails: checked, thumbnailsOffered: true }),
    ),
  ];
}

/**
 * Wire `ui/tracking.ts` to its two messages.
 *
 * The result is announced through the page's live region rather than inside this screen, because
 * the clean-up outlives it: it rewrites addresses across the whole vault, the list behind is what
 * shows it, and a confirmation that disappears with the screen is one nobody reads.
 */
async function offerCleanup(deps: SettingsDeps): Promise<void> {
  await offerTrackingCleanup({
    count: async () => {
      const response = await send({ type: 'COUNT_TRACKING_PARAMS' });
      // Nothing has changed if the count failed, and the offer comes back the next time the
      // setting is switched on. Not worth a dialog.
      return response.type === 'ERROR' ? 0 : response.count;
    },
    strip: async () => {
      const response = await send({ type: 'STRIP_TRACKING_PARAMS' });
      if (response.type === 'ERROR') {
        deps.say(errorText(response.code));
        return 0;
      }
      return response.count;
    },
    say: deps.say,
  });
}

function toggle(
  id: string,
  labelKey: string,
  hintKey: string,
  checked: boolean,
  onChange: (checked: boolean) => Promise<void>,
): HTMLElement {
  const input = h('input', {
    type: 'checkbox',
    id,
    checked,
    onchange: (event: Event) => {
      void onChange((event.currentTarget as HTMLInputElement).checked);
    },
  });
  return h(
    'div',
    null,
    h('div', { class: 'vm-checkbox' }, input, h('label', { for: id }, msg(labelKey))),
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg(hintKey)),
  );
}

/* ------------------------------------------------------------------ master password */

function changePassword(): HTMLElement {
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password' });
  const meter = h(
    'div',
    { class: 'vm-meter', 'data-score': '0', 'aria-hidden': 'true' },
    ...Array.from({ length: 5 }, () => h('span')),
  );
  const status = h('p', { class: 'vm-small', role: 'status' });
  const submit = h('button', { class: 'vm-button', type: 'button' }, msg('settingsChangePassword'));

  let latest = 0;
  next.addEventListener('input', () => {
    const token = ++latest;
    const typed = next.value;
    if (typed === '') {
      meter.setAttribute('data-score', '0');
      return;
    }
    void estimateStrength(typed).then((estimate) => {
      if (token === latest) meter.setAttribute('data-score', String(estimate.score));
    });
  });

  submit.addEventListener('click', () => {
    void (async () => {
      status.classList.remove('vm-danger', 'vm-ok');
      if (passwordLength(next.value) < MIN_PASSWORD_LENGTH) {
        status.classList.add('vm-danger');
        status.textContent = errorText('PASSWORD_TOO_SHORT');
        return;
      }
      if (next.value !== confirm.value) {
        status.classList.add('vm-danger');
        status.textContent = msg('createPasswordsDiffer');
        return;
      }

      submit.disabled = true;
      const response = await send({
        type: 'CHANGE_PASSWORD',
        currentPassword: current.value,
        newPassword: next.value,
      });
      submit.disabled = false;

      if (response.type === 'ERROR') {
        status.classList.add('vm-danger');
        status.textContent = errorText(response.code);
        return;
      }
      current.value = '';
      next.value = '';
      confirm.value = '';
      meter.setAttribute('data-score', '0');
      status.classList.add('vm-ok');
      status.textContent = msg('settingsPasswordChanged');
    })();
  });

  return h(
    'div',
    null,
    dialogField('settingsCurrentPassword', current),
    dialogField('settingsNewPassword', next),
    meter,
    dialogField('settingsConfirmPassword', confirm),
    submit,
    status,
  );
}

/* ------------------------------------------------------------------ destroying it */

function destroyVault(deps: SettingsDeps): HTMLElement {
  const phrase = msg('settingsDestroyPhrase');
  const typed = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });
  const status = h('p', { class: 'vm-small', role: 'status' });
  // Ticked. "Destroy my vault" that erased the local copy and left the encrypted one in the sync
  // area was not a smaller version of the promise — the profile came back offering to adopt the
  // vault it had just destroyed, and a replacement made with the same password could never open
  // those bytes (a new vault is a new DEK), so the two deadlocked with no way out. Anyone who does
  // want the copy left for another computer unticks it and reads what that means.
  const alsoRemote = h('input', { type: 'checkbox', id: 'vm-destroy-remote', checked: true });
  const button = h(
    'button',
    { class: 'vm-button vm-button--danger', type: 'button', disabled: true },
    msg('settingsDestroyButton'),
  );

  /** Set once the user has been asked a second time. The second press is the one that erases. */
  let armed = false;

  typed.addEventListener('input', () => {
    button.disabled = !matchesPhrase(typed.value, phrase);
    if (button.disabled && armed) {
      armed = false;
      status.textContent = '';
    }
  });

  button.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      status.classList.add('vm-danger');
      status.textContent = msg('settingsDestroyConfirm');
      return;
    }
    void (async () => {
      button.disabled = true;
      const response = await send({ type: 'DESTROY_VAULT', deleteRemote: alsoRemote.checked });
      if (response.type === 'ERROR') {
        status.textContent = errorText(response.code);
        button.disabled = false;
        return;
      }
      status.classList.remove('vm-danger');
      // Three different sentences, because they describe three different states of the world and a
      // single "your vault has been destroyed" would be a half-truth in two of them.
      status.textContent = msg(
        response.remoteRemoved === null
          ? 'settingsDestroyedRemoteKept'
          : response.remoteRemoved
            ? 'settingsDestroyed'
            : 'settingsDestroyedRemoteFailed',
      );
      deps.onDestroyed();
    })();
  });

  const box = h('div', { class: 'vm-danger-zone' });
  render(
    box,
    h('p', { class: 'vm-notice vm-notice--danger' }, msg('settingsDestroyWarning')),
    dialogField('settingsDestroyLabel', typed, msg('settingsDestroyHint', [phrase])),
    h(
      'div',
      null,
      h(
        'div',
        { class: 'vm-checkbox' },
        alsoRemote,
        h('label', { for: 'vm-destroy-remote' }, msg('settingsDestroyRemote')),
      ),
      h('p', { class: 'vm-hint vm-small vm-muted' }, msg('settingsDestroyRemoteHint')),
    ),
    button,
    status,
  );
  return box;
}
