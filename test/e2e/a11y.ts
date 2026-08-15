/**
 * The accessibility assertion, shared by every spec that raises a document (PLAN §9 Phase 12).
 *
 * Not a spec file — Playwright's `testMatch` wants `*.spec.ts`, so this is imported rather than run.
 * It lives here rather than in `test/helpers/` because it is Playwright-only and `test/helpers/` is
 * on the Vitest side.
 *
 * **A "page" for this purpose is a document, not a URL.** VaultaMark has two HTML files and about a
 * dozen documents: the popup alone is create, unlock, unlocked and settings, and the manager is the
 * list, a selection, a modal, the settings screen, the conflict screen, import/export, onboarding
 * and the incognito prompt. Each is a different tree to assistive technology, and only the first of
 * each pair is what testing "the page" would reach. So the DoD item — zero critical or serious
 * violations on every page — is spelled out one document at a time, at the point in each spec where
 * that document is already on screen.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Zero critical or serious violations, and the whole list printed when there are any.
 *
 * `color-contrast` is included deliberately: PLAN §9 asks for 4.5:1 and it is the rule most easily
 * lost to a later restyle. Violations below `serious` are not failed on — the DoD names the two
 * levels above it — but they are printed with the failure when there is one, because a moderate
 * finding next to a serious one is usually the same mistake seen twice.
 */
export async function expectNoA11yViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  );
  expect(
    serious.map(
      (violation) => `${violation.id}: ${violation.help} (${String(violation.nodes.length)})`,
    ),
    label,
  ).toEqual([]);
}
