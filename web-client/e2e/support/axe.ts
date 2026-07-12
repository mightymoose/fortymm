import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

/**
 * The accessibility gate for the web-client Playwright suite.
 *
 * DEFINITION_OF_COMPLETE asks for "axe-clean in every UI state (checked in
 * web-client/e2e)". This is the first spec in the suite to do it, so the helper
 * lives here rather than in one spec file — the next page to be brought up to
 * standard should import it, not reinvent it.
 *
 * It runs against the **live page**, so it sees the real cascade and the real
 * stacking order. That is the whole point: jsdom (vitest) has no layout and no
 * paint, so colour-contrast, hidden-focusable and overlap rules are
 * unrepresentable there.
 */

/** WCAG 2.0/2.1 level A + AA. Deliberately NOT `best-practice`: that tag folds
 * in stylistic advice (heading-order, landmark-one-main) that would fail the app
 * shell for reasons unrelated to the feature under test, and a gate nobody can
 * pass gets deleted. Conformance rules only. */
const WCAG_A_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

export interface AxeOptions {
  /**
   * Selectors to leave out of the scan — for a **pre-existing** violation in shared
   * markup that the state under test merely happens to render, and that the change
   * under test neither caused nor can honestly fix (a design-system token, say).
   *
   * Use it sparingly and *name the defect at the call site*. The alternative is
   * worse in both directions: deleting the scan loses the coverage of everything
   * else on the page, and folding an unrelated fix into an unrelated PR hides it.
   */
  exclude?: string[]
}

/**
 * Assert the page has no WCAG A/AA violations.
 *
 * `context` names the *state* being scanned (e.g. "after entering"), because a
 * bare "expected [] to equal [...]" from a shared helper tells you nothing about
 * which of a spec's six states broke.
 */
export async function expectAxeClean(
  page: Page,
  context: string,
  options: AxeOptions = {},
) {
  let builder = new AxeBuilder({ page }).withTags(WCAG_A_AA)
  for (const selector of options.exclude ?? []) {
    builder = builder.exclude(selector)
  }
  const { violations } = await builder.analyze()

  // Compare on a readable projection rather than `violations.length === 0`: a
  // failure then names the rule, its impact, and the offending selector inline,
  // instead of dumping axe's whole node graph or, worse, just a number.
  const summary = violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')),
  }))

  expect(summary, `axe violations — ${context}`).toEqual([])
}
