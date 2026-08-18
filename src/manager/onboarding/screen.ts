/**
 * The five-step first-run flow (PLAN §9 Phase 9), on `manager.html?onboarding=1`.
 *
 * The gates are in `steps.ts` and are deliberately not re-implemented here: this file renders a step
 * and reports what happened, and the only thing that decides whether Next moves is `canAdvance`.
 *
 * It lives on the manager page rather than in the popup for the same reason the incognito prompt
 * does: step 3 sends the user to a `chrome://` tab and waits for them to come back, and a popup is
 * gone the moment focus leaves it (ARCHITECTURE §9).
 *
 * **Every step re-reads the world instead of remembering it.** Whether a vault exists and whether
 * incognito access is on are both facts a user can change in another window — one by finishing the
 * flow in a second tab, the other by ticking a checkbox on `chrome://extensions` — and a wizard that
 * cached them at mount would gate on a state that stopped being true a minute ago.
 */

import { hasHistoryPermission } from '../../history/cleanup.js';
import { send } from '../../shared/messages.js';
import { incognitoSteps } from '../../ui/incognito-prompt.js';
import { createVaultForm } from '../../ui/create-form.js';
import { h, msg, render } from '../../ui/dom.js';
import { historyCleanupPanel } from '../../ui/history-cleanup.js';
import { errorText } from '../../ui/strings.js';
import {
  ONBOARDING_STEPS,
  back,
  canAdvance,
  isLastStep,
  next,
  stepAt,
  type OnboardingProgress,
} from './steps.js';
import { historyDeps } from '../history.js';

export interface OnboardingOptions {
  /** Where the flow resumes, from `resumeStep`. */
  readonly step: number;
  readonly vaultExists: boolean;
  readonly incognitoSkipped: boolean;
  /** Called when the last step is finished. The page decides what it becomes — normally the manager. */
  readonly onFinish: () => void;
}

export function mountOnboarding(root: HTMLElement, options: OnboardingOptions): void {
  const progress: { -readonly [K in keyof OnboardingProgress]: OnboardingProgress[K] } = {
    step: options.step,
    vaultExists: options.vaultExists,
    incognitoAllowed: false,
    incognitoSkipped: options.incognitoSkipped,
  };

  /** `chrome://extensions/?id=…`, from the worker — only it knows the extension id. */
  let settingsUrl = '';

  const body = h('div', { class: 'vm-onboarding-body' });
  const dots = h('ol', { class: 'vm-onboarding-dots', 'aria-hidden': 'true' });
  const counter = h('p', { class: 'vm-small vm-muted' });
  const status = h('p', { class: 'vm-notice', role: 'status', hidden: true });

  const backButton = h(
    'button',
    {
      type: 'button',
      class: 'vm-button vm-button--quiet',
      onclick: () => {
        void goTo(back(progress));
      },
    },
    msg('onboardingBack'),
  );

  const nextButton = h(
    'button',
    {
      type: 'button',
      class: 'vm-button',
      onclick: () => {
        void advance();
      },
    },
    msg('onboardingNext'),
  );

  render(
    root,
    h(
      'section',
      { class: 'vm-onboarding' },
      h(
        'header',
        { class: 'vm-onboarding-head' },
        h('h1', { class: 'vm-wordmark' }, msg('onboardingTitle')),
        counter,
        dots,
      ),
      status,
      body,
      h('footer', { class: 'vm-onboarding-foot' }, backButton, nextButton),
    ),
  );

  void refresh();

  /* ---------------------------------------------------------------- the shell */

  function say(text: string | null, kind: 'info' | 'danger' = 'info'): void {
    status.textContent = text ?? '';
    status.hidden = text === null;
    status.classList.toggle('vm-notice--danger', kind === 'danger');
  }

  /**
   * Re-read what the gates depend on, then repaint.
   *
   * One `GET_STATE` and one `INCOGNITO_ACCESS`, both cheap, both answered while locked. The second
   * is *not* re-checked: the cached answer is what the Re-check button exists to bypass, and asking
   * Chrome afresh on every repaint would make the button meaningless.
   */
  async function refresh(): Promise<void> {
    const state = await send({ type: 'GET_STATE' });
    if (state.type !== 'ERROR') progress.vaultExists = state.exists;

    const access = await send({ type: 'INCOGNITO_ACCESS' });
    if (access.type !== 'ERROR') {
      progress.incognitoAllowed = access.allowed;
      settingsUrl = access.settingsUrl;
    }
    paint();
  }

  async function goTo(step: number): Promise<void> {
    if (step === progress.step) return;
    progress.step = step;
    say(null);
    // Persisted on every move, so a closed tab resumes where it was rather than starting over. Fire
    // and forget: losing the write costs a repeated screen, and awaiting it would put a storage
    // round trip between the click and the repaint.
    void send({ type: 'SET_ONBOARDING', patch: { step } });
    await refresh();
  }

  async function advance(): Promise<void> {
    if (!canAdvance(progress)) {
      say(msg(blockedMessageKey()), 'danger');
      return;
    }
    if (isLastStep(progress.step)) {
      await send({ type: 'SET_ONBOARDING', patch: { completed: true } });
      options.onFinish();
      return;
    }
    await goTo(next(progress));
  }

  /** Why Next did nothing. Only the two gated steps can produce this. */
  function blockedMessageKey(): string {
    return stepAt(progress.step) === 'password'
      ? 'onboardingNeedsVault'
      : 'onboardingNeedsIncognito';
  }

  function paint(): void {
    const step = stepAt(progress.step);
    counter.textContent = msg('onboardingStepOf', [
      String(progress.step + 1),
      String(ONBOARDING_STEPS.length),
    ]);
    render(
      dots,
      ...ONBOARDING_STEPS.map((_, index) =>
        h('li', { class: index === progress.step ? 'is-current' : '' }),
      ),
    );

    backButton.disabled = progress.step === 0;
    nextButton.textContent = msg(isLastStep(progress.step) ? 'onboardingFinish' : 'onboardingNext');
    // Not `disabled`: a Next that is simply dead teaches nothing, while one that answers "the
    // acknowledgement above has not been typed yet" points at the thing in the way. The gate is
    // still `canAdvance` — this only decides how the refusal reads.
    nextButton.classList.toggle('vm-button--quiet', !canAdvance(progress));

    render(body, screenFor(step));
  }

  function screenFor(step: ReturnType<typeof stepAt>): HTMLElement {
    switch (step) {
      case 'intro':
        return introStep();
      case 'password':
        return passwordStep();
      case 'incognito':
        return incognitoStep();
      case 'sync':
        return syncStep();
      case 'chrome':
        return chromeStep();
    }
  }

  /* ---------------------------------------------------------------- 1. what this is */

  function introStep(): HTMLElement {
    return h(
      'div',
      { class: 'vm-onboarding-step' },
      h('h2', null, msg('onboardingIntroHeading')),
      h('p', null, msg('onboardingIntroBody')),
      h(
        'ul',
        { class: 'vm-onboarding-points' },
        h('li', null, msg('onboardingIntroPointOmnibox')),
        h('li', null, msg('onboardingIntroPointIncognito')),
        h('li', null, msg('onboardingIntroPointEncrypted')),
      ),
      h('p', { class: 'vm-small vm-muted' }, msg('onboardingIntroFooter')),
    );
  }

  /* ---------------------------------------------------------------- 2. the password */

  /**
   * Create the vault, behind the typed no-recovery acknowledgement.
   *
   * The gate is `progress.vaultExists`, not "the form said it was done": the only thing that can set
   * it is a `CREATE_VAULT` that succeeded, and the only thing that can send one is a form whose
   * phrase matched. There is no code path from Next to step 3 that does not go through a real vault.
   */
  function passwordStep(): HTMLElement {
    if (progress.vaultExists) {
      return h(
        'div',
        { class: 'vm-onboarding-step' },
        h('h2', null, msg('onboardingPasswordHeading')),
        h('p', { class: 'vm-notice vm-notice--ok' }, msg('onboardingPasswordDone')),
        h('p', { class: 'vm-small vm-muted' }, msg('onboardingPasswordExists')),
      );
    }

    return h(
      'div',
      { class: 'vm-onboarding-step' },
      h('h2', null, msg('onboardingPasswordHeading')),
      createVaultForm({
        introKey: 'onboardingPasswordBody',
        create: async (password) => {
          const response = await send({ type: 'CREATE_VAULT', password });
          return response.type === 'ERROR' ? response.code : null;
        },
        onCreated: () => {
          void (async () => {
            progress.vaultExists = true;
            say(msg('onboardingPasswordDone'));
            // Straight on rather than waiting for a second click. The vault exists, the gate is
            // open, and a wizard that makes you press Next after the thing you came for already
            // happened is one that looks broken.
            await goTo(next(progress));
          })();
        },
      }),
    );
  }

  /* ---------------------------------------------------------------- 3. incognito */

  function incognitoStep(): HTMLElement {
    const allowed = progress.incognitoAllowed;
    const result = h('p', {
      class: `vm-notice${allowed ? ' vm-notice--ok' : ' vm-notice--warning'}`,
      role: 'status',
    });
    result.textContent = msg(allowed ? 'incognitoNowOn' : 'incognitoStillOff');

    const recheck = h(
      'button',
      {
        type: 'button',
        class: 'vm-button',
        onclick: () => {
          void (async () => {
            const rechecked = await send({ type: 'INCOGNITO_ACCESS', recheck: true });
            if (rechecked.type === 'ERROR') {
              say(errorText(rechecked.code), 'danger');
              return;
            }
            progress.incognitoAllowed = rechecked.allowed;
            paint();
          })();
        },
      },
      msg('incognitoRecheck'),
    );

    const skip = h(
      'button',
      {
        type: 'button',
        class: 'vm-button vm-button--quiet',
        onclick: () => {
          void (async () => {
            progress.incognitoSkipped = true;
            await send({ type: 'SET_ONBOARDING', patch: { incognitoSkipped: true } });
            say(msg('onboardingIncognitoSkipped'));
            await goTo(next(progress));
          })();
        },
      },
      msg('onboardingIncognitoSkip'),
    );

    return h(
      'div',
      { class: 'vm-onboarding-step' },
      h('h2', null, msg('incognitoHeading')),
      h('p', null, msg('incognitoWhy')),
      // The same three steps as the guided prompt, from the same function: two screens asking for
      // the same thing in two sets of words is how one of them ends up out of date.
      incognitoSteps(() => {
        void chrome.tabs.create({ url: settingsUrl });
      }),
      result,
      h('div', { class: 'vm-onboarding-actions' }, recheck, allowed ? null : skip),
      // Only worth saying while it is still off — after that the nudge is not coming.
      allowed ? null : h('p', { class: 'vm-small vm-muted' }, msg('onboardingIncognitoSkipHint')),
    );
  }

  /* ---------------------------------------------------------------- 4. the sync tier */

  /**
   * The two tiers, side by side.
   *
   * A table rather than two paragraphs because the decision is a comparison: capacity against
   * thumbnails against setup effort. Drive is present rather than hidden, so nobody picks Chrome
   * sync believing it is the only option and then finds their vault capped at a thousand bookmarks
   * (PLAN §9 Phase 9 asks for exactly this). Since Phase 10 it is something they can switch on the
   * same day — the badge says "Optional", not "coming later" — and the way to it is Settings → Sync,
   * which is what the two lines under the table say.
   */
  function syncStep(): HTMLElement {
    const cell = (key: string): HTMLElement => h('td', null, msg(key));
    return h(
      'div',
      { class: 'vm-onboarding-step' },
      h('h2', null, msg('onboardingSyncHeading')),
      h('p', null, msg('onboardingSyncBody')),
      h(
        'table',
        { class: 'vm-compare' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('td', null),
            h(
              'th',
              { scope: 'col' },
              msg('onboardingSyncChrome'),
              ' ',
              h('span', { class: 'vm-badge' }, msg('onboardingSyncDefault')),
            ),
            h(
              'th',
              { scope: 'col' },
              msg('onboardingSyncDrive'),
              ' ',
              h('span', { class: 'vm-badge' }, msg('onboardingSyncLater')),
            ),
          ),
        ),
        h(
          'tbody',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'row' }, msg('onboardingSyncRowSetup')),
            cell('onboardingSyncChromeSetup'),
            cell('onboardingSyncDriveSetup'),
          ),
          h(
            'tr',
            null,
            h('th', { scope: 'row' }, msg('onboardingSyncRowCapacity')),
            cell('onboardingSyncChromeCapacity'),
            cell('onboardingSyncDriveCapacity'),
          ),
          h(
            'tr',
            null,
            h('th', { scope: 'row' }, msg('onboardingSyncRowThumbs')),
            cell('onboardingSyncChromeThumbs'),
            cell('onboardingSyncDriveThumbs'),
          ),
          h(
            'tr',
            null,
            h('th', { scope: 'row' }, msg('onboardingSyncRowWhere')),
            cell('onboardingSyncChromeWhere'),
            cell('onboardingSyncDriveWhere'),
          ),
        ),
      ),
      h('p', { class: 'vm-notice' }, msg('onboardingSyncActive')),
      h('p', { class: 'vm-small vm-muted' }, msg('onboardingSyncChangeLater')),
    );
  }

  /* ---------------------------------------------------------------- 5. what Chrome still does */

  /**
   * The leak a vault cannot close on its own: history.
   *
   * A page visited before it was vaulted is still in `chrome.history` autocompleting itself, and
   * clearing it needs an optional permission we ask for here, in context, with the count in front of
   * the user before anything is deleted.
   *
   * This step used to carry a second card about Chrome's "Autocomplete searches and URLs" setting —
   * an address to copy and an instruction to turn it off. It is gone (maintainer-reported, and
   * ARCHITECTURE §12.4 records the removal): a setup flow that ends by handing someone homework in a
   * settings page we cannot open, verify or undo is a step nobody can complete here, and it was the
   * one card in the flow that had no control on it at all.
   */
  function chromeStep(): HTMLElement {
    return h(
      'div',
      { class: 'vm-onboarding-step' },
      h('h2', null, msg('onboardingChromeHeading')),
      h('p', null, msg('onboardingChromeBody')),
      h(
        'section',
        { class: 'vm-onboarding-card' },
        h('h3', null, msg('onboardingHistoryHeading')),
        h('p', null, msg('onboardingHistoryBody')),
        historyOffer(),
      ),
    );
  }

  /**
   * "Clean history for the domains in my vault", from inside the flow.
   *
   * Deliberately an offer and not a step gate: it needs a permission and a vault with bookmarks in
   * it, and a fresh install has neither. Someone finishing setup with an empty vault has nothing to
   * clean, and the same panel is in Settings → Privacy for the day they do — which is the reason it
   * is one shared widget rather than two.
   */
  function historyOffer(): HTMLElement {
    const slot = h('div', { class: 'vm-onboarding-offer' });
    void (async () => {
      render(slot, historyCleanupPanel({ ...historyDeps(say), granted: await hasHistoryPermission() }));
    })();
    return slot;
  }
}
