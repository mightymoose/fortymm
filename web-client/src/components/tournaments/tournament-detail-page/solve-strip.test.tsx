import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import { waitFor } from '@/test/utilities'

import { buildScheduleSolve } from '../data/seed.factory'
import { solveStripPage } from './solve-strip.page'

/** The refusal the route really sends for "nothing is drawn" — the ADR-0968
 * coded shape, exactly as `unwrap` would have thrown it. */
function noDrawnEventsError(): ApiError {
  return new ApiError(422, 'There is nothing to schedule yet.', 'run the scheduler', {
    detail: { code: 'no_drawn_events', message: 'There is nothing to schedule yet.' },
  })
}

describe('SolveStrip', () => {
  // ----- the five designed states -------------------------------------------

  it('renders the designed "no plan yet" state — never an error — when no solve was ever requested', () => {
    solveStripPage.render({ solve: null })
    expect(solveStripPage.getStateText('none')).toContain('No schedule plan yet')
    // Organizer-voiced hint for the person who can act on it.
    expect(solveStripPage.getStateText('none')).toContain('Run the scheduler')
  })

  it('swaps the organizer-voiced hint for neutral copy for a viewer', () => {
    solveStripPage.render({ solve: null, canEdit: false })
    expect(solveStripPage.getStateText('none')).toContain(
      'The organizer has not run the scheduler yet.',
    )
  })

  it.each(['queued', 'running'] as const)(
    'renders a %s run as the one "solving" state, naming its trigger in our words',
    (status) => {
      solveStripPage.render({
        solve: buildScheduleSolve({
          status,
          trigger: 'manual',
          verdict: null,
          startedAt: status === 'running' ? '2026-06-13T09:00:01Z' : null,
          finishedAt: null,
          wallTimeMs: null,
          fixturesPlaced: null,
          fixturesPinned: null,
        }),
      })
      const text = solveStripPage.getStateText('solving')
      expect(text).toContain('Solving the schedule…')
      expect(text).toContain('Run by hand')
      // The raw enum never reaches the UI.
      expect(text).not.toContain('manual')
    },
  )

  it('renders a succeeded optimal run with the verdict, the wall time and the trigger — all in our copy', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({
        status: 'succeeded',
        verdict: 'optimal',
        trigger: 'match_completed',
        wallTimeMs: 850,
      }),
    })
    const text = solveStripPage.getStateText('succeeded')
    expect(text).toContain('Schedule solved')
    expect(text).toContain('Best possible plan')
    expect(text).toContain('solved in 850 ms')
    expect(text).toContain('Run after a match finished')
    expect(text).not.toContain('optimal')
    expect(text).not.toContain('match_completed')
  })

  it('renders a feasible verdict as the honest time-capped claim', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({ verdict: 'feasible', wallTimeMs: 5000 }),
    })
    const text = solveStripPage.getStateText('succeeded')
    expect(text).toContain('Good plan, found under the time cap')
    expect(text).toContain('solved in 5.0s')
  })

  it('degrades a succeeded run whose verdict is missing to the modest (feasible) claim', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({ verdict: null }),
    })
    expect(solveStripPage.getStateText('succeeded')).toContain(
      'Good plan, found under the time cap',
    )
  })

  it('renders infeasible as a DESIGNED state in the director\'s terms — the day does not fit — not an error banner', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({
        status: 'infeasible',
        verdict: 'infeasible',
        fixturesPlaced: null,
        fixturesPinned: null,
      }),
    })
    const text = solveStripPage.getStateText('infeasible')
    expect(text).toContain("The day doesn't fit")
    // Actionable, in venue vocabulary — never the solver's.
    expect(text).toContain('Add tables, widen a pool window')
    expect(text).not.toContain('infeasible')
    // And it is a state, not a refusal: no notice rings.
    expect(solveStripPage.queryNotice()).toBeNull()
  })

  it('renders a failed run under our headline, with the server\'s account as detail', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({
        status: 'failed',
        verdict: null,
        wallTimeMs: null,
        fixturesPlaced: null,
        fixturesPinned: null,
        error: 'worker crashed: OOM',
      }),
    })
    const text = solveStripPage.getStateText('failed')
    expect(text).toContain('The scheduler hit a problem')
    expect(text).toContain('worker crashed: OOM')
  })

  // ----- the Run-scheduler button --------------------------------------------

  it('offers a viewer NOTHING — no control at all, not a disabled one (ADR-0015)', () => {
    solveStripPage.render({
      solve: buildScheduleSolve(),
      canEdit: false,
    })
    expect(solveStripPage.queryRunButton()).toBeNull()
    expect(solveStripPage.getControls()).toHaveLength(0)
  })

  it('fires the run exactly once for a double-click — the in-flight latch (#436 family)', async () => {
    let release!: () => void
    const onRun = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    solveStripPage.render({ onRun })

    solveStripPage.clickRun()
    solveStripPage.clickRun()
    expect(onRun).toHaveBeenCalledTimes(1)
    // …and the button says so while the request is in the air.
    await waitFor(() => expect(solveStripPage.getRunButton()).toBeDisabled())
    release()
    await waitFor(() => expect(solveStripPage.getRunButton()).toBeEnabled())
  })

  it.each(['queued', 'running'] as const)(
    'withholds the button while a solve is %s — the server would absorb the click anyway',
    (status) => {
      solveStripPage.render({
        solve: buildScheduleSolve({
          status,
          verdict: null,
          finishedAt: null,
          wallTimeMs: null,
          fixturesPlaced: null,
          fixturesPinned: null,
        }),
      })
      expect(solveStripPage.getRunButton()).toBeDisabled()
    },
  )

  it('disables the button while the mutation reports itself pending', () => {
    solveStripPage.render({ isRequesting: true })
    expect(solveStripPage.getRunButton()).toBeDisabled()
  })

  // ----- the refusals, inline ------------------------------------------------

  it('words the 422 no_drawn_events refusal as the designed "cut a draw first" notice', async () => {
    solveStripPage.render({ onRun: () => Promise.reject(noDrawnEventsError()) })
    solveStripPage.clickRun()
    await waitFor(() => expect(solveStripPage.queryNotice()).not.toBeNull())
    const text = solveStripPage.getNoticeText()
    expect(text).toContain('Nothing to schedule yet')
    expect(text).toContain("Cut at least one event's draw")
    // The server's fallback prose is not what we show.
    expect(text).not.toContain('no_drawn_events')
  })

  it('clears the notice when a new attempt starts', async () => {
    let fail = true
    const onRun = vi.fn(() =>
      fail ? Promise.reject(noDrawnEventsError()) : Promise.resolve(),
    )
    solveStripPage.render({ onRun })

    solveStripPage.clickRun()
    await waitFor(() => expect(solveStripPage.queryNotice()).not.toBeNull())

    fail = false
    solveStripPage.clickRun()
    await waitFor(() => expect(solveStripPage.queryNotice()).toBeNull())
  })
})
