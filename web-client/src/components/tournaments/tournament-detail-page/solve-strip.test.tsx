import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import { waitFor } from '@/test/utilities'

import {
  buildPlayerConflict,
  buildScheduleSolve,
  buildTableConflict,
} from '../data/seed.factory'
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
      expect(text).toContain('Placing matches on tables…')
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

  it('renders an overrunning succeeded run as a calm badge on the success line — never a "doesn\'t fit" error', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({ status: 'succeeded', overrunning: true }),
    })
    // Still the success state, not the infeasible/failed arms.
    expect(solveStripPage.queryState('succeeded')).not.toBeNull()
    expect(solveStripPage.queryState('infeasible')).toBeNull()
    expect(solveStripPage.queryState('failed')).toBeNull()
    // The explicit overrunning surface: badge + calm explanatory line.
    expect(solveStripPage.queryOverrunning()).not.toBeNull()
    const text = solveStripPage.getStateText('succeeded')
    expect(text).toContain('Overrunning')
    expect(text).toContain('running past its planned window')
    // Calm, not error framing.
    expect(text).not.toContain("doesn't fit")
  })

  it('shows NO overrunning surface on a normal (in-window) succeeded solve — the discriminating case', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({ status: 'succeeded', overrunning: false }),
    })
    expect(solveStripPage.queryState('succeeded')).not.toBeNull()
    expect(solveStripPage.queryOverrunning()).toBeNull()
    expect(solveStripPage.getStateText('succeeded')).not.toContain('Overrunning')
  })

  it('renders infeasible as a DESIGNED state in the director\'s terms — the day does not fit — not an error banner, naming EACH resolved cause', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({
        status: 'infeasible',
        verdict: 'infeasible',
        fixturesPlaced: null,
        fixturesPinned: null,
        infeasibilityReasons: [
          { kind: 'pool_has_no_tables', poolName: 'Pool B' },
          {
            kind: 'pool_over_capacity',
            poolName: 'Pool A',
            windowStart: '09:00',
            windowEnd: '12:30',
            requiredMin: 480,
            capacityMin: 420,
            tableCount: 4,
          },
        ],
      }),
    })
    const text = solveStripPage.getStateText('infeasible')
    expect(text).toContain("The day doesn't fit")
    // BOTH reasons' sentences, named specifically…
    expect(text).toContain('Pool B has no tables assigned.')
    expect(text).toContain("Pool A can't fit all its matches")
    // …AND both remedies.
    expect(text).toContain('Assign at least one table to Pool B')
    expect(text).toContain('Add a table to Pool A, widen its window, or trim the field.')
    // The specific list REPLACES the generic sentence.
    expect(text).not.toContain('The matches can\'t all fit inside their windows')
    // The raw enum never reaches the UI.
    expect(text).not.toContain('infeasible')
    // And it is a state, not a refusal: no notice rings.
    expect(solveStripPage.queryNotice()).toBeNull()
    // No named cause here (generic capacity infeasibility): NO specific dated
    // message, only the generic copy — the discriminating case.
    expect(solveStripPage.queryPastWindow()).toBeNull()
  })

  it('names a wholly-past window as its own dated reason arm — "dated in the past, move the date", NOT the generic "doesn\'t fit" body', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({
        status: 'infeasible',
        verdict: 'infeasible',
        fixturesPlaced: null,
        fixturesPinned: null,
        infeasibilityReasons: [{ kind: 'past_window', date: '2026-07-18' }],
      }),
    })
    // Still the designed infeasible state, not an error banner.
    expect(solveStripPage.queryState('infeasible')).not.toBeNull()
    expect(solveStripPage.queryState('failed')).toBeNull()
    expect(solveStripPage.queryNotice()).toBeNull()
    // The past_window arm renders its own discoverable, dated reason row.
    expect(solveStripPage.queryPastWindow()).not.toBeNull()
    const text = solveStripPage.getStateText('infeasible')
    // A dated-past headline, since a past window is the whole story here.
    expect(text).toContain('This day has already passed')
    // The specific, dated, actionable reason names the offending venue-local day.
    expect(text).toContain('Jul 18, 2026')
    expect(text).toContain('dated in the past')
    expect(text).toContain('Move the event to a future date')
    // INSTEAD of the generic "doesn't fit" body — the whole point of naming it.
    expect(text).not.toContain('Add tables, widen a pool window')
    // The raw wire code never reaches the UI.
    expect(text).not.toContain('past_window')
  })

  it('names an over-subscribed PLAYER — the human, the pool, its window and the match count — and never tells the director to add tables', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({
        status: 'infeasible',
        verdict: 'infeasible',
        fixturesPlaced: null,
        fixturesPinned: null,
        infeasibilityReasons: [
          {
            kind: 'player_over_subscribed',
            playerName: 'spiked-frigatebird',
            poolName: 'Pool A',
            windowStart: '09:00',
            windowEnd: '10:30',
            matchCount: 4,
            requiredMin: 150,
            windowSpanMin: 90,
          },
        ],
      }),
    })
    const text = solveStripPage.getStateText('infeasible')
    expect(text).toContain("The day doesn't fit")
    // The ticket's headline sentence: WHO, in HOW MANY matches, in WHICH window.
    expect(text).toContain('spiked-frigatebird is in 4 matches')
    expect(text).toContain("Pool A's 09:00–10:30 window")
    expect(text).toContain('they need about 2.5h')
    expect(text).toContain('the window is only 1.5h long')
    // The remedies that work for ONE human — and NOT the add-tables trap, which
    // would only let somebody else play in parallel.
    expect(text).toContain('fewer matches in Pool A')
    expect(text).toContain('widen its window')
    expect(text).toContain("adding tables won't help one player")
    expect(text).not.toContain('Add a table to Pool A')
    // The generic body (which DOES say "Add tables") is replaced, not appended.
    expect(text).not.toContain('Add tables, widen a pool window')
    // The raw wire code never reaches the UI.
    expect(text).not.toContain('player_over_subscribed')
  })

  it('falls back to the generic sentence if an infeasible row carries no reasons — the strip never renders bodyless', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({
        status: 'infeasible',
        verdict: 'infeasible',
        fixturesPlaced: null,
        fixturesPinned: null,
        infeasibilityReasons: [],
      }),
    })
    const text = solveStripPage.getStateText('infeasible')
    expect(text).toContain("The day doesn't fit")
    expect(text).toContain('Add tables, widen a pool window')
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
    // A broken job is NOT the infeasible outcome — no resolved reason leaks in.
    expect(text).not.toContain('has no tables assigned')
    expect(text).not.toContain("The day doesn't fit")
  })

  // ----- the placed-board caution: overlapping in-progress matches -----------

  it('warns about overlapping in-progress matches on a SUCCEEDED board — a caution, not the infeasible banner — naming both matches and the shared table AND human', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({
        status: 'succeeded',
        verdict: 'feasible',
        placementConflicts: [buildTableConflict(), buildPlayerConflict()],
      }),
    })
    // The board is still solved — the caution rides UNDER the success line.
    expect(solveStripPage.getStateText('succeeded')).toContain('Schedule solved')
    const text = solveStripPage.getConflictsText()
    expect(text).toContain('Overlapping matches on the board')
    // The table conflict: both matches, named by matchup, and the shared table.
    expect(text).toContain('crafty-vs-spiked and dazed-vs-confused overlap on Table 1')
    // The player conflict: the shared human.
    expect(text).toContain(
      'crafty-vs-spiked-frigatebird and spiked-frigatebird-vs-nimble overlap on spiked-frigatebird',
    )
    // It is a caution, not the "nothing placed" infeasible banner.
    expect(text).not.toContain("The day doesn't fit")
    // And not a refusal — no notice rings.
    expect(solveStripPage.queryNotice()).toBeNull()
  })

  it('renders NO conflict warning on a clean board (placement_conflicts: [])', () => {
    solveStripPage.render({
      solve: buildScheduleSolve({ status: 'succeeded', placementConflicts: [] }),
    })
    expect(solveStripPage.queryConflicts()).toBeNull()
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
