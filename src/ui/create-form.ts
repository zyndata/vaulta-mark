/**
 * The one form that creates a vault.
 *
 * There are two places a vault can be created — the popup, and step 2 of onboarding — and there must
 * be exactly one no-recovery acknowledgement, one strength meter and one weak-password question
 * between them. A create screen that asks for a typed sentence in one window and shows a checkbox in
 * the other is two products, the same reasoning that moved `confirmDialog` into `ui/` in Phase 8.
 *
 * The typed phrase rather than a checkbox is the whole point of this file. There is no password
 * recovery and no key escrow (D12): someone who did not understand that before they clicked has lost
 * their vault and will find out weeks later. A checkbox is a reflex; typing a sentence is a decision.
 *
 * `create` is injected rather than sent from here so the form can be driven without a service
 * worker, which is also what lets the gate be tested rather than reasoned about.
 */

import { MIN_PASSWORD_LENGTH, estimateStrength, passwordLength } from '../crypto/password.js';
import type { ErrorCode } from '../shared/messages.js';
import { h, matchesPhrase, msg, render } from './dom.js';
import { WARNING_KEYS, errorText } from './strings.js';

export interface CreateFormOptions {
  /** Create the vault. Resolves to an error code, or `null` when it worked. */
  readonly create: (password: string) => Promise<ErrorCode | null>;
  /** Called once the vault exists. The caller decides what the screen becomes next. */
  readonly onCreated: () => void;
  /**
   * This profile already has a synced vault to join, and the user asked for a second one anyway.
   *
   * It changes nothing mechanically and everything about what the screen means: the same form is
   * either "set up VaultaMark" or "deliberately keep a separate vault on this computer", and the
   * second needs saying out loud because it cannot sync with the first.
   */
  readonly separate?: boolean;
  readonly onBack?: () => void;
  /** The paragraph above the fields. Defaults to `createIntro`. */
  readonly introKey?: string;
}

export function createVaultForm(options: CreateFormOptions): HTMLFormElement {
  const password = h('input', { type: 'password', autocomplete: 'new-password' });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password' });
  const phrase = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false' });

  const meter = h(
    'div',
    { class: 'vm-meter', 'data-score': '0', 'aria-hidden': 'true' },
    ...Array.from({ length: 5 }, () => h('span')),
  );
  const strength = h('p', { class: 'vm-small vm-muted', role: 'status' });
  const warnings = h('ul', { class: 'vm-warnings vm-small vm-muted' });
  const mismatch = h('p', { class: 'vm-small vm-danger', hidden: true });
  const weak = h('p', { class: 'vm-notice vm-notice--warning', hidden: true });
  const error = h('p', { class: 'vm-notice vm-notice--danger', role: 'alert', hidden: true });
  const submit = h('button', { class: 'vm-button', type: 'submit', disabled: true });
  // A disabled button that will not say why is a dead end: three separate conditions gate it, and
  // the one that is unmet is not always the one the user is looking at.
  const blocked = h('p', { class: 'vm-blocked vm-small vm-muted', role: 'status', hidden: true });

  /** Set once the user has seen the weak-password warning and chosen to go ahead anyway. */
  let weakAcknowledged = false;
  let acceptable = false;
  /** Guards against a slower earlier `estimateStrength` landing on top of a later result. */
  let latest = 0;

  /**
   * The first requirement the form is still waiting on, or `null` when it is ready.
   *
   * Ordered the way the fields are: naming the phrase while the password is too short would send
   * someone to fix the thing they already got right.
   */
  function unmetRequirement(): string | null {
    if (passwordLength(password.value) < MIN_PASSWORD_LENGTH) {
      return msg('createNeedsLength', [String(MIN_PASSWORD_LENGTH)]);
    }
    if (password.value !== confirm.value) return msg('createNeedsMatch');
    if (!matchesPhrase(phrase.value, msg('createConfirmPhrase'))) {
      return msg('createNeedsPhrase', [msg('createConfirmPhrase')]);
    }
    return null;
  }

  function refreshSubmit(): void {
    const matches = password.value.length > 0 && password.value === confirm.value;
    show(mismatch, confirm.value.length > 0 && !matches ? msg('createPasswordsDiffer') : null);

    const unmet = unmetRequirement();
    submit.disabled = unmet !== null;
    // Nothing to say before the user has typed anything: the form is not "blocked" yet, it is empty.
    show(blocked, password.value.length > 0 ? unmet : null);
    submit.textContent = msg(weakAcknowledged ? 'createButtonAnyway' : 'createButton');
  }

  async function refreshStrength(): Promise<void> {
    const token = ++latest;
    const typed = password.value;
    if (typed.length === 0) {
      meter.setAttribute('data-score', '0');
      strength.textContent = '';
      render(warnings);
      acceptable = false;
      return;
    }
    const estimate = await estimateStrength(typed);
    if (token !== latest) return;
    meter.setAttribute('data-score', String(estimate.score));
    strength.textContent = msg('createStrength', [msg(`strength${String(estimate.score)}`)]);
    render(warnings, ...estimate.warnings.map((code) => h('li', null, msg(WARNING_KEYS[code]))));
    acceptable = estimate.acceptable;
    // A password that has just become strong should not still sit behind an "are you sure".
    if (acceptable) {
      weakAcknowledged = false;
      weak.hidden = true;
    }
    refreshSubmit();
  }

  async function submitCreate(): Promise<void> {
    if (submit.disabled) return;
    // Below "good" the flow asks a second time; it never refuses. Nobody is blocked from their own
    // choice — we make sure it was one (ARCHITECTURE §4.6).
    if (!acceptable && !weakAcknowledged) {
      weakAcknowledged = true;
      show(weak, msg('createWeakConfirm'));
      refreshSubmit();
      return;
    }
    submit.disabled = true;
    show(error, null);
    const failure = await options.create(password.value);
    if (failure !== null) {
      show(error, errorText(failure));
      refreshSubmit();
      return;
    }
    password.value = '';
    confirm.value = '';
    options.onCreated();
  }

  password.addEventListener('input', () => {
    void refreshStrength();
    refreshSubmit();
  });
  confirm.addEventListener('input', refreshSubmit);
  phrase.addEventListener('input', refreshSubmit);

  refreshSubmit();

  return h(
    'form',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        void submitCreate();
      },
    },
    options.separate === true
      ? h(
          'div',
          { class: 'vm-notice vm-notice--warning' },
          h('p', null, h('strong', null, msg('adoptSeparateHeading'))),
          h('p', null, msg('adoptSeparateBody')),
          options.onBack === undefined
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  class: 'vm-button vm-button--quiet vm-button--inline',
                  onclick: options.onBack,
                },
                msg('adoptSeparateBack'),
              ),
        )
      : h('p', { class: 'vm-small vm-muted' }, msg(options.introKey ?? 'createIntro')),
    field('createFieldPassword', password),
    meter,
    strength,
    warnings,
    field('createFieldConfirm', confirm),
    mismatch,
    h(
      'div',
      { class: 'vm-notice vm-notice--warning' },
      h('p', null, h('strong', null, msg('createNoRecoveryHeading'))),
      h('p', null, msg('createNoRecoveryBody')),
    ),
    field('createFieldPhrase', phrase),
    h('p', { class: 'vm-small vm-muted' }, msg('createPhraseHint', [msg('createConfirmPhrase')])),
    weak,
    error,
    submit,
    blocked,
  );
}

function field(labelKey: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'vm-field' }, h('span', null, msg(labelKey)), input);
}

function show(box: HTMLElement, text: string | null): void {
  box.textContent = text ?? '';
  box.hidden = text === null;
}
