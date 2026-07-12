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

/**
 * Assert the page has no WCAG A/AA violations.
 *
 * `context` names the *state* being scanned (e.g. "after entering"), because a
 * bare "expected [] to equal [...]" from a shared helper tells you nothing about
 * which of a spec's six states broke.
 */
export async function expectAxeClean(page: Page, context: string) {
  await expectAxeCleanExcept(page, context, [])
}

/**
 * One (rule, node) pair a scan is allowed to keep reporting — a **pre-existing**
 * WCAG failure in code the change under test does not own.
 *
 * This is debt, spelled out, not an exception granted: the pair is exempted
 * node-by-node, so the scan still fails on any violation that is not on the list
 * — including a *new* node of an already-listed rule. Delete an entry when the
 * bug is fixed. Never add one to turn a red run green: a violation your change
 * introduced is a bug in your change.
 */
export interface KnownAxeViolation {
  /** The axe rule id, e.g. `color-contrast`. */
  rule: string
  /** The selector axe reports for the offending node. */
  node: string
  /** Where the bug lives, and why it isn't being fixed right here. */
  owner: string
}

/**
 * Assert the page has no WCAG A/AA violations **other than** the known,
 * enumerated ones.
 *
 * Prefer `expectAxeClean` (an empty list). Reach for this only when a state you
 * are newly covering sits inside chrome that was already failing — the honest
 * alternatives being to leave the state uncovered (which is how the bugs got
 * there) or to fix unrelated production code inside an unrelated change.
 */
export async function expectAxeCleanExcept(
  page: Page,
  context: string,
  known: KnownAxeViolation[],
) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(WCAG_A_AA)
    .analyze()

  const exempt = new Set(known.map((k) => `${k.rule} @ ${k.node}`))

  // Flatten to (rule, node) pairs rather than filtering whole violations: a rule
  // already failing on one node must still fail loudly on a *second*, new one.
  //
  // The projection is readable on purpose — a failure names the rule, its impact
  // and the offending selector inline, instead of dumping axe's whole node graph
  // or, worse, just a number.
  const found = violations.flatMap((v) =>
    v.nodes.map((n) => ({
      rule: v.id,
      impact: v.impact,
      help: v.help,
      node: n.target.join(' '),
    })),
  )

  const unexpected = found.filter((v) => !exempt.has(`${v.rule} @ ${v.node}`))

  expect(unexpected, `axe violations — ${context}`).toEqual([])
}
