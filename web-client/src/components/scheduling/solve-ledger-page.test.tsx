import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@/test/utilities'

import { infeasibilityReasonCopy } from '@/components/tournaments/data/solve'

import {
  buildAdminScheduleSolveRead,
  buildLedgerRows,
  buildLedgerVariety,
  buildPlayerConflictRead,
  buildTableConflictRead,
} from './solve-ledger-page.factory'
import { solveLedgerPage } from './solve-ledger-page.page'

// The exact copy the two surfaces share — reused (not re-hardcoded) so the test
// pins the admin ledger to the ONE `infeasibilityReasonCopy`, exactly as the
// factory's `sv-infeasible` row carries these two reasons.
const windowReasonCopy = infeasibilityReasonCopy({
  kind: 'window_too_short_for_match',
  poolName: 'Pool A',
  windowStart: '09:00',
  windowEnd: '10:00',
  bestOf: 5,
  neededMin: 75,
  windowSpanMin: 60,
})
const noSingleCauseCopy = infeasibilityReasonCopy({
  kind: 'no_single_cause',
  requiredMin: 420,
  availableMin: 480,
})

describe('SolveLedgerPage', () => {
  it('renders a ledger row per run with every column in the designed vocabulary', async () => {
    solveLedgerPage.render(buildLedgerVariety())

    // The succeeded row: when, tournament link, trigger copy, chip + verdict,
    // wall time, apply counts.
    const succeeded = await solveLedgerPage.findRow('sv-succeeded')
    expect(within(succeeded).getByRole('link', { name: 'Bay Area Open 2026' }))
      .toHaveAttribute('href', '/tournaments/bay-area-open-2026')
    expect(within(succeeded).getByText('Run by hand')).toBeInTheDocument()
    expect(within(succeeded).getByText('Solved')).toBeInTheDocument()
    expect(within(succeeded).getByText('Best possible plan')).toBeInTheDocument()
    expect(within(succeeded).getByText('850 ms')).toBeInTheDocument()
    expect(within(succeeded).getByText('9 placed · 2 pinned')).toBeInTheDocument()

    // Each remaining status renders its own designed chip.
    expect(
      within(await solveLedgerPage.findRow('sv-queued')).getByText('Queued'),
    ).toBeInTheDocument()
    expect(
      within(await solveLedgerPage.findRow('sv-running')).getByText('Solving'),
    ).toBeInTheDocument()
    expect(
      within(await solveLedgerPage.findRow('sv-failed')).getByText('Failed'),
    ).toBeInTheDocument()
    expect(
      within(await solveLedgerPage.findRow('sv-infeasible')).getByText(
        "Doesn't fit",
      ),
    ).toBeInTheDocument()

    // The coalescer's flag, only where a re-run is actually queued.
    expect(screen.getByTestId('solve-rerun-sv-running')).toHaveTextContent(
      'Re-run queued',
    )
    expect(screen.queryByTestId('solve-rerun-sv-succeeded')).not.toBeInTheDocument()

    // Raw wire enums never reach the UI (DEFINITION_OF_COMPLETE).
    for (const raw of [
      /\bsucceeded\b/,
      /\binfeasible\b/,
      /\bmanual\b/,
      /\bmatch_completed\b/,
      /\bpin_tick\b/,
      /\boptimal\b/,
    ]) {
      expect(screen.queryByText(raw)).not.toBeInTheDocument()
    }
  })

  it('expands a failed row into the failure detail — error sentence and fingerprint, closed again on a second click', async () => {
    solveLedgerPage.render(buildLedgerVariety())
    const user = solveLedgerPage.user()

    const failed = await solveLedgerPage.findRow('sv-failed')
    expect(solveLedgerPage.queryDetail('sv-failed')).not.toBeInTheDocument()

    const toggle = within(failed).getByRole('button', { name: 'Show run details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)

    const detail = solveLedgerPage.queryDetail('sv-failed')
    expect(detail).not.toBeNull()
    // The client's headline, with the server's sentence as detail under it —
    // the one wire string this page carries.
    expect(detail).toHaveTextContent('The scheduler hit a problem')
    expect(detail).toHaveTextContent(
      'worker crashed: out of memory in CP-SAT presolve',
    )
    expect(detail).toHaveTextContent('deadbeef'.repeat(8))
    // A failed run carries NO infeasibility reasons — the expansion never bleeds
    // the infeasible surface's "day doesn't fit" wording into a broken run.
    expect(detail).not.toHaveTextContent(windowReasonCopy.sentence)
    expect(detail).not.toHaveTextContent(noSingleCauseCopy.sentence)
    expect(
      within(failed).getByRole('button', { name: 'Hide run details' }),
    ).toHaveAttribute('aria-expanded', 'true')

    await user.click(
      within(failed).getByRole('button', { name: 'Hide run details' }),
    )
    expect(solveLedgerPage.queryDetail('sv-failed')).not.toBeInTheDocument()
  })

  it('expands an infeasible row too — the designed headline, no error sentence — and offers no expansion on a plan', async () => {
    solveLedgerPage.render(buildLedgerVariety())
    const user = solveLedgerPage.user()

    const infeasible = await solveLedgerPage.findRow('sv-infeasible')
    await user.click(
      within(infeasible).getByRole('button', { name: 'Show run details' }),
    )
    const detail = solveLedgerPage.queryDetail('sv-infeasible')
    expect(detail).toHaveTextContent("The day doesn't fit")
    expect(detail).toHaveTextContent('Input fingerprint')

    // Both resolved reasons render their sentence AND remedy — the SAME copy the
    // Schedule-tab strip shows (reused from `infeasibilityReasonCopy`, so the two
    // surfaces cannot drift).
    expect(detail).toHaveTextContent(windowReasonCopy.sentence)
    expect(detail).toHaveTextContent(windowReasonCopy.remedy)
    expect(detail).toHaveTextContent(noSingleCauseCopy.sentence)
    expect(detail).toHaveTextContent(noSingleCauseCopy.remedy)
    // An infeasible run carries no failed `error` sentence.
    expect(detail).not.toHaveTextContent('worker crashed')

    // A succeeded (or in-flight) run has no story to expand.
    const succeeded = await solveLedgerPage.findRow('sv-succeeded')
    expect(
      within(succeeded).queryByRole('button', { name: /run details/i }),
    ).not.toBeInTheDocument()
  })

  it('keeps the headline-only expansion for an infeasible row with no resolved reasons', async () => {
    solveLedgerPage.render([
      buildAdminScheduleSolveRead({
        id: 'sv-bare',
        status: 'infeasible',
        verdict: 'infeasible',
        infeasibility_reasons: [],
      }),
    ])
    const user = solveLedgerPage.user()

    const bare = await solveLedgerPage.findRow('sv-bare')
    await user.click(
      within(bare).getByRole('button', { name: 'Show run details' }),
    )
    const detail = solveLedgerPage.queryDetail('sv-bare')
    expect(detail).toHaveTextContent("The day doesn't fit")
    expect(detail).toHaveTextContent('Input fingerprint')
    // No reason list is rendered when the (normally ≥1) list is somehow empty.
    expect(detail?.querySelector('.solve-ledger-detail-reasons')).toBeNull()
  })

  it('expands a SUCCEEDED row that carries a placement conflict — a caution, not a failure headline — naming both matches and the shared table AND human', async () => {
    solveLedgerPage.render([
      buildAdminScheduleSolveRead({
        id: 'sv-conflicts',
        status: 'succeeded',
        verdict: 'feasible',
        fixtures_placed: 9,
        fixtures_pinned: 2,
        placement_conflicts: [buildTableConflictRead(), buildPlayerConflictRead()],
      }),
    ])
    const user = solveLedgerPage.user()

    const row = await solveLedgerPage.findRow('sv-conflicts')
    // A placed board still reads "Solved" — the conflict is a caution, orthogonal.
    expect(within(row).getByText('Solved')).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: 'Show run details' }))
    const detail = solveLedgerPage.queryDetail('sv-conflicts')
    expect(detail).toHaveTextContent('Overlapping matches on the board')
    // The table conflict, named by matchup + shared table…
    expect(detail).toHaveTextContent(
      'crafty-vs-spiked and dazed-vs-confused overlap on Table 1',
    )
    // …and the player conflict, named by the shared human.
    expect(detail).toHaveTextContent(
      'crafty-vs-spiked-frigatebird and spiked-frigatebird-vs-nimble overlap on spiked-frigatebird',
    )
    // A solved board carries no failure headline — the caution never reads as a
    // broken or infeasible run.
    expect(detail).not.toHaveTextContent("The day doesn't fit")
    expect(detail).not.toHaveTextContent('The scheduler hit a problem')
    // Still the fingerprint footer, as every expansion has.
    expect(detail).toHaveTextContent('Input fingerprint')
  })

  it('offers no expansion on a clean solved board (placement_conflicts: [])', async () => {
    solveLedgerPage.render([
      buildAdminScheduleSolveRead({ id: 'sv-clean', status: 'succeeded', placement_conflicts: [] }),
    ])
    const clean = await solveLedgerPage.findRow('sv-clean')
    expect(
      within(clean).queryByRole('button', { name: /run details/i }),
    ).not.toBeInTheDocument()
  })

  it('renders the designed empty state when no solver has ever run', async () => {
    solveLedgerPage.render([])
    expect(await screen.findByText('No solver runs yet')).toBeInTheDocument()
  })

  it('pages through the ledger, writing the page into the URL', async () => {
    const router = solveLedgerPage.render(buildLedgerRows(26))
    const user = solveLedgerPage.user()

    await solveLedgerPage.findReadout(/Showing/)
    expect(screen.getByText('1–25')).toBeInTheDocument()
    expect(screen.getByText('26', { selector: '.mono' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Next page' }))

    await solveLedgerPage.findRow('sv-26')
    expect(router.state.location.search).toEqual({ page: 2 })
    expect(screen.getByText('26–26')).toBeInTheDocument()
    expect(solveLedgerPage.queryRow('sv-1')).not.toBeInTheDocument()
  })

  it('deep-links a `?page=` straight to that page', async () => {
    solveLedgerPage.render(buildLedgerRows(26), '/admin/schedule-solves?page=2')
    await solveLedgerPage.findRow('sv-26')
    expect(solveLedgerPage.queryRow('sv-1')).not.toBeInTheDocument()
  })

  it('inflects the footer noun for a single run (#1028)', async () => {
    solveLedgerPage.render(buildLedgerRows(1))
    await solveLedgerPage.findRow('sv-1')
    const footer = screen.getByText(/Showing/).closest('.footer-info')
    expect(footer).toHaveTextContent(/of 1 run$/)
  })

  it("filters to one tournament from a row's funnel — URL-driven, cleared by the chip", async () => {
    const rows = buildLedgerVariety()
    const router = solveLedgerPage.render(rows)
    const user = solveLedgerPage.user()

    const running = await solveLedgerPage.findRow('sv-running')
    await user.click(
      within(running).getByRole('button', {
        name: 'Show only Summer Slam 2026 runs',
      }),
    )

    // The filter is in the URL, the chip names the tournament, and the other
    // tournament's rows are gone (the stub pages with the same helper the API
    // mirrors).
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        tournament: 'summer-slam-2026',
      }),
    )
    await solveLedgerPage.findRow('sv-infeasible')
    expect(solveLedgerPage.queryRow('sv-succeeded')).not.toBeInTheDocument()
    const chip = solveLedgerPage.queryFilterChip()
    expect(chip).toHaveTextContent('Tournament: Summer Slam 2026')

    await user.click(
      screen.getByRole('button', { name: 'Clear tournament filter' }),
    )
    await solveLedgerPage.findRow('sv-succeeded')
    expect(router.state.location.search).toEqual({})
    expect(solveLedgerPage.queryFilterChip()).not.toBeInTheDocument()
  })

  it('renders the designed filtered-empty state with a way out', async () => {
    const rows = [buildAdminScheduleSolveRead({ id: 'sv-only' })]
    const router = solveLedgerPage.render(
      rows,
      '/admin/schedule-solves?tournament=summer-slam-2026',
    )
    const user = solveLedgerPage.user()

    expect(
      await screen.findByText('No runs for this tournament'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear filter' }))
    await solveLedgerPage.findRow('sv-only')
    expect(router.state.location.search).toEqual({})
  })

  it("renders the admin boundary's designed access-denied state on the server's 403 — raw detail never shown", async () => {
    solveLedgerPage.installForbidden()
    solveLedgerPage.mount()

    expect(await solveLedgerPage.findAccessDenied()).toBeInTheDocument()
    expect(
      screen.getByText('Ask an administrator to grant you access to this page.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Missing permission/),
    ).not.toBeInTheDocument()
  })
})
