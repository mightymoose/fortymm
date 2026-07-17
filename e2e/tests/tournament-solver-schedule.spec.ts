import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { NotificationsPage } from '../page-objects/notifications.page'
import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import {
  completeUnratedMatch,
  findUserId,
  guestFromContext,
  mintGuest,
  type Guest,
} from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  cutDraw,
  enterPlayer,
  getScheduleDetail,
  seedTournament,
  transitionTournament,
  type FixtureDetail,
} from '../support/tournament-api'

const EVENT_NAME = 'Open Singles'

/** The two-table venue this spec seeds; labels are what the call notification
 * names, ids are what the board's table sections are keyed by. */
const TABLES = [
  { id: 't1', label: 'Table 1', court: 'A' },
  { id: 't2', label: 'Table 2', court: 'A' },
]

/** The `HH:MM` of a naive wire timestamp (`YYYY-MM-DDTHH:MM:SS`) — the same
 * clock text the schedule list renders for a placement. */
const hhmm = (naive: string): string => naive.slice(11, 16)

/**
 * End-to-end proof of the tournament-day scheduling loop (ADR "the schedule is
 * solved; the call is pinned") against the REAL composed stack: the go-live
 * transition auto-enqueues a solve, the stack's real RQ worker runs real
 * CP-SAT, the guarded apply writes the placements AND calls the imminent
 * fixtures (pin + notify in one transaction), a completed match triggers a
 * re-solve — and the called fixture's placement survives it, byte for byte.
 *
 * ## Venue-frame timing — why the pool window brackets NOW
 *
 * Placements are naive wall-clock in the venue's frame, and the worker's
 * call-ahead judgment compares them to its own `datetime.now()` — UTC in the
 * compose stack's containers. The pool window is therefore seeded on TODAY'S
 * UTC date, spanning the whole day: the solver never places before "now", so
 * the first round lands minutes from now — inside the ~10-minute call-ahead
 * window — and the apply CALLS it naturally, no manual placement, no waiting
 * on the 60s pin tick. (Near UTC midnight the 4-player round-robin — a hard
 * 65-minute makespan floor — cannot fit before the venue day ends, so the
 * spec skips rather than reporting the solver's honest `infeasible` as red.)
 *
 * ## What is asserted where
 *
 * The board (Schedule tab) is read in the browser: the solve strip's
 * succeeded verdict (OPTIMAL/FEASIBLE vocabulary), every fixture placed on a
 * table with a time, the Gantt bar's tier, and — after the API completes a
 * match — the board updating to Completed while the called fixture stays put.
 * The **call badge itself is unreachable in this flow**: a pure round-robin
 * materializes every fixture into an `in_progress` match at go-live, and the
 * board's tier vocabulary ranks `started` above `called`, so the pin is
 * proven through its other two UI-visible consequences instead — the
 * recipient's in-app "You're up soon — {table}" notification (persisted in
 * the pin transaction) and the placement's immovability across the re-solve —
 * plus the pin columns over the API.
 */
test.describe('Tournament — solver schedule', () => {
  test('go-live solves the day onto real tables, calls are pinned, and pins survive the match-completed re-solve', async ({
    page,
    browser,
    baseURL,
  }) => {
    // Real CP-SAT is ~100ms, but this rides two RQ round-trips plus the
    // Schedule tab's 15s live polling — generous, bounded waits throughout.
    test.setTimeout(420_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The venue day is the container's UTC date. A 4-player round-robin needs
    // ≥65 minutes (3 rounds × 15min matches + 2 × 10min rest floors); with
    // less than ~90 minutes left before the window's 23:55 end the solver
    // would (correctly) answer infeasible — skip rather than fake a red.
    const now = new Date()
    const minutesLeftToday =
      (24 * 60 - 5) - (now.getUTCHours() * 60 + now.getUTCMinutes())
    test.skip(
      minutesLeftToday < 90,
      'UTC venue day nearly over — the round-robin cannot fit before midnight',
    )

    // The director IS the browser's session (`page.request` shares its cookie
    // jar), so the page sees owner surfaces (solve strip's Run button, etc.).
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // ----- seed: tournament + event whose pool window brackets NOW ----------
    const slot = {
      date: now.toISOString().slice(0, 10),
      start: '00:00',
      end: '23:55',
    }
    const name = `Solve ${faker.string.alphanumeric(8)}`
    const { tournamentId, eventId } = await seedTournament(director, name, {
      slot,
      tables: TABLES,
    })

    // ----- four entrants, all API-minted guests (director-entered) ----------
    const guests: Guest[] = []
    for (let i = 0; i < 4; i += 1) guests.push(await mintGuest(baseURL!))
    await transitionTournament(director, tournamentId, 'published')
    for (const guest of guests) {
      const userId = await findUserId(director, guest.username)
      await enterPlayer(director, tournamentId, eventId, userId)
    }

    // ----- cut the draw (6 fixtures), then GO LIVE ---------------------------
    // Go-live materializes all six fixtures into real in_progress matches and
    // auto-enqueues the initial solve on the stack's real worker.
    await cutDraw(director, tournamentId, eventId)
    await transitionTournament(director, tournamentId, 'live')

    // Join key for later: which minted guest sits behind each entry id.
    const seeded = await getScheduleDetail(director, tournamentId)
    const event = seeded.events.find((e) => e.id === eventId)
    expect(event, 'seeded event must be on the detail payload').toBeTruthy()
    const guestByEntry = new Map<string, Guest>()
    for (const entrant of event!.entrants) {
      const guest = guests.find((g) => g.username === entrant.username)
      if (guest) guestByEntry.set(entrant.id, guest)
    }
    expect(guestByEntry.size).toBe(4)

    // ----- the browser: Schedule tab, solve strip verdict, full placement ---
    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    const schedule = await detail.openSchedule()

    // The strip reports the applied solve in the OPTIMAL/FEASIBLE vocabulary.
    // The tab polls while live, so this converges without reloads.
    await expect(schedule.solveSucceeded).toBeVisible({ timeout: 180_000 })
    await expect(schedule.solveSucceeded).toContainText(
      /Best possible plan|Good plan, found under the time cap/,
    )
    await expect(schedule.solveInfeasible).toBeHidden()

    // A whole-day plan: all 6 fixtures placed — none awaiting, and every row
    // sits in a table column carrying a wall-clock time.
    await expect(schedule.matchRows).toHaveCount(6, { timeout: 60_000 })
    await expect(schedule.awaitingSection).toBeHidden()
    const fixtures = (await getScheduleDetail(director, tournamentId)).events.find(
      (e) => e.id === eventId,
    )!.fixtures
    expect(fixtures).toHaveLength(6)
    for (const fixture of fixtures) {
      expect(fixture.table_id, `fixture ${fixture.id} has a table`).not.toBeNull()
      expect(
        fixture.scheduled_start,
        `fixture ${fixture.id} has a time`,
      ).not.toBeNull()
      await expect(
        schedule.placedRow(fixture.table_id!, fixture.id),
      ).toBeVisible()
      await expect(schedule.matchRow(fixture.id)).toContainText(
        hhmm(fixture.scheduled_start!),
      )
    }

    // ----- the call: imminent fixtures were PINNED at apply ------------------
    // The pool window brackets now, so the first round's projected start is
    // inside the ~10-minute call-ahead window and the apply calls it in the
    // same transaction it writes placements (the pin tick is the backstop —
    // the poll outlasts a full tick interval either way).
    await expect
      .poll(
        async () => {
          const d = await getScheduleDetail(director, tournamentId)
          return d.events
            .find((e) => e.id === eventId)!
            .fixtures.filter((f) => f.pinned_at !== null).length
        },
        { timeout: 120_000, intervals: [2_000] },
      )
      .toBeGreaterThan(0)

    const called = (await getScheduleDetail(director, tournamentId)).events
      .find((e) => e.id === eventId)!
      .fixtures.filter((f) => f.pinned_at !== null)
    const tracked = called[0]
    expect(tracked.table_id).not.toBeNull()
    expect(tracked.scheduled_start).not.toBeNull()
    expect(tracked.call_notified_count).toBeGreaterThan(0)
    const trackedTable = TABLES.find((t) => t.id === tracked.table_id)!
    const trackedTime = hhmm(tracked.scheduled_start!)

    // Record the called fixture's placement on the Gantt board: its bar exists
    // on the tracked table's plan, and its tier is NOT a movable estimate — a
    // called fixture reads as a promise (or as already underway, since a
    // materialized tournament match is in_progress from go-live and `started`
    // outranks `called` in the board's tier vocabulary).
    await schedule.ganttToggle.click()
    const bar = schedule.timelineBar(tracked.id)
    await expect(bar).toBeVisible()
    await expect(bar).toHaveAttribute('data-tier', /^(called|started)$/)
    await expect(bar).toHaveAttribute(
      'aria-label',
      new RegExp(`${trackedTable.label}.*${trackedTime}`),
    )
    await schedule.listToggle.click()

    // The call told the players — the pin transaction persisted an in-app
    // notification for each entrant. Open the feed AS one of them (a fresh
    // browser context wearing that guest's cookies) and read the promise.
    const recipient = guestByEntry.get(tracked.entry_a_id!)
    expect(recipient, 'tracked fixture entrant maps to a minted guest').toBeTruthy()
    const recipientContext = await browser.newContext({
      baseURL: baseURL!,
      storageState: await recipient!.ctx.storageState(),
    })
    const feed = await NotificationsPage.navigateTo(
      await recipientContext.newPage(),
    )
    await expect(feed.callNotice(trackedTable.label)).toBeVisible({
      timeout: 30_000,
    })
    await recipientContext.close()

    // ----- complete ANOTHER match over the API → the real re-solve -----------
    // Prefer the other called fixture (both first-round matches are typically
    // called together); any fixture but the tracked one proves the same thing.
    const toComplete =
      called.find((f) => f.id !== tracked.id) ??
      fixtures.find((f) => f.id !== tracked.id)!
    expect(toComplete.match_id, 'fixture materialized at go-live').not.toBeNull()
    const scorer = guestByEntry.get(toComplete.entry_a_id!)!
    await completeUnratedMatch(scorer, toComplete.match_id!, [
      { game_number: 1, side_1_points: 11, side_2_points: 5 },
    ])

    // The completion triggered a fresh solve on the real worker, and it
    // succeeded (a drift-discarded run re-runs; either way the ledger's latest
    // row moves past the go-live run and lands succeeded).
    const goLiveSolveId = seeded.latest_schedule_solve?.id ?? null
    await expect
      .poll(
        async () => {
          const solve = (await getScheduleDetail(director, tournamentId))
            .latest_schedule_solve
          return solve !== null &&
            solve.id !== goLiveSolveId &&
            solve.status === 'succeeded'
            ? solve.status
            : null
        },
        { timeout: 120_000, intervals: [2_000] },
      )
      .toBe('succeeded')

    // ----- the board updates; the promise does not move ----------------------
    // The polling tab shows the completed match as played...
    await expect(schedule.matchStatus(toComplete.id)).toHaveText('Completed', {
      timeout: 90_000,
    })
    // ...the strip still reports a succeeded plan...
    await expect(schedule.solveSucceeded).toBeVisible()
    // ...and the CALLED fixture still shows the SAME table and time — the
    // epic's core promise, observed through the UI: we never rearrange what
    // we told a player.
    await expect(schedule.placedRow(tracked.table_id!, tracked.id)).toBeVisible()
    await expect(schedule.matchRow(tracked.id)).toContainText(trackedTime)

    // Belt and braces at the seam: the pin columns are byte-identical.
    const after = (await getScheduleDetail(director, tournamentId)).events
      .find((e) => e.id === eventId)!
      .fixtures.find((f) => f.id === tracked.id)!
    expect(after.pinned_at).not.toBeNull()
    expect(after.table_id).toBe(tracked.table_id)
    expect(after.scheduled_start).toBe(tracked.scheduled_start)

    for (const guest of guests) await guest.ctx.dispose()
  })
})
