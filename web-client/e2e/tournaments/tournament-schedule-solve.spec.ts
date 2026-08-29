/**
 * The **solve strip** on the Schedule tab (ADR "the schedule is solved; the call is
 * pinned"), through the real browser, MSW OFF.
 *
 * What only this suite proves, and why vitest could not:
 *
 *   1. **The new BFF fields cross the real wire.** `latest_schedule_solve` on the
 *      detail payload, `pinned_at`/`call_notified_count` on every fixture — the
 *      client Zod-parses all of them inside the queryFn, so a stub that dropped one
 *      would fail the PAGE here (and only here: vitest reads the same generated
 *      factories the app was built against, which is circular).
 *
 *   2. **The strip resolves by POLLING.** Run scheduler answers 202 with a `queued`
 *      row — the work is accepted, not done — and the strip must walk
 *      solving → succeeded on the client's own refetch cadence, with no reload and
 *      no push. The stub's mock worker advances one step per detail read, so the
 *      walk below is the real polling loop turning.
 *
 *   3. **Infeasible is a designed state, not an error.** The strip words it in the
 *      director's terms and rings nothing red; an error-boundary regression that ate
 *      it would only show here, on the real bundle.
 *
 *   4. **axe-clean in every strip state** (DEFINITION_OF_COMPLETE) — none-yet,
 *      succeeded, infeasible, and the inline "cut a draw first" refusal.
 */
import { expect, test } from '@playwright/test'

import { buildScheduleSolveRead } from '../../src/mocks/factories/tournaments/tournament.factory'
import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import { EVENT, TOURNAMENT_ID } from '../page-objects/tournaments/tournaments-store'
import { expectAxeClean } from '../support/axe'

/** A tournament the solver has something to place in: both drawable events drawn.
 * (`READY_TO_START` re-typed inline would drift; but that constant is about
 * go-live — this seed is the same shape for the solver's reason: fixtures exist.) */
const DRAWN_SEED = { drawable: true, drawn: [EVENT.JOURNEY, EVENT.GROUPS] } as const

test.describe('Tournaments · schedule solve strip', () => {
  test('shows a seeded succeeded solve — verdict, wall time and trigger in our copy, never the wire’s', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN_SEED,
      latestSolve: buildScheduleSolveRead({
        status: 'succeeded',
        verdict: 'optimal',
        trigger: 'manual',
        wall_time_ms: 850,
      }),
    })
    await pom.openScheduleTab()

    const state = pom.solveStripState('succeeded')
    await expect(state).toBeVisible()
    await expect(state).toContainText('Schedule solved')
    await expect(state).toContainText('Best possible plan')
    await expect(state).toContainText('solved in 850 ms')
    await expect(state).toContainText('Run by hand')
    // The raw enums never reach the UI.
    await expect(state).not.toContainText('optimal')
    await expect(state).not.toContainText('manual')

    await expectAxeClean(page, 'schedule tab — succeeded solve on the strip')
  })

  test('an overrunning succeeded solve shows a calm "overrunning" badge on the strip — the live day ran past its planned window, still scheduled, never a "doesn’t fit" error', async ({
    page,
  }) => {
    // The `overrunning` boolean crosses the real wire on the schedule-solve read;
    // the client Zod-parses it in the queryFn and the strip surfaces it here.
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN_SEED,
      status: 'live',
      latestSolve: buildScheduleSolveRead({
        status: 'succeeded',
        verdict: 'feasible',
        trigger: 'match_completed',
        overrunning: true,
      }),
    })
    await pom.openScheduleTab()

    const state = pom.solveStripState('succeeded')
    await expect(state).toBeVisible()
    await expect(pom.overrunningBadge).toBeVisible()
    await expect(state).toContainText('Overrunning')
    await expect(state).toContainText('running past its planned window')
    // A calm success qualifier, NOT the infeasible "doesn't fit" arm.
    await expect(pom.solveStripState('infeasible')).toHaveCount(0)
    await expect(state).not.toContainText("doesn't fit")

    await expectAxeClean(page, 'schedule tab — overrunning solve on the strip')
  })

  test('a normal in-window succeeded solve shows NO overrunning badge — the discriminating case', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN_SEED,
      latestSolve: buildScheduleSolveRead({
        status: 'succeeded',
        verdict: 'optimal',
        overrunning: false,
      }),
    })
    await pom.openScheduleTab()

    await expect(pom.solveStripState('succeeded')).toBeVisible()
    await expect(pom.overrunningBadge).toHaveCount(0)
  })

  test('Run scheduler POSTs, and the strip walks solving → succeeded on the polling loop — placements landing with it', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, DRAWN_SEED)
    await pom.openScheduleTab()

    // Born unsolved: the designed none-yet state, with the owner's button live.
    await expect(pom.solveStripState('none')).toBeVisible()
    await expectAxeClean(page, 'schedule tab — no solve yet')

    await pom.runScheduler.click()

    // The 202 answered a queued row; the reconcile read shows the run in flight…
    await expect(pom.solveStripState('solving')).toBeVisible()
    await expect(pom.solveStripState('solving')).toContainText(
      'Placing matches on tables…',
    )
    // …and the button is withheld while it is (the server would absorb a second
    // click anyway — one solve in flight per tournament).
    await expect(pom.runScheduler).toBeDisabled()

    // The next poll (~3s, the in-flight clip) lands the outcome — no reload.
    await expect(pom.solveStripState('succeeded')).toBeVisible({ timeout: 15_000 })
    expect(store.latestSolve?.status).toBe('succeeded')

    // The solve placed the draw: the server now holds a table on every grouped
    // fixture it dealt (assert the STORE, not markup — the schedule grid is the
    // placement slice's spec, not this one's).
    const fixtures = store.fixturesOf(EVENT.GROUPS)
    expect(fixtures.length).toBeGreaterThan(0)
    expect(fixtures.every((f) => f.table_id !== null)).toBe(true)
  })

  test('a second request while the run is in flight mints NO second row — the 202 absorbs it', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, DRAWN_SEED)
    await pom.openScheduleTab()

    await pom.runScheduler.click()
    await expect(pom.solveStripState('solving')).toBeVisible()
    const firstId = store.latestSolve?.id

    // The UI withholds the button while a run is in flight, so the second request
    // has to be forced past it — which is the point: the guard under test is the
    // SERVER-side absorb, not the DOM's disabled attribute.
    const second = await page.evaluate(async (id) => {
      const res = await fetch(`/api/v1/tournaments/${id}/schedule/solves`, {
        method: 'POST',
      })
      return { status: res.status, body: (await res.json()) as { id: string } }
    }, TOURNAMENT_ID)

    // Honest 202 — the work is accepted (it already was) — answering the SAME row.
    expect(second.status).toBe(202)
    expect(second.body.id).toBe(firstId)

    await expect(pom.solveStripState('succeeded')).toBeVisible({ timeout: 15_000 })
    expect(store.latestSolve?.id).toBe(firstId)
  })

  test('renders infeasible as the designed director-language state — no error banner, nothing red rung', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN_SEED,
      latestSolve: buildScheduleSolveRead({
        status: 'infeasible',
        verdict: 'infeasible',
        trigger: 'manual',
        fixtures_placed: null,
        fixtures_pinned: null,
      }),
    })
    await pom.openScheduleTab()

    const state = pom.solveStripState('infeasible')
    await expect(state).toBeVisible()
    await expect(state).toContainText("The day doesn't fit")
    await expect(state).toContainText("Add tables, widen a reservation's window")
    // Designed, not an error: no refusal notice, no toast, and the wire's word
    // for it appears nowhere.
    await expect(pom.runSchedulerNotice).not.toBeVisible()
    await expect(pom.toasts).toHaveCount(0)
    await expect(state).not.toContainText('infeasible')
    // A GENERIC capacity infeasibility (`infeasibility_reasons: []`): the generic
    // copy, and NO specific dated past-window reason — the discriminating case.
    await expect(pom.pastWindowMessage).toHaveCount(0)
    // The director can act on it immediately: the button is live again.
    await expect(pom.runScheduler).toBeEnabled()

    await expectAxeClean(page, 'schedule tab — infeasible solve on the strip')
  })

  test('names a wholly-past window as its own dated reason arm — the `past_window` fact crosses the real wire', async ({
    page,
  }) => {
    // A `past_window` arm of `infeasibility_reasons` crosses the real wire on the
    // schedule-solve read; the client Zod-parses it in the queryFn and the strip
    // renders the SPECIFIC dated reason instead of the generic "doesn't fit" (ADR
    // "a past day is named, not disguised").
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN_SEED,
      latestSolve: buildScheduleSolveRead({
        status: 'infeasible',
        verdict: 'infeasible',
        trigger: 'manual',
        fixtures_placed: null,
        fixtures_pinned: null,
        infeasibility_reasons: [{ kind: 'past_window', date: '2026-07-18' }],
      }),
    })
    await pom.openScheduleTab()

    const state = pom.solveStripState('infeasible')
    await expect(state).toBeVisible()
    // The specific, dated, actionable reason names the offending venue-local day…
    await expect(pom.pastWindowMessage).toBeVisible()
    await expect(state).toContainText('This day has already passed')
    await expect(state).toContainText('Jul 18, 2026')
    await expect(state).toContainText('dated in the past')
    await expect(state).toContainText('Move the event to a future date')
    // …INSTEAD of the generic "doesn't fit" body — the whole point of naming it.
    await expect(state).not.toContainText("Add tables, widen a reservation's window")
    // Still a designed state, not an error: nothing red rings, and the raw wire
    // code never reaches the UI.
    await expect(pom.runSchedulerNotice).not.toBeVisible()
    await expect(pom.toasts).toHaveCount(0)
    await expect(state).not.toContainText('past_window')
    await expect(pom.runScheduler).toBeEnabled()

    await expectAxeClean(page, 'schedule tab — past-window infeasible solve on the strip')
  })

  test('names an over-subscribed PLAYER — the `player_over_subscribed` fact crosses the real wire, and the remedy never says "add tables"', async ({
    page,
  }) => {
    // A `player_over_subscribed` arm of `infeasibility_reasons` crosses the real
    // wire (MSW off, this stub IS the API) with all eight of its fields; the
    // client Zod-parses it in the queryFn and the strip renders the human-named
    // sentence (ADR "the conflict core is a second, max-placed solve", decision 1).
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN_SEED,
      latestSolve: buildScheduleSolveRead({
        status: 'infeasible',
        verdict: 'infeasible',
        trigger: 'manual',
        fixtures_placed: null,
        fixtures_pinned: null,
        infeasibility_reasons: [
          {
            kind: 'player_over_subscribed',
            player_name: 'spiked-frigatebird',
            reservation_name: 'Reservation A',
            // A real booked reservation, so the remedy may offer the reservation verbs.
            reservation: 'booked',
            window_start: '09:00',
            window_end: '10:30',
            match_count: 4,
            required_min: 150,
            window_span_min: 90,
          },
        ],
      }),
    })
    await pom.openScheduleTab()

    const state = pom.solveStripState('infeasible')
    await expect(state).toBeVisible()
    // WHO, in HOW MANY matches, in WHICH window — the ticket's headline.
    await expect(state).toContainText('spiked-frigatebird is in 4 matches')
    await expect(state).toContainText("Reservation A's 09:00–10:30 window")
    await expect(state).toContainText('they need about 2.5h')
    // The remedies that work for one human — and NOT the add-tables trap: extra
    // tables let somebody ELSE play in parallel, never this person twice at once.
    await expect(state).toContainText('fewer matches in Reservation A')
    await expect(state).toContainText("adding tables won't help one player")
    await expect(state).not.toContainText('Add a table to Reservation A')
    await expect(state).not.toContainText("Add tables, widen a reservation's window")
    // Still a designed state, not an error, and the raw wire code stays off screen.
    await expect(pom.runSchedulerNotice).not.toBeVisible()
    await expect(pom.toasts).toHaveCount(0)
    await expect(state).not.toContainText('player_over_subscribed')
    await expect(pom.runScheduler).toBeEnabled()

    await expectAxeClean(
      page,
      'schedule tab — over-subscribed-player infeasible solve on the strip',
    )
  })

  test('blames the EVENT-WIDE reservation with remedies a director can actually carry out — never a reservation control the event does not have', async ({
    page,
  }) => {
    // The same arm, `reservation: 'event'` — an ungrouped fixture (a bracket, a
    // swiss round, a knockout stage) is placed against the event's own window over
    // every table in the tournament (ADR 20260807). There is no reservation row
    // behind this arm, so the remedy must name the event and its field, not a
    // reservation to shrink or a reservation window to widen. MSW is off: this stub
    // IS the API, so the discriminator crosses the real wire and the real Zod parse.
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN_SEED,
      latestSolve: buildScheduleSolveRead({
        status: 'infeasible',
        verdict: 'infeasible',
        trigger: 'manual',
        fixtures_placed: null,
        fixtures_pinned: null,
        infeasibility_reasons: [
          {
            kind: 'player_over_subscribed',
            player_name: 'spiked-frigatebird',
            reservation_name: 'Open Singles (whole venue)',
            reservation: 'event',
            window_start: '09:00',
            window_end: '10:30',
            match_count: 4,
            required_min: 150,
            window_span_min: 90,
          },
        ],
      }),
    })
    await pom.openScheduleTab()

    const state = pom.solveStripState('infeasible')
    await expect(state).toBeVisible()
    // The same honest figures…
    await expect(state).toContainText('spiked-frigatebird is in 4 matches')
    await expect(state).toContainText('they need about 2.5h')
    // …and a remedy whose every control exists for an ungrouped fixture.
    await expect(state).toContainText('fewer matches in this event')
    await expect(state).toContainText('a smaller field')
    await expect(state).toContainText("widen the event's window")
    // NOT the reservation controls: the event has no reservation to shrink, and no
    // reservation window.
    await expect(state).not.toContainText('a smaller reservation')
    await expect(state).not.toContainText('widen its window')
    // Still a designed state, and the raw wire words stay off screen.
    await expect(pom.runSchedulerNotice).not.toBeVisible()
    await expect(state).not.toContainText('player_over_subscribed')
    await expect(state).not.toContainText('reservation')
  })

  test('answers the coded 422 with the designed "cut a draw first" message, inline on the strip', async ({
    page,
  }) => {
    // Drawable but NOT drawn: fixtures exist nowhere, so the solver has nothing
    // to place and the route refuses with `no_drawn_events`.
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      drawable: true,
    })
    await pom.openScheduleTab()

    await pom.runScheduler.click()

    await expect(pom.runSchedulerNotice).toBeVisible()
    await expect(pom.runSchedulerNotice).toContainText('Nothing to schedule yet')
    await expect(pom.runSchedulerNotice).toContainText(
      "Cut at least one event's draw",
    )
    // The refusal queued nothing — and the client's copy, not the server's
    // fallback prose or its code, is what the director reads.
    expect(store.latestSolve).toBeNull()
    await expect(pom.runSchedulerNotice).not.toContainText('no_drawn_events')

    await expectAxeClean(page, 'schedule tab — run refused (cut a draw first)')
  })

  test('offers a viewer no scheduler at all — the strip reads as a view (ADR-0015)', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN_SEED,
      canEdit: false,
      latestSolve: buildScheduleSolveRead(),
    })
    await pom.openScheduleTab()

    await expect(pom.solveStripState('succeeded')).toBeVisible()
    await expect(pom.runScheduler).not.toBeVisible()
  })

  test('while a solve is in flight the placements are provisional — notice up, actions withheld, and the poll reconciles the open tab to the fresh board (#1614)', async ({
    page,
  }) => {
    // The go-live race in the browser: a LIVE tournament whose draw is cut but
    // unplaced. Run queues a solve, and while it is queued/running the
    // placements on screen are the server's LAST ACCEPTED plan — the worker may
    // commit at any second, so the tab must not offer Place/Move on data a
    // landing solve may replace, and must say so.
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN_SEED,
      status: 'live',
    })
    await pom.openScheduleTab()

    await expect(pom.solveStripState('none')).toBeVisible()
    expect(store.fixturesOf(EVENT.GROUPS).length).toBeGreaterThan(0)
    const fixtureIds = store.fixturesOf(EVENT.GROUPS).map((f) => f.id)

    await pom.runScheduler.click()

    // The run is in flight: the strip walks solving, the tab speaks the
    // provisional state — the last-good schedule kept visible…
    await expect(pom.solveStripState('solving')).toBeVisible()
    await expect(pom.placementUpdating).toBeVisible()
    await expect(pom.placementUpdating).toContainText(
      'Placement updates in progress',
    )
    await expect(pom.awaitingSection).toBeVisible()
    // …and NOT actionable: no Place on any awaiting row while the solve runs.
    for (const id of fixtureIds.slice(0, 3)) {
      await expect(pom.placeTrigger(id)).toHaveCount(0)
    }

    await expectAxeClean(
      page,
      'schedule tab — provisional placements while a solve is in flight',
    )

    // The next poll (the ~3s in-flight clip) lands the terminal payload: the
    // notice clears, every fixture the solver placed sits in its table's column
    // — none awaiting — and the (now-Move) affordances return. No reload, no
    // navigation: the same open tab reconciled itself.
    await expect(pom.solveStripState('succeeded')).toBeVisible({ timeout: 15_000 })
    expect(store.latestSolve?.status).toBe('succeeded')
    await expect(pom.placementUpdating).toHaveCount(0)
    await expect(pom.awaitingSection).toHaveCount(0)
    const placed = store
      .fixturesOf(EVENT.GROUPS)
      .filter((f) => f.table_id !== null)
    expect(placed.length).toBeGreaterThan(0)
    for (const fixture of placed) {
      await expect(
        pom.tableSection(fixture.table_id!).getByTestId(
          `schedule-match-${fixture.id}`,
        ),
      ).toBeVisible()
    }
    // A placed fixture is not offered Place — its affordance, if read, is Move.
    await expect(pom.placeTrigger(placed[0].id)).toContainText('Move')
  })
})
