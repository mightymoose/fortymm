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
