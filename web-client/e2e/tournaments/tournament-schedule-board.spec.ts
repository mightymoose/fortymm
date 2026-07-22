/**
 * The Schedule tab's **boards** — the Gantt (tables × time) and the player
 * timeline (entrants × time) — through the real browser, MSW OFF (chore 2a of
 * ADR "the schedule is solved; the call is pinned").
 *
 * What only this suite proves, and why vitest could not:
 *
 *   1. **Bars follow the real wire.** The stub's mock solver writes
 *      `table_id`/`scheduled_start` onto the fixtures, the tab's polling refetch
 *      carries them in, and the Gantt draws exactly that many bars — a
 *      placements→pixels path that vitest only ever exercises against its own
 *      factories.
 *
 *   2. **The keyboard path.** Tab reaches a bar (real focus order, real
 *      `:focus-visible`) and the radix tooltip opens on it — jsdom's focus
 *      events approximate this; only chromium proves it.
 *
 *   3. **axe-clean in both board views** (DEFINITION_OF_COMPLETE) — including
 *      the scrollable-region-focusable rule the boards exist to satisfy
 *      (#1035 family), which jsdom cannot represent (no layout, no overflow).
 *
 *   4. **The responsive contract.** On a phone viewport the boards scroll
 *      inside their own container and the PAGE never scrolls sideways —
 *      geometry again, unrepresentable in jsdom.
 */
import { expect, test } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import { EVENT } from '../page-objects/tournaments/tournaments-store'
import { expectAxeClean } from '../support/axe'
import { expectNoHorizontalScroll } from '../support/viewport'

/** Both drawable events drawn — fixtures exist for the solver to place (the
 * same seed the solve-strip spec runs on). */
const DRAWN_SEED = { drawable: true, drawn: [EVENT.JOURNEY, EVENT.POOLS] } as const

test.describe('Tournaments · schedule boards', () => {
  test('the list stays the default view, and an unsolved board prompts for the scheduler', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, DRAWN_SEED)
    await pom.openScheduleTab()

    // List is the default: the toggle is up, the boards are not.
    await expect(pom.scheduleViewToggle).toBeVisible()
    await expect(pom.ganttBoard).not.toBeVisible()

    // Nothing is placed yet, so a board view is the designed prompt, not an
    // empty grid — and not an error.
    await pom.setScheduleView('Gantt')
    await expect(pom.boardEmptyPrompt).toBeVisible()
    await expect(pom.boardEmptyPrompt).toContainText('No matches placed yet')
    await expect(pom.boardEmptyPrompt).toContainText('Run the scheduler')
    await expect(pom.timelineBars).toHaveCount(0)

    await expectAxeClean(page, 'schedule tab — Gantt view, nothing placed yet')

    // The list is still there to come back to — nothing regressed.
    await pom.setScheduleView('List')
    await expect(pom.boardEmptyPrompt).not.toBeVisible()
  })

  test('after a solve the Gantt draws a bar per placed fixture, and the toggle walks all three views', async ({
    page,
  }) => {
    const { pom, store } = await TournamentDetailPage.navigateTo(page, DRAWN_SEED)
    await pom.openScheduleTab()

    // Run the solver and let the polling loop land the outcome + placements.
    await pom.runScheduler.click()
    await expect(pom.solveStripState('succeeded')).toBeVisible({ timeout: 15_000 })

    // The server now holds a placement on every pooled fixture…
    const placed = [
      ...store.fixturesOf(EVENT.JOURNEY),
      ...store.fixturesOf(EVENT.POOLS),
    ].filter((f) => f.table_id !== null && f.scheduled_start !== null)
    expect(placed.length).toBeGreaterThan(0)

    // …and the Gantt draws exactly that many bars, on rows the catalogue names.
    await pom.setScheduleView('Gantt')
    await expect(pom.ganttRegion).toBeVisible()
    await expect(pom.timelineBars).toHaveCount(placed.length)
    // Pool A of the POOLS event reserves t1/t2 — its rows carry bars.
    await expect(pom.ganttRow('t1')).toBeVisible()
    // Everything placed: no "not yet scheduled" rail left.
    await expect(pom.unscheduledRail).not.toBeVisible()
    // Fresh placements are ESTIMATES — the tier is on the bar, in words.
    await expect(pom.timelineBars.first()).toHaveAttribute('data-tier', 'estimate')

    await expectAxeClean(page, 'schedule tab — Gantt view with placed bars')

    // The player timeline shows the same schedule by entrant.
    await pom.setScheduleView('Player timeline')
    await expect(pom.playerRegion).toBeVisible()
    await expect(pom.ganttBoard).not.toBeVisible()
    // Every bar belongs to two players' rows, so the count doubles.
    await expect(pom.timelineBars).toHaveCount(placed.length * 2)

    await expectAxeClean(page, 'schedule tab — player timeline view')

    // And back to the list, intact.
    await pom.setScheduleView('List')
    await expect(pom.playerTimelineBoard).not.toBeVisible()
  })

  test('on a LIVE tournament the solve CALLS the imminent fixtures — and the badges survive materialization (every match is in_progress from go-live)', async ({
    page,
  }) => {
    // LIVE is what arms the calling pass (ADR "the schedule is solved; the call
    // is pinned"): pre-live solves plan silently, a live solve promises — and
    // the stub's mock worker pins whatever lands within the ~10-minute
    // call-ahead window of the day's first ball.
    //
    // LIVE is also what MATERIALIZES (#788): every ready fixture is an
    // `in_progress` match from the first live second, so every called fixture
    // is tier `started` — the exact state in which QA caught the real board
    // hiding every called badge and reading every bar as "In progress".
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN_SEED,
      status: 'live',
    })
    await pom.openScheduleTab()
    await pom.runScheduler.click()
    await expect(pom.solveStripState('succeeded')).toBeVisible({ timeout: 15_000 })

    // The server now holds real pins: pinned_at set, one notification counted —
    // on fixtures whose matches are ALL already in_progress (materialized).
    const fixtures = [
      ...store.fixturesOf(EVENT.JOURNEY),
      ...store.fixturesOf(EVENT.POOLS),
    ]
    expect(fixtures.every((f) => f.match_status === 'in_progress')).toBe(true)
    const called = fixtures.filter((f) => f.pinned_at !== null)
    expect(called.length).toBeGreaterThan(0)
    expect(called.every((f) => f.call_notified_count === 1)).toBe(true)

    // The LIST (the default view) says which rows are promises: one called-at
    // badge per pin, VISIBLE — the badge rides the pin, never the tier (the
    // QA-caught gap: it used to vanish the moment the match materialized).
    await expect(pom.calledBadges).toHaveCount(called.length)
    await expect(pom.calledBadges.first()).toBeVisible()
    // The called-at badge reads the server's venue-local label + tz abbrev (ADR
    // "a schedule surface always labels the timezone"), not a UTC/naive string.
    await expect(pom.calledBadges.first()).toContainText('Called 9:00 AM CDT')
    // One call each, no corrections yet: the `notified n×` counter stays off.
    await expect(pom.notifiedMarkers).toHaveCount(0)
    // No `est` marks while live: every row's match is materialized (tier
    // `started`), and `est` is the plan-tier word alone.
    await expect(pom.estMarks).toHaveCount(0)

    await expectAxeClean(page, 'schedule tab — list view with called badges')

    // The boards: tier visuals stay honest (started outranks the pin — no bar
    // pretends to be a plan), and the promise rides the bar's own marker/aria
    // instead of the tier.
    await pom.setScheduleView('Gantt')
    await expect(pom.timelineBars.first()).toHaveAttribute('data-tier', 'started')
    await expect(pom.calledBars).toHaveCount(0)
    const calledBar = pom.timelineBar(called[0].id)
    await expect(calledBar).toHaveAttribute('aria-label', /Called 9:00 AM CDT/)
    // …and the started-tier words claim scoreability, never live play — the
    // other half of the QA finding (every bar read "In progress", hours out).
    await expect(calledBar).toHaveAttribute(
      'aria-label',
      /Underway or up next — scores can be entered/,
    )

    await expectAxeClean(page, 'schedule tab — Gantt view with called bars')
  })

  test('while LIVE a manual placement is priced: the call confirm, then the correction confirm on a move', async ({
    page,
  }) => {
    // While live, a director's placement IS a call (ADR "the schedule is solved;
    // the call is pinned") — so the UI prices it before the click. Only this
    // suite can prove the whole loop: confirm → real PATCH on the wire → the
    // server pins in the same write → the refetch brings the badge back.
    const { pom, store } = await TournamentDetailPage.navigateTo(page, {
      ...DRAWN_SEED,
      status: 'live',
    })
    await pom.openScheduleTab()

    const placementPatches = () =>
      store.requests.filter(
        (r) => r.method === 'PATCH' && r.path.endsWith('/placement'),
      )

    // An untold, unplaced fixture straight off the server's own draw — whose
    // match is ALREADY `in_progress` (go-live materialized it, #788), so the
    // badge this test ends on is the tier-independent one QA found missing.
    const fixture = store.fixturesOf(EVENT.JOURNEY)[0]
    expect(fixture.call_notified_count).toBe(0)
    expect(fixture.match_status).toBe('in_progress')

    await pom.placeTrigger(fixture.id).click()
    await pom.placeSave(fixture.id).click()

    // The consequence gate is up — the CALL copy names the destination and the
    // confirm states the consequence — and NOTHING has been sent yet.
    await expect(pom.callDialog).toBeVisible()
    await expect(pom.callDialog).toContainText('placing a match calls it')
    await expect(pom.callDialog).toContainText('will be notified')
    await expect(pom.callDialog).toContainText('T1 at 09:00')
    await expect(pom.callDialogConfirm).toHaveText('Call the match')
    expect(placementPatches()).toHaveLength(0)

    await expectAxeClean(page, 'schedule tab — call confirm dialog open')

    await pom.callDialogConfirm.click()

    // The PATCH landed, the server pinned in the same write, and the refetched
    // row wears the called-at badge — the count is the server's, never guessed.
    // The badge's minute is the pin's own stamp (the server's "now" at click
    // time), so the assertion is the CLAIM — a call went out — not the clock.
    await expect(pom.calledBadge(fixture.id)).toBeVisible()
    await expect(pom.calledBadge(fixture.id)).toContainText('Called')
    expect(placementPatches()).toHaveLength(1)
    const told = store.fixturesOf(EVENT.JOURNEY).find((f) => f.id === fixture.id)!
    expect(told.pinned_at).not.toBeNull()
    expect(told.call_notified_count).toBe(1)

    // Moving the now-TOLD fixture meets the STRONGER copy: what the players were
    // told, what the calls have already cost, and a correction-stating confirm.
    await pom.placeTrigger(fixture.id).click()
    await pom.placeTime(fixture.id).fill('10:30')
    await pom.placeSave(fixture.id).click()

    await expect(pom.callDialog).toBeVisible()
    await expect(pom.callDialog).toContainText('were told T1 at 09:00')
    await expect(pom.callDialog).toContainText('T1 at 10:30')
    await expect(pom.callDialog).toContainText('notified 1× already')
    await expect(pom.callDialogConfirm).toHaveText('Move and notify')

    await expectAxeClean(page, 'schedule tab — correction confirm dialog open')

    await pom.callDialogConfirm.click()

    // The correction went out: the server counts 2, and past the first call the
    // row's own `notified n×` marker comes up beside the badge.
    await expect(pom.notifiedMarkers.first()).toBeVisible()
    await expect(pom.notifiedMarkers.first()).toContainText('notified 2×')
    expect(
      store.fixturesOf(EVENT.JOURNEY).find((f) => f.id === fixture.id)!
        .call_notified_count,
    ).toBe(2)

    // Nothing fell through to an unmocked route along the way.
    expect(store.unhandled).toHaveLength(0)
  })

  test('keyboard: Tab reaches a bar and its tooltip opens with the match details', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, DRAWN_SEED)
    await pom.openScheduleTab()
    await pom.runScheduler.click()
    await expect(pom.solveStripState('succeeded')).toBeVisible({ timeout: 15_000 })

    await pom.setScheduleView('Gantt')
    await expect(pom.timelineBars.first()).toBeVisible()

    // The chart region itself is in the tab order (a keyboard user must be able
    // to scroll it); one more Tab lands on the first bar, and focus opens its
    // tooltip.
    await pom.ganttRegion.focus()
    await page.keyboard.press('Tab')
    await expect(pom.timelineBars.first()).toBeFocused()
    await expect(pom.matchTooltip).toBeVisible()
    // The details a director hovers for, reachable without a pointer: pairing,
    // event, table + time, and how firm the time is.
    await expect(pom.matchTooltip).toContainText(' vs ')
    await expect(pom.matchTooltip).toContainText('Estimate — the scheduler may still move it')
  })

  test('on a phone the boards scroll inside their own container — the page never scrolls sideways', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const { pom } = await TournamentDetailPage.navigateTo(page, DRAWN_SEED)
    await pom.openScheduleTab()
    await pom.runScheduler.click()
    await expect(pom.solveStripState('succeeded')).toBeVisible({ timeout: 15_000 })

    await pom.setScheduleView('Gantt')
    await expect(pom.timelineBars.first()).toBeVisible()

    // The page itself holds the line…
    await expectNoHorizontalScroll(page.locator('html'), 'the page under the Gantt')
    // …because the chart region is the thing that scrolls (it genuinely
    // overflows on 390px — otherwise this asserts nothing).
    const region = pom.ganttRegion
    const overflow = await region.evaluate((el) => el.scrollWidth - el.clientWidth)
    expect(overflow).toBeGreaterThan(0)
    // And it is reachable: a keyboard user can focus the region to scroll it.
    await expect(region).toHaveAttribute('tabindex', '0')

    await expectAxeClean(page, 'schedule tab — Gantt view on a phone viewport')
  })
})
