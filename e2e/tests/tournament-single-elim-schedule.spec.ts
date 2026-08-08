import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  getScheduleDetail,
  seedEntrants,
  seedTournament,
  tomorrowUtc,
  transitionTournament,
  type FixtureDetail,
  type TableSpec,
} from '../support/tournament-api'

/** The event this spec seeds and cuts — a single-elimination draw, which is un-pooled
 * end to end (ADR-0786: every one of its fixtures carries `pool_id IS NULL`). */
const EVENT_NAME = 'Open Singles'

/** The venue: two tables, so the two first-round matches can run at once. Neither is
 * reserved by any pool, because the event has no pools — they are reachable only as
 * "every table in the tournament", which is exactly what an event-wide reservation is
 * made of (ADR 20260807). Their ids are minted by the server and read back off the seed. */
const TABLES: ReadonlyArray<TableSpec> = [
  { label: 'Table 1', court: 'A' },
  { label: 'Table 2', court: 'A' },
]

/** `N` — four entrants, which is a full bracket of four: two first-round fixtures, no
 * byes, and one final. The smallest field that gives the solver more than one thing to
 * place while leaving a genuinely un-placeable fixture behind (the final's sides are TBD
 * until somebody wins), so the spec can say what happens to each. */
const FIELD = 4
/** Round one of a four-slot bracket: two fixtures, both with real entrants on both
 * sides — the only fixtures a freshly cut bracket can be placed at all. */
const ROUND_ONE_FIXTURES = 2
/** Two first-round fixtures plus the final. */
const BRACKET_FIXTURES = 3

/** The event's own window, `HH:MM` in its own timezone — which the seed anchors to `UTC`,
 * the compose stack's clock, so venue-local and UTC are the same wall clock here.
 *
 * This is the window the ADR says an un-pooled fixture is placed over, so the spec
 * asserts each placement lands inside it. Eight hours is far more than three best-of-1
 * matches need, so a day that does not fit would be a real infeasibility and not a
 * squeeze this spec engineered. */
const WINDOW_START = '09:00'
const WINDOW_END = '17:00'

/** `HH:MM` as minutes since midnight — the form the two window bounds and a placement's
 * own clock time can be compared in. */
function minutesOfClock(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number)
  return hours * 60 + minutes
}

/** A placement instant's UTC date (`YYYY-MM-DD`) and its minutes since midnight.
 *
 * Read off the UTC getters rather than by slicing the string: `instant` is an
 * offset-bearing ISO-8601 timestamp normalized to `+00:00` (`FixtureTimeRead`), and the
 * event's timezone is `UTC`, so its UTC clock **is** the venue wall clock the window is
 * written in. */
function placedAt(instant: string): { date: string; minutes: number } {
  const moment = new Date(instant)
  return {
    date: moment.toISOString().slice(0, 10),
    minutes: moment.getUTCHours() * 60 + moment.getUTCMinutes(),
  }
}

/**
 * **A single-elimination bracket reaches the schedule with a real table and a real time**
 * (#1228, ADR 20260807 "a pool restricts scheduling, it does not enable it").
 *
 * Before that ADR the solver placed a fixture only if it belonged to a pool —
 * `if fixture.pool_id is None: continue` — and a bracket has no pool, so no bracket match
 * was ever given a table or a call time. A director could reserve tables and a window for
 * a single-elim event and nothing consumed the reservation. The ADR replaced the skip
 * with a branch: an un-pooled fixture is placed over its **event's own window**, on
 * **every table in the tournament**.
 *
 * ## Why this proof has to be the composed one
 *
 * The two commits before this one prove the rule at the unit level — the api's snapshot
 * builder mints the event-wide reservation, and the schedule tab's view model carries it
 * — and neither can say the two halves meet. The reservation is built inside the
 * **worker's** solve, not the api process: the browser's Run-scheduler click enqueues, an
 * RQ worker runs real CP-SAT, and the guarded apply writes the placement columns the
 * detail BFF then serves. Nothing that stubs the network sees that round trip, so only a
 * spec against the real stack can say a bracket match ends up on a real table at a real
 * time.
 *
 * ## What is asserted, and why each half is load-bearing
 *
 * * **The premise.** The event is seeded with `pools: []` and every fixture reads back
 *   `pool_id: null`. Without this a green run could not rule out that some pool did the
 *   work — which is the one thing that was never in doubt.
 * * **The placement, on the wire.** Each first-round fixture carries a `table_id` **of
 *   this tournament's catalogue** and a `scheduled_start` **inside the event's own
 *   window**. "Has a non-null time" would also pass an implementation that placed the
 *   bracket at some arbitrary default; the window is the ADR's actual claim.
 * * **The placement, on the page.** Each first-round match's row is rendered *inside* its
 *   table's column with the server's own rendered time (`local_label` + `tz_abbrev`) —
 *   what a director can see. Under the old behaviour those rows sit in "Awaiting
 *   placement" with an em dash where the time goes, so a row-count assertion would go
 *   green against it and prove nothing.
 * * **The final stays awaiting**, because its sides are TBD and a fixture with an unknown
 *   side cannot be placed by anyone. That is the un-pooled rule doing its job rather than
 *   placing everything indiscriminately.
 *
 * ## Seed vs UI split
 *
 * Inert scaffolding over the API (`support/tournament-api.ts`): the tournament, its two
 * tables, the pool-less single-elim event and its four entrants — director-entry has no
 * web UI, and four browser sign-ins to test the *scheduler* would be four chances to fail
 * for an unrelated reason. The load-bearing steps are the director's, in the browser:
 * cutting the draw, running the scheduler, and reading the board.
 *
 * ## RBAC
 *
 * As in `tournament-lifecycle.spec.ts`: a minted user holds only the permissionless
 * default role, so `grantBetaTester` hands the director the tournament bundle over the
 * stack's own `postgres` container before any tournament write. Skipped against an
 * external `E2E_BASE_URL` stack, where the caller owns provisioning.
 */
test.describe('Tournament — single-elim schedule', () => {
  test('a director schedules a pool-less bracket onto real tables at real times', async ({
    page,
    baseURL,
  }) => {
    // Four minted guests and four director-entries, a real draw cut, and a real CP-SAT
    // solve that rides an RQ round trip before its placements reach the page.
    test.setTimeout(300_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The director IS the browser's own session (`page.request` shares its cookie jar),
    // so page navigations run as them and the owner-only controls are on screen.
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // ----- the venue and the event, over the API ------------------------------
    const slot = { date: tomorrowUtc(), start: WINDOW_START, end: WINDOW_END }
    const name = `KO ${faker.string.alphanumeric(8)}`
    const { tournamentId, eventId, tables, pools } = await seedTournament(
      director,
      name,
      { slot, tables: TABLES, pools: [], drawType: 'single-elim' },
    )

    // THE PREMISE. The event reserves nothing: no pool, so no pool window and no pool
    // tables. Everything below is therefore a statement about a fixture that names no
    // reservation of its own — which is the whole subject.
    expect(pools, 'the seeded event must hold no pools at all').toEqual([])
    expect(tables).toHaveLength(TABLES.length)
    const tableIds = tables.map((table) => table.id)

    // ----- publish, then fill the field ---------------------------------------
    await transitionTournament(director, tournamentId, 'published')
    const entrants = await seedEntrants(
      director,
      baseURL!,
      tournamentId,
      eventId,
      FIELD,
    )

    // ----- the browser: the director cuts the draw ----------------------------
    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    // The long timeout is for the FIRST navigation only, and it is about the stack rather
    // than the app: the composed web-client is a Vite **dev** server, so the very first
    // request for a route pays for transforming it on demand.
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    const drawPost = page.waitForResponse(
      (r) => r.url().endsWith('/draw') && r.request().method() === 'POST',
    )
    await detail.generateDrawButton(EVENT_NAME).click()
    const drawResponse = await drawPost
    // The status, not merely "a panel appeared": a refused cut leaves the card as it was,
    // and a spec that waited for fixtures would fail as a timeout naming nothing.
    expect(
      drawResponse.status(),
      `cutting the draw was refused: ${await drawResponse.text()}`,
    ).toBe(201)
    // The bracket is the un-pooled block — a draw with no pool sections at all.
    await expect(detail.bracket(eventId)).toBeVisible()

    // ----- the fixtures belong to no pool -------------------------------------
    const fixturesOf = async (): Promise<ReadonlyArray<FixtureDetail>> => {
      const schedule = await getScheduleDetail(director, tournamentId)
      const event = schedule.events.find((e) => e.id === eventId)
      expect(event, 'the seeded event must be on the detail payload').toBeTruthy()
      return event!.fixtures
    }

    const cut = await fixturesOf()
    expect(cut, 'a four-slot bracket is two first-round fixtures and a final').toHaveLength(
      BRACKET_FIXTURES,
    )
    for (const fixture of cut) {
      expect(
        fixture.pool_id,
        `fixture ${fixture.id} belongs to a pool — the premise of this spec is that none do`,
      ).toBeNull()
    }
    const cutRoundOne = cut.filter((fixture) => fixture.round === 1)
    expect(cutRoundOne).toHaveLength(ROUND_ONE_FIXTURES)
    const roundOneIds = cutRoundOne.map((fixture) => fixture.id)
    for (const fixture of cutRoundOne) {
      // Both sides known is what makes a fixture placeable at all, so this establishes
      // that a failure below is about the pool rule and not about a TBD side.
      expect(fixture.entry_a_id, `round-1 fixture ${fixture.id} has an A side`).not.toBeNull()
      expect(fixture.entry_b_id, `round-1 fixture ${fixture.id} has a B side`).not.toBeNull()
    }
    // The final is round 2 of a four-slot bracket, named by its round rather than as
    // "the fixture that is not in round one": an id derived by exclusion still resolves to
    // something the day the bracket grows a round, and would quietly assert about the
    // wrong match. An explicit round check fails loudly instead.
    const finals = cut.filter((fixture) => fixture.round === 2)
    expect(
      finals,
      'a four-slot bracket holds exactly one round-2 fixture: the final',
    ).toHaveLength(1)
    const finalId = finals[0].id

    // ----- the browser: the director runs the scheduler ------------------------
    const schedule = await detail.openSchedule()
    await expect(schedule.runScheduler).toBeVisible()
    const solvePost = page.waitForResponse(
      (r) =>
        r.url().endsWith('/schedule/solves') && r.request().method() === 'POST',
    )
    await schedule.runScheduler.click()
    const solveResponse = await solvePost
    // The run was ACCEPTED. A tournament with nothing cut is refused `no_drawn_events`
    // (422), and asserting the status here makes that refusal name itself rather than
    // surfacing later as "no placements".
    expect(
      solveResponse.status(),
      `the scheduler run was refused: ${await solveResponse.text()}`,
    ).toBe(202)
    await expect(schedule.runSchedulerNotice).toBeHidden()

    // ----- the solve terminates ------------------------------------------------
    // Terminal, not `succeeded`: this gate exists to separate "the worker never ran" from
    // "the worker ran and placed nothing", so it must pass in BOTH states. The
    // discriminating assertion is the next one.
    await expect
      .poll(
        async () => {
          const solve = (await getScheduleDetail(director, tournamentId))
            .latest_schedule_solve
          return solve === null ? null : solve.status
        },
        {
          message: 'the queued solve must reach a terminal status on the real worker',
          timeout: 180_000,
          intervals: [2_000],
        },
      )
      .toMatch(/^(succeeded|infeasible|failed)$/)

    // ----- THE CLAIM: the bracket was placed -----------------------------------
    // The fixtures belong to no pool, so every table and every minute below came from the
    // event's own window over the tournament's whole catalogue — the event-wide
    // reservation. Under the pre-ADR behaviour the solver skipped these fixtures and this
    // count stays 0.
    await expect
      .poll(
        async () => {
          const placed = (await fixturesOf()).filter(
            (fixture) =>
              roundOneIds.includes(fixture.id) &&
              fixture.table_id !== null &&
              fixture.scheduled_start !== null,
          )
          return placed.length
        },
        {
          message:
            "the bracket's first round must be given a table and a time — a fixture with " +
            'no pool is scheduled against its event window, on any table in the tournament',
          timeout: 180_000,
          intervals: [2_000],
        },
      )
      .toBe(ROUND_ONE_FIXTURES)

    // The plan the director was shown is a real one, not a shrug: the strip reports the
    // solver's verdict in its own vocabulary, and the designed "the day doesn't fit"
    // state is absent — three best-of-1 matches over eight hours on two tables fit.
    await expect(schedule.solveSucceeded).toBeVisible({ timeout: 60_000 })
    await expect(schedule.solveSucceeded).toContainText(
      /Best possible plan|Good plan, found under the time cap/,
    )
    await expect(schedule.solveInfeasible).toBeHidden()

    // ----- each placement names a real table, inside the EVENT's window ---------
    const solved = await fixturesOf()
    const roundOne = solved.filter((fixture) => roundOneIds.includes(fixture.id))
    for (const fixture of roundOne) {
      expect(
        tableIds,
        `fixture ${fixture.id} is on a table this tournament does not have`,
      ).toContain(fixture.table_id)
      const at = placedAt(fixture.scheduled_start!.instant)
      // The event's own Slot is the window, so both the DATE and the clock time are the
      // event's. A placement on another day would mean the reservation came from
      // somewhere else entirely.
      expect(at.date, `fixture ${fixture.id} was placed off the event's date`).toBe(
        slot.date,
      )
      expect(
        at.minutes,
        `fixture ${fixture.id} starts before the event's window opens`,
      ).toBeGreaterThanOrEqual(minutesOfClock(WINDOW_START))
      expect(
        at.minutes,
        `fixture ${fixture.id} starts after the event's window closes`,
      ).toBeLessThan(minutesOfClock(WINDOW_END))
      expect(fixture.scheduled_start!.local_label).not.toBe('')
    }

    // The final could not be placed by anybody: both its sides are TBD until a
    // first-round match is won, so the un-pooled rule places what it can and leaves the
    // rest — it does not hand out tables indiscriminately.
    const bracketFinal = solved.find((fixture) => fixture.id === finalId)!
    expect(bracketFinal.entry_a_id).toBeNull()
    expect(bracketFinal.table_id, 'a TBD-sided fixture cannot be placed').toBeNull()

    // ----- what the DIRECTOR sees ----------------------------------------------
    // A fresh load rather than the tab's polling: the tab polls while a solve is in
    // flight and stops once it is terminal, so a reload removes any dependence on which
    // poll happened to carry the placements.
    await detail.reload(tournamentId)
    await expect(detail.title).toContainText(name)
    const board = await detail.openSchedule()
    for (const fixture of roundOne) {
      // Inside the table's own column — that IS the fact "this match is on that table",
      // as a director reads it.
      await expect(
        board.placedRow(fixture.table_id!, fixture.id),
        `the board does not show fixture ${fixture.id} on its table`,
      ).toBeVisible({ timeout: 30_000 })
      // …carrying the time the server rendered, timezone and all — the client displays
      // `local_label` + `tz_abbrev` verbatim.
      await expect(board.matchRow(fixture.id)).toContainText(
        `${fixture.scheduled_start!.local_label} ${fixture.scheduled_start!.tz_abbrev}`,
      )
      // …and not in the awaiting group, which is where an unplaced match lives and where
      // every one of these sat before a bracket could be scheduled.
      await expect(
        board.awaitingSection.getByTestId(`schedule-match-${fixture.id}`),
      ).toHaveCount(0)
    }
    // The final is the one match still awaiting a placement, named.
    await expect(board.awaitingSection).toBeVisible()
    await expect(
      board.awaitingSection.getByTestId(`schedule-match-${finalId}`),
    ).toBeVisible()

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })
})
