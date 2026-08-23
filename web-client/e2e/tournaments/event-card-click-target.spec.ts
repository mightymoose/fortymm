/**
 * The event card's open target, at the pixels a director actually clicks (#1503).
 *
 * The Events tab header invites the organizer to "Click any event to edit", and two
 * regions of the card refused that click: the closed-registration notice in the action
 * column, and the "No draw yet." empty state in the draw panel. Both are inert
 * `LeadReason` copy that rides a `relative z-10` layer, so it covered the stretched
 * open target — a **sibling** `<button>` — with no handler of its own.
 *
 * ⚠️ **Every assertion here clicks a COORDINATE, never a locator.** Playwright's
 * `locator.click()` runs a hit-target check, and `pointer-events: none` is exactly what
 * makes that check resolve the point to the sibling button — so the call would throw
 * against the FIXED code and time out against the broken code. A spec that reds in both
 * states, for two different reasons, proves nothing
 * (`.claude/rules/verify-the-artifact-under-test.md`). `page.mouse.click()` at the
 * notice's own centre asks the only question this ticket is about: what does a click at
 * these pixels reach.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import { EVENT } from '../page-objects/tournaments/tournaments-store'

/** Click the centre of whatever box this locator paints. The whole point of the
 * spec: the hit target is decided by the browser, not by Playwright's actionability
 * check. */
async function clickCentreOf(page: Page, locator: Locator) {
  await expect(locator).toBeVisible()
  // `boundingBox()` is viewport-relative and `page.mouse` takes viewport
  // coordinates, so a target below the fold would be "clicked" at a point off the
  // screen — a red that says nothing about the hit target.
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  expect(box, 'the notice must have a layout box to click').not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

test.describe('Tournaments · the event card takes the click it advertises', () => {
  test('clicking the closed-registration notice opens that event\'s editor', async ({
    page,
  }) => {
    // `draft` is the status whose registration window has not opened, so the action
    // column renders the notice instead of an Enter button.
    const { pom } = await TournamentDetailPage.navigateTo(page, { status: 'draft' })

    const notice = pom.registrationNotice(EVENT.JOURNEY)
    await expect(notice).toContainText('Entry opens when this tournament is published.')

    await clickCentreOf(page, notice)

    await expect(pom.eventEditor).toBeVisible()
    await expect(pom.eventNameInput).toHaveValue(EVENT.JOURNEY)
  })

  test('clicking the "No draw yet." empty state opens that event\'s editor', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)

    const empty = pom.drawEmpty(EVENT.JOURNEY)
    await expect(empty).toContainText('No draw yet.')

    await clickCentreOf(page, empty)

    await expect(pom.eventEditor).toBeVisible()
    await expect(pom.eventNameInput).toHaveValue(EVENT.JOURNEY)
  })

  test('the Enter button still takes its own click', async ({ page }) => {
    // `published` — the window is open, so this card carries a real Enter button in
    // the same raised slot the notice rides.
    const { pom } = await TournamentDetailPage.navigateTo(page)

    await clickCentreOf(page, pom.enterButton(EVENT.JOURNEY))

    // The entry lands, and the editor never opens: a control in the raised layer is
    // still a control, not a way into the editor.
    await expect(pom.withdrawButton(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.eventEditor).toHaveCount(0)
  })

  test('the draw panel\'s Generate control still takes its own click', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, { drawable: true })

    await clickCentreOf(page, pom.generateDrawButton(EVENT.GROUPS))

    // The draw is cut, and the editor never opens.
    await expect(pom.drawEmpty(EVENT.GROUPS)).toHaveCount(0)
    await expect(pom.eventEditor).toHaveCount(0)
  })

  test('a click on a CUT draw is still a click on the draw, not a way into the editor', async ({
    page,
  }) => {
    // The other half of the panel's rule (ADR-0786). Only the `undrawn` state stands
    // aside; a cut draw takes its whole box exactly as it does today, so a director
    // reading the fixtures cannot knock the editor open on a stray click. The ternary
    // in `DrawPanel` is one keystroke from inverting, and this is the assertion that
    // notices.
    const { pom } = await TournamentDetailPage.navigateTo(page, { drawable: true })
    await pom.generateDrawButton(EVENT.GROUPS).click()
    await expect(pom.drawEmpty(EVENT.GROUPS)).toHaveCount(0)

    await clickCentreOf(page, pom.fixtureLines(EVENT.GROUPS).first())

    // Proving a NON-event needs a bounded wait. Opening the editor is a URL write, so
    // wait for one and require that none arrives — `toHaveCount(0)` on its own is
    // satisfied by its FIRST poll and passes just as happily against a card that is
    // about to open the sheet a tick later. Measured, not assumed: with `DrawPanel`'s
    // ternary inverted this click opens the editor, and only this wait sees it.
    await expect(page.waitForURL(/[?&]event=/, { timeout: 2000 })).rejects.toThrow()
    await expect(pom.eventEditor).toHaveCount(0)
  })
})
