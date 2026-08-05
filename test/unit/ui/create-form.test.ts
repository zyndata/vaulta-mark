/**
 * @vitest-environment jsdom
 *
 * The one form that creates a vault (`src/ui/create-form.ts`).
 *
 * It lives in `ui/` from Phase 9 because onboarding creates a vault too, and the no-recovery
 * acknowledgement has to be the same question in the popup and in the first-run flow. That makes
 * this the file that carries PLAN §9's Definition-of-done item: **the acknowledgement cannot be
 * skipped**. Nothing else stands between a user and a vault whose password nobody can recover.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MIN_PASSWORD_LENGTH } from '../../../src/crypto/password.js';
import type { ErrorCode } from '../../../src/shared/messages.js';
import { createVaultForm } from '../../../src/ui/create-form.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

/** `chrome.i18n.getMessage` in the mock answers with the key, so this is the expected phrase. */
const PHRASE = 'createConfirmPhrase';

const STRONG = 'correct horse battery staple thirty three';

function build(over: Partial<Parameters<typeof createVaultForm>[0]> = {}): {
  form: HTMLFormElement;
  create: ReturnType<typeof vi.fn>;
  onCreated: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(() => Promise.resolve(null));
  const onCreated = vi.fn();
  const form = createVaultForm({ create, onCreated, ...over });
  document.body.append(form);
  return { form, create, onCreated };
}

function fields(form: HTMLFormElement): {
  password: HTMLInputElement;
  confirm: HTMLInputElement;
  phrase: HTMLInputElement;
  submit: HTMLButtonElement;
} {
  const inputs = [...form.querySelectorAll('input')];
  const [password, confirm, phrase] = inputs as [
    HTMLInputElement,
    HTMLInputElement,
    HTMLInputElement,
  ];
  return {
    password,
    confirm,
    phrase,
    submit: form.querySelector<HTMLButtonElement>('button[type="submit"]')!,
  };
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

/**
 * Let the form's asynchronous work land.
 *
 * A macrotask, not a run of microtasks: `estimateStrength` hashes with WebCrypto, and a promise
 * chain that crosses a real async boundary is not flushed by awaiting `Promise.resolve()` however
 * many times you do it. Getting this wrong makes the strength estimate arrive *after* the assertion
 * — which passes the weak-password test for the wrong reason and leaves an unhandled rejection in
 * the next test's teardown.
 */
async function settle(): Promise<void> {
  for (let at = 0; at < 3; at++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Fill everything in correctly. `estimateStrength` is async, so this settles afterwards. */
async function fillValid(form: HTMLFormElement): Promise<void> {
  const { password, confirm, phrase } = fields(form);
  type(password, STRONG);
  type(confirm, STRONG);
  type(phrase, PHRASE);
  await settle();
}

beforeEach(() => {
  installChromeMock();
  document.body.replaceChildren();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('the no-recovery acknowledgement', () => {
  it('keeps the button disabled until the phrase is typed', async () => {
    const { form, create } = build();
    const { password, confirm, phrase, submit } = fields(form);

    type(password, STRONG);
    type(confirm, STRONG);
    await settle();
    expect(submit.disabled).toBe(true);

    type(phrase, PHRASE);
    await settle();
    expect(submit.disabled).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a submit that got past the button somehow', async () => {
    const { form, create } = build();
    const { password, confirm } = fields(form);
    type(password, STRONG);
    type(confirm, STRONG);
    await settle();

    // A form can be submitted with Enter, and `disabled` on the button is a hint rather than a
    // guarantee — the handler checks for itself.
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(create).not.toHaveBeenCalled();
  });

  it('is forgiving about case and spacing, and nothing else', async () => {
    const { form } = build();
    const { password, confirm, phrase, submit } = fields(form);
    type(password, STRONG);
    type(confirm, STRONG);

    type(phrase, `  ${PHRASE.toUpperCase()}  `);
    await settle();
    expect(submit.disabled).toBe(false);

    type(phrase, 'something else entirely');
    await settle();
    expect(submit.disabled).toBe(true);
  });

  it('says which requirement is in the way, rather than sitting there dead', async () => {
    const { form } = build();
    const { password } = fields(form);
    type(password, 'x');
    await settle();

    const blocked = form.querySelector<HTMLElement>('.vm-blocked')!;
    expect(blocked.hidden).toBe(false);
    expect(blocked.textContent).toBe('createNeedsLength');
  });
});

describe('the other two gates', () => {
  it('refuses a password below the floor', async () => {
    const { form } = build();
    const { password, confirm, phrase, submit } = fields(form);
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
    type(password, short);
    type(confirm, short);
    type(phrase, PHRASE);
    await settle();
    expect(submit.disabled).toBe(true);
  });

  it('refuses a mismatched confirmation, and says so', async () => {
    const { form } = build();
    const { password, confirm, phrase, submit } = fields(form);
    type(password, STRONG);
    type(confirm, `${STRONG}!`);
    type(phrase, PHRASE);
    await settle();

    expect(submit.disabled).toBe(true);
    expect(form.querySelector('.vm-danger')?.textContent).toBe('createPasswordsDiffer');
  });
});

describe('a weak password', () => {
  it('is asked about once and then allowed — never refused', async () => {
    const { form, create } = build();
    const { password, confirm, phrase, submit } = fields(form);
    type(password, 'password123');
    type(confirm, 'password123');
    type(phrase, PHRASE);
    await settle();

    submit.click();
    await settle();
    // First press is the question, not the create.
    expect(create).not.toHaveBeenCalled();
    expect(submit.textContent).toBe('createButtonAnyway');

    submit.click();
    await settle();
    expect(create).toHaveBeenCalledWith('password123');
  });
});

describe('creating', () => {
  it('hands the password over exactly once and reports success upwards', async () => {
    const { form, create, onCreated } = build();
    await fillValid(form);
    fields(form).submit.click();
    await settle();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(STRONG);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('clears the password fields once the vault exists', async () => {
    const { form } = build();
    await fillValid(form);
    fields(form).submit.click();
    await settle();

    expect(fields(form).password.value).toBe('');
    expect(fields(form).confirm.value).toBe('');
  });

  it('shows a failure and leaves the form usable', async () => {
    const { form, onCreated } = build({
      create: vi.fn((): Promise<ErrorCode | null> => Promise.resolve('VAULT_STATE')),
    });
    await fillValid(form);
    fields(form).submit.click();
    await settle();

    expect(form.querySelector('[role="alert"]')?.textContent).toBe('errorVaultState');
    expect(onCreated).not.toHaveBeenCalled();
    expect(fields(form).submit.disabled).toBe(false);
  });
});

describe('the second-vault warning', () => {
  it('is absent by default and present when asked for', () => {
    expect(build().form.textContent).toContain('createIntro');

    document.body.replaceChildren();
    const { form } = build({ separate: true });
    expect(form.textContent).toContain('adoptSeparateHeading');
    expect(form.textContent).not.toContain('createIntro');
  });

  it('offers a way back only when there is one', () => {
    const onBack = vi.fn();
    const { form } = build({ separate: true, onBack });
    const button = [...form.querySelectorAll('button')].find(
      (b) => b.textContent === 'adoptSeparateBack',
    );
    button?.click();
    expect(onBack).toHaveBeenCalled();
  });

  it('takes a caller-chosen introduction, which is how onboarding words its step', () => {
    const { form } = build({ introKey: 'onboardingPasswordBody' });
    expect(form.textContent).toContain('onboardingPasswordBody');
  });
});
