import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import { getScheduleDetail, seedTournament } from '../support/tournament-api'

const EVENT_NAME = 'Open Singles'
/** The synthetic field size the preview auto-fills to — the event's cap. Small
 * on purpose: a 4-player round-robin is 6 matches, 0 byes, a ~1-hour makespan
 * floor that fits the whole day and lets the real 5s-capped solver return a clean
 * "fits" verdict fast, instead of an over-the-cap `unknown`. */
const FIELD_SIZE = 4
/** C(4,2) = 6 pairings, and an even field byes nobody. */
const EXPECTED_MATCHES = 6

/** A two-table venue so the round-robin's rounds run in parallel and the day
 * fits comfortably. */
const TABLES = [
  { id: 't1', label: 'Table 1', court: 'A' },
  { id: 't2', label: 'Table 2', court: 'A' },
]

/**
 * End-to-end proof of the **schedule preview** (ADR "a schedule preview is a
 * non-persistent solve over a synthetic field") against the REAL composed stack:
 * a director, on a **draft** round-robin tournament's Schedule tab, opens
 * "Preview schedule"; the modal renders the synthetic field + `Placeholder N`
 * grid from the first frame, then **streams a verdict** in when the stack's real
 * `preview`-queue worker runs real CP-SAT over the fake field — and the
 * tournament **still has no real schedule afterward**: the preview persisted
 * nothing (no entrants, no fixtures, no solve-ledger row).
 *
 * ## Why draft + a capped field
 *
 * A preview is a *pre-registration* question, allowed only while the tournament
 * is pre-live (`draft`/`published`) — so the tournament is left **draft**, never
 * published, never drawn. The event carries a small `max_players` cap so the
 * field the preview auto-fills to is 4, not the uncapped default of 16: a
 * 16-player field is 120 matches, which either overruns the day (infeasible) or
 * exhausts the 5s cap (`unknown`) — neither is the clean "fits" this asserts. A
 * 4-player field solves fast and optimally.
 *
 * ## The "nothing persisted" observable
 *
 * The strongest black-box check available through the running app is that the
 * Schedule tab stays in its **pre-live empty state** ("Nothing to schedule yet")
 * after previewing — a preview that created placements would fill the board.
 * Belt-and-braces at the API seam: the event still has **zero fixtures** and
 * **zero entrants**, and `latest_schedule_solve` is still **null** (a preview
 * writes no solve-ledger row).
 */
test.describe('Tournament — schedule preview', () => {
  test('a director previews a draft round-robin, sees a verdict + Placeholder grid, and nothing is persisted', async ({
    page,
    baseURL,
  }) => {
    // The enqueue is instant, but the verdict rides the preview queue + real
    // CP-SAT + ~700ms polling — generous, bounded waits throughout.
    test.setTimeout(240_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The director IS the browser's own session (`page.request` shares its cookie
    // jar), so page navigations run authenticated as the owner and the tournament
    // comes back `can_edit: true` — the owner-only Preview trigger is offered.
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // A DRAFT tournament with one capped round-robin event — never published,
    // never drawn. The far-future default window (09:00–17:00) is wide enough for
    // the whole synthetic day.
    const name = `Preview ${faker.string.alphanumeric(8)}`
    const { tournamentId, eventId } = await seedTournament(director, name, {
      tables: TABLES,
      maxPlayers: FIELD_SIZE,
    })

    // ----- open the Preview schedule modal on the Schedule tab ---------------
    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    const schedule = await detail.openSchedule()
    // Pre-live + owner ⇒ the trigger is offered, and the board is still empty.
    await expect(schedule.previewTrigger).toBeVisible()
    await expect(schedule.emptyState).toBeVisible()

    const preview = await schedule.openPreview()
    await expect(preview.dialog).toBeVisible()

    // ----- the instant structure — before any solve result lands -------------
    // The synthetic field + counts + the full `Placeholder N` grid render from
    // the enqueue 202, not from the solve.
    await expect(preview.fieldSummary).toContainText(EVENT_NAME)
    await expect(preview.fieldSummary).toContainText(String(FIELD_SIZE))
    await expect(preview.counts).toHaveText(`${EXPECTED_MATCHES} matches · 0 byes`)
    // The whole synthetic field is drawn as `Placeholder … vs Placeholder …`
    // cards — one per drawn pairing.
    await expect(preview.placeholderMatches).toHaveCount(EXPECTED_MATCHES)
    await expect(preview.placeholderPairing.first()).toBeVisible()

    // ----- the streamed verdict — the real solve returns ---------------------
    // The verdict is the headline that lands only when the worker's CP-SAT run
    // comes back; a fitting day reads OPTIMAL/FEASIBLE, never infeasible/failed.
    await expect(preview.verdict).toBeVisible({ timeout: 120_000 })
    await expect(preview.verdict).toContainText(
      /Best possible plan|Good plan, found under the time cap/,
    )
    await expect(preview.infeasible).toBeHidden()
    await expect(preview.failed).toBeHidden()
    // The `Placeholder N` grid is still the whole synthetic field after the solve.
    await expect(preview.placeholderMatches).toHaveCount(EXPECTED_MATCHES)

    // ----- nothing persisted — through the browser ---------------------------
    // Close the modal (fires the best-effort cancel, unmounts the body) and the
    // Schedule tab is STILL in its pre-live empty state: a preview that had
    // created placements would have filled the board.
    await preview.close()
    await expect(preview.dialog).toBeHidden()
    await expect(schedule.emptyState).toBeVisible()
    await expect(schedule.matchRows).toHaveCount(0)

    // ----- nothing persisted — belt-and-braces at the API seam ---------------
    // A hard reload picks up any state a preview might have leaked, then the
    // detail payload proves the tournament is untouched: no entrants, no
    // fixtures, and no solve-ledger row.
    const after = await getScheduleDetail(director, tournamentId)
    const event = after.events.find((e) => e.id === eventId)
    expect(event, 'the seeded event is on the detail payload').toBeTruthy()
    expect(event!.entrants, 'a preview creates no entrants').toHaveLength(0)
    expect(event!.fixtures, 'a preview creates no fixtures').toHaveLength(0)
    expect(
      after.latest_schedule_solve,
      'a preview writes no solve-ledger row',
    ).toBeNull()
  })
})
