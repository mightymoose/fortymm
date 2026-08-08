import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import { addEvent, seedTournament } from '../support/tournament-api'

/** The **round-robin** event — the one this preview must still lay out. `Open Singles`
 * is `seedTournament`'s default event name, so it is not typed anywhere but here. */
const RR_EVENT_NAME = 'Open Singles'
/** The **single-elimination** event standing beside it — the one the preview covers
 * nothing of. Named distinctly from the round-robin because the assertions below turn on
 * which of the two names a director-facing line carries. */
const KO_EVENT_NAME = 'Championship Bracket'

/** The synthetic field the preview auto-fills the round-robin to — its `max_players`
 * cap. Small on purpose, for `schedule-preview.spec.ts`'s reason: a 4-player round-robin
 * is 6 matches over a whole day, which the real 5s-capped solver settles fast and
 * cleanly, where an uncapped 16-player field is 120 matches and comes back `unknown`. */
const FIELD_SIZE = 4
/** C(4,2) = 6 pairings, and an even field byes nobody. **All six belong to the
 * round-robin**: the bracket contributes none, which is the whole subject. */
const RR_MATCHES = 6

/** A two-table venue, so the round-robin's rounds run in parallel and its day fits. */
const TABLES = [
  { label: 'Table 1', court: 'A' },
  { label: 'Table 2', court: 'A' },
]

/** The **exact** honest note a skipped event earns, composed the way
 * `app.schedule_preview_solve._honest_notes` composes it: the event's own name, the draw
 * type by its wire value, the reason, and what the live scheduler does instead.
 *
 * Pinned verbatim rather than matched by keyword because the sentence *is* the
 * deliverable. "Reported as not previewed" is not a state of the DOM a director reads —
 * it is these words. A looser match (`/not in this preview/`) would go green against copy
 * that had lost the event's name, the format, or the promise that the scheduler places it
 * once the tournament is live, which are the three things that stop the note being a
 * shrug. The api pins the same string in `test_schedule_preview_solve.py`; this end asserts
 * it survives the queue, the poll and the render. */
const SKIPPED_EVENT_NOTE =
  `${KO_EVENT_NAME} is not in this preview: a single-elim draw is decided round ` +
  'by round as it is played, so before anyone has entered there is nothing to lay ' +
  'out. The scheduler does place it once the tournament is live.'

/**
 * **One unpreviewable event no longer costs the whole tournament its preview**
 * (#1228; ADR 20260807 "a pool restricts scheduling, it does not enable it",
 * *Consequences* → "Preview is unchanged").
 *
 * A director whose tournament holds a round-robin **and** a single-elimination event
 * asks for a schedule preview. Before this arc they got nothing at all: the preview
 * builder sits inside a per-event loop, so the `UnsupportedDrawType` it raised for the
 * bracket aborted the build of the whole tournament, and the modal rendered its refusal
 * alert where the plan should have been. The round-robin beside it — perfectly
 * previewable, pooled, and the reason they opened the modal — went down with it.
 *
 * Now the bracket is **skipped and named**, and everything else is previewed as usual.
 *
 * ## What a preview still cannot do, and why that is not what changed
 *
 * A preview runs *before anyone has registered*. No match has been played, so every
 * fixture of a draw that is decided as it is played has unknown sides, and no engine
 * places a TBD-sided fixture. That limit is real and untouched here. What changed is its
 * blast radius: it now costs the offending event, not the tournament.
 *
 * ## Why this proof has to be the composed one
 *
 * The refusal and the skip live in two different processes. `build_preview_snapshot`
 * runs in the **api** at enqueue time — it is what decides between a 422 and a 202
 * carrying the instant structure — while the honest note the director reads is composed
 * in the **worker's** job and arrives later, over the poll. Nothing that stubs the
 * network sees that round trip, so only a spec against the real stack can say that a
 * director asking for a mixed tournament's preview gets a plan *and* is told what is
 * missing from it.
 *
 * ## What is asserted, and why each part is load-bearing
 *
 * * **The enqueue was accepted, by status.** The old behaviour's 422 arrives instantly,
 *   so a spec that only waited for a verdict would red as a bare 120s timeout — which
 *   cannot tell "the preview was refused" from "the worker never ran"
 *   (`.claude/rules/verify-the-artifact-under-test.md`). Asserting `202` makes the red
 *   quote the refusal sentence itself.
 * * **The round-robin's OWN matches are on screen.** Six cards inside
 *   `preview-event-<the round-robin's id>`, not six cards somewhere in the grid: the
 *   grid is grouped by event, and a count taken across the whole modal would pass just
 *   as happily if those cards belonged to the bracket.
 * * **The bracket contributed nothing to the plan.** No section of its own, no
 *   synthetic-field entry, no field-size box — the three places a previewed event
 *   appears.
 * * **The director is told why, in the words they read.** The honest-notes strip carries
 *   the skipped-event sentence verbatim, and carries **no** "Assumed N entrants" line for
 *   the bracket: no field was synthesized for it, so claiming one would contradict the
 *   sentence above it.
 *
 * ## Seed vs UI split
 *
 * Both events are inert scaffolding over the API (`support/tournament-api.ts`) — an
 * event editor drives the same `POST …/events` this does, and authoring two of them in
 * the browser would be two chances to fail for a reason that has nothing to do with the
 * preview. The load-bearing steps are the director's, in the browser: opening the
 * Schedule tab and reading the preview.
 *
 * The tournament is left **draft** and never drawn: a preview is a pre-registration
 * question, allowed only while the tournament is pre-live.
 *
 * ## RBAC
 *
 * As in `schedule-preview.spec.ts`: a minted guest holds only the permissionless default
 * role, so `grantBetaTester` hands the director the tournament bundle over the stack's
 * own `postgres` container before any tournament write. Skipped against an external
 * `E2E_BASE_URL` stack, where the caller owns provisioning.
 */
test.describe('Tournament — schedule preview with a mixed draw', () => {
  test('a director gets the round-robin preview back, and is told the bracket was left out', async ({
    page,
    baseURL,
  }) => {
    // The enqueue is instant; the verdict rides the preview queue + real CP-SAT +
    // ~700ms polling — generous, bounded waits throughout.
    test.setTimeout(240_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The director IS the browser's own session (`page.request` shares its cookie jar),
    // so page navigations run as the owner and the owner-only Preview trigger is offered.
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // ----- a DRAFT tournament holding TWO events, over the API -----------------
    // First the round-robin, pooled and capped — the event that must survive.
    const name = `Mixed ${faker.string.alphanumeric(8)}`
    const {
      tournamentId,
      eventId: roundRobinEventId,
      tables,
      pools,
    } = await seedTournament(director, name, {
      tables: TABLES,
      maxPlayers: FIELD_SIZE,
    })
    expect(pools, 'the round-robin needs a pool to be drawn into').toHaveLength(1)

    // Then the bracket, beside it — un-pooled end to end (ADR-0786), which is how a
    // director really configures one. Same catalogue, so the two events share a venue.
    const { eventId: bracketEventId, pools: bracketPools } = await addEvent(
      director,
      tournamentId,
      tables,
      { name: KO_EVENT_NAME, drawType: 'single-elim', pools: [] },
    )
    // THE PREMISE, both halves. Two distinct events on one tournament, and the second
    // is the un-pooled draw type the preview covers nothing of. Without this a green
    // run could not rule out that the seed had quietly made one event, or two
    // round-robins.
    expect(bracketPools, 'a bracket is un-pooled end to end').toEqual([])
    expect(bracketEventId).not.toBe(roundRobinEventId)

    // ----- the browser: the director opens the preview -------------------------
    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    // The long timeout is for the FIRST navigation only, and it is about the stack
    // rather than the app: the composed web-client is a Vite **dev** server, so the very
    // first request for a route pays for transforming it on demand.
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    const schedule = await detail.openSchedule()
    // Pre-live + owner ⇒ the trigger is offered, and the board is still empty.
    await expect(schedule.previewTrigger).toBeVisible()
    await expect(schedule.emptyState).toBeVisible()

    // The enqueue POST, watched from before the click. Matching on the method as well
    // as the path keeps the poll (`GET …/preview/{token}`) and the close-time cancel
    // (`DELETE …/preview/{token}`) out of it.
    const enqueuePost = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().endsWith('/schedule/preview'),
    )
    const preview = await schedule.openPreview()
    await expect(preview.dialog).toBeVisible()

    // ----- THE CLAIM, at its narrowest: the preview was ACCEPTED ---------------
    // Under the old behaviour this is the 422 the bracket raised for the whole
    // tournament, and the message quotes the refusal the director used to be given.
    const enqueued = await enqueuePost
    expect(
      enqueued.status(),
      `the preview was refused: ${await enqueued.text()}`,
    ).toBe(202)
    await expect(preview.enqueueError).toBeHidden()

    // ----- the instant structure — the round-robin, and only it ----------------
    // The synthetic-field line names every event a field was minted for. The bracket is
    // absent from it because no field was minted for an event nothing is previewed of —
    // this is the difference between "skipped" and "previewed as empty".
    await expect(preview.fieldSummary).toContainText(
      `${RR_EVENT_NAME} ${FIELD_SIZE}`,
    )
    await expect(preview.fieldSummary).not.toContainText(KO_EVENT_NAME)
    // Six matches, no byes — the round-robin's whole draw and nothing else. A bracket
    // that had leaked into the snapshot would push this number up.
    await expect(preview.counts).toHaveText(`${RR_MATCHES} matches · 0 byes`)

    // The grid is grouped by event, so this counts the ROUND-ROBIN's own cards. The
    // bracket has no section at all.
    await expect(preview.eventSection(roundRobinEventId)).toBeVisible()
    await expect(preview.placeholderMatchesFor(roundRobinEventId)).toHaveCount(
      RR_MATCHES,
    )
    await expect(preview.eventSection(bracketEventId)).toHaveCount(0)
    // …and those cards are the fake field, not real entrants (nobody has registered).
    await expect(preview.placeholderPairing.first()).toBeVisible()

    // The re-run control offers a field size for the previewed event only: there is
    // nothing to re-run a bracket's preview with.
    await expect(preview.overrideFor(RR_EVENT_NAME)).toBeVisible()
    await expect(preview.overrideFor(KO_EVENT_NAME)).toHaveCount(0)

    // ----- the streamed verdict — a real plan, not a shrug ---------------------
    // The verdict lands only when the stack's own `preview`-queue worker returns from
    // real CP-SAT. A fitting day reads OPTIMAL/FEASIBLE; the designed "doesn't fit" and
    // "didn't finish" states are absent — six best-of-1 matches over eight hours on two
    // tables fit, and the bracket's absence must not have made the day infeasible.
    await expect(preview.verdict).toBeVisible({ timeout: 120_000 })
    await expect(preview.verdict).toContainText(
      /Best possible plan|Good plan, found under the time cap/,
    )
    await expect(preview.infeasible).toBeHidden()
    await expect(preview.failed).toBeHidden()
    // The grid is still the round-robin's whole draw after the solve.
    await expect(preview.placeholderMatchesFor(roundRobinEventId)).toHaveCount(
      RR_MATCHES,
    )

    // ----- what the DIRECTOR is told about the missing event -------------------
    // The honest-notes strip, whose lines past the first arrive with the result. This is
    // the sentence that turns a skipped event into a reported one — without it the
    // director reads a schedule quietly missing an event and has nothing to tell them
    // why.
    await expect(preview.notes).toContainText(SKIPPED_EVENT_NOTE)
    // The previewed event still declares the count it assumed…
    await expect(preview.notes).toContainText(
      `Assumed ${FIELD_SIZE} entrants for ${RR_EVENT_NAME}.`,
    )
    // …and the skipped one claims no field, which would contradict the line above it.
    await expect(preview.notes).not.toContainText(`entrants for ${KO_EVENT_NAME}`)
  })
})
