/**
 * The Administration area's **solve ledger** (`/admin/schedule-solves`, ADR
 * "the schedule is solved; the call is pinned": the admin page reads the
 * `schedule_solves` run ledger verbatim) — through the real browser, MSW OFF.
 *
 * What only this suite proves, and why vitest could not:
 *
 *   1. **The admin read crosses the real wire.** `input_fingerprint`,
 *      `rerun_requested`, `tournament_id`/`tournament_name` — the client
 *      Zod-parses all of them inside the queryFn, so a stub that dropped one
 *      fails the PAGE here (vitest reads the same generated factories the app
 *      was built against, which is circular).
 *
 *   2. **The URL-state contract survives a real reload.** `?page=` /
 *      `?tournament=` are the source of truth; a reload must land on the same
 *      page of the same filter — memory routers can't prove a browser reload.
 *
 *   3. **The 403 is a designed page, not a broken one.** The server-side
 *      `scheduling.view` gate answers the page's one query with a 403 and the
 *      admin boundary renders access-denied — with the app shell alive around
 *      it, and the raw FastAPI detail nowhere on screen.
 *
 *   4. **axe-clean in every UI state** (DEFINITION_OF_COMPLETE): the table,
 *      an expanded failure row, the empty ledger, and the forbidden state.
 */
import { expect, test } from '@playwright/test'

import { PERM } from '../src/lib/permissions'
import {
  SolveLedgerPage,
  buildAdminScheduleSolveRead,
} from './page-objects/admin/solve-ledger.page'
import { expectAxeCleanExcept, type KnownAxeViolation } from './support/axe'

/** Pre-existing WCAG debt in the shared admin chrome this page merely renders
 * inside: the `AdminBreadcrumbAndCounts` "Administration" eyebrow is
 * 12px `var(--fg-muted)` on `var(--bg-app)` — under the AA contrast ratio on
 * every `/admin/*` page (none of which had axe coverage before this spec).
 * Owned by `src/components/rbac/admin-layout.tsx`; fixing shared chrome inside
 * this change would hide the fix (support/axe.ts's own guidance). Delete this
 * entry when the eyebrow's contrast is fixed. */
const ADMIN_CHROME_DEBT: KnownAxeViolation[] = [
  {
    rule: 'color-contrast',
    node: 'main > div > div:nth-child(1) > div:nth-child(1) > span:nth-child(1)',
    owner:
      'rbac/admin-layout.tsx — AdminBreadcrumbAndCounts eyebrow (fg-muted on bg-app), pre-existing on every admin page',
  },
]

test.describe('Admin · solve ledger', () => {
  test('renders the ledger — designed chips, tournament links, wall time, apply counts, the re-run flag — and expands a failure', async ({
    page,
  }) => {
    const pom = await SolveLedgerPage.navigateTo(page)

    // Page 1 truncates at 25 of 26 — the footer says so.
    await expect(pom.readout).toContainText('Showing 1–25 of 26 runs')

    // The failed row: designed chip, and the expansion with the server's error
    // sentence + the drift guard's fingerprint in monospace.
    await expect(pom.row('solve-1')).toContainText('Failed')
    await pom.detailsToggle('solve-1').click()
    await expect(pom.detail('solve-1')).toContainText('The scheduler hit a problem')
    await expect(pom.detail('solve-1')).toContainText(
      'worker crashed: out of memory in CP-SAT presolve',
    )
    await expect(pom.detail('solve-1')).toContainText('deadbeef'.repeat(8))

    // The coalescer's flag on the running row.
    await expect(pom.row('solve-2')).toContainText('Solving')
    await expect(pom.row('solve-2')).toContainText('Re-run queued')

    // A succeeded row speaks the strip's vocabulary, never the wire's.
    await expect(pom.row('solve-3')).toContainText('Best possible plan')
    await expect(pom.row('solve-3')).not.toContainText('optimal')
    // The tournament cell links to the detail page.
    await expect(
      pom.row('solve-3').getByRole('link', { name: 'Bay Area Open 2026' }),
    ).toHaveAttribute('href', '/tournaments/bay-area-open-2026')

    await expectAxeCleanExcept(page, 'solve ledger — table with an expanded failure row', ADMIN_CHROME_DEBT)
  })

  test('pages via the URL, and the page param round-trips a real reload', async ({
    page,
  }) => {
    const pom = await SolveLedgerPage.navigateTo(page)
    await expect(pom.readout).toContainText('Showing 1–25 of 26 runs')

    await pom.nextPage.click()
    await expect(page).toHaveURL(/\?page=2$/)
    await expect(pom.readout).toContainText('Showing 26–26 of 26 runs')
    await expect(pom.row('solve-26')).toBeVisible()

    // The URL-state contract: a reload of the shared link lands on page 2.
    await page.reload()
    await expect(page).toHaveURL(/\?page=2$/)
    await expect(pom.readout).toContainText('Showing 26–26 of 26 runs')
    await expect(pom.row('solve-26')).toBeVisible()
  })

  test("filters to one tournament from a row's funnel, round-trips the filter through a reload, and clears from the chip", async ({
    page,
  }) => {
    const pom = await SolveLedgerPage.navigateTo(page)

    await pom
      .row('solve-2')
      .getByRole('button', { name: 'Show only Summer Slam 2026 runs' })
      .click()
    await expect(page).toHaveURL(/\?tournament=summer-slam-2026$/)
    await expect(pom.readout).toContainText('of 13 runs')
    await expect(pom.filterChip).toContainText('Tournament: Summer Slam 2026')

    await page.reload()
    await expect(pom.filterChip).toContainText('Tournament: Summer Slam 2026')
    await expect(pom.readout).toContainText('of 13 runs')

    await page.getByRole('button', { name: 'Clear tournament filter' }).click()
    await expect(page).not.toHaveURL(/tournament=/)
    await expect(pom.readout).toContainText('of 26 runs')
  })

  test('renders the designed empty state — and inflects a single run correctly (#1028)', async ({
    page,
  }) => {
    const pom = await SolveLedgerPage.navigateTo(page, { rows: [] })
    await expect(pom.emptyState).toBeVisible()
    await expect(pom.readout).toContainText('Showing 0–0 of 0 runs')
    await expectAxeCleanExcept(page, 'solve ledger — empty', ADMIN_CHROME_DEBT)

    const one = await SolveLedgerPage.navigateTo(page, {
      rows: [buildAdminScheduleSolveRead({ id: 'solo' })],
    })
    await expect(one.readout).toContainText('of 1 run')
    await expect(one.readout).not.toContainText('of 1 runs')
  })

  test('renders the designed forbidden state on the server-side permission gate — raw detail never shown', async ({
    page,
  }) => {
    const pom = await SolveLedgerPage.navigateTo(page, {
      // ADMIN_VIEW alone: the operator can open the Administration area, but
      // the server refuses the ledger — exactly the split grant the endpoint
      // was designed for.
      permissions: [PERM.ADMIN_VIEW],
      forbidden: true,
    })

    await expect(pom.accessDenied).toBeVisible()
    await expect(
      page.getByText('Ask an administrator to grant you access to this page.'),
    ).toBeVisible()
    await expect(page.getByText('Missing permission')).not.toBeVisible()
    // The shell survives: the operator can navigate away.
    await expect(
      page.getByRole('complementary', { name: 'Main navigation' }),
    ).toBeVisible()
    // And the nav never offered the page (hidden, not disabled).
    await expect(
      page.locator('.app-shell__sidebar').getByRole('link', { name: 'Scheduling' }),
    ).not.toBeVisible()

    await expectAxeCleanExcept(page, 'solve ledger — forbidden', ADMIN_CHROME_DEBT)
  })
})
