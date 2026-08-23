/**
 * The event editor lives in the URL, and browser **Back** dismisses it (#1503).
 *
 * What only a browser can prove here, and jsdom cannot:
 *
 *   1. **There is a Back button at all.** jsdom has no history a user can pop, so the
 *      reported defect — Back leaves `/tournaments` and takes the dirty form with it —
 *      is unobservable there.
 *   2. **"Keep editing" restores the history entry.** A browser Back COMMITS the pop
 *      before the blocker resolves; `@tanstack/history` puts it back with
 *      `history.go(1)` when the blocker says stay. Whether the second Back press asks
 *      again — rather than leaving the page with the editor open — is a claim about the
 *      real session history.
 *   3. **A deep link closes by REPLACE, not by pop.** On an entry the application did
 *      not push there is nothing behind it, so a pop would take the director out of the
 *      site entirely.
 */
import { expect, test, type Page } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import {
  EVENT,
  TOURNAMENT_ID,
} from '../page-objects/tournaments/tournaments-store'

const TOURNAMENT_URL = `/tournaments/${TOURNAMENT_ID}`
/** A well-formed uuid that names no event on this tournament. */
const UNKNOWN_EVENT = '00000000-0000-4000-8000-000000000009'

/** The confirmation's own words, hard-coded test-side: importing them from the
 * component would make every assertion below pass whatever the copy became. */
const DISCARD = {
  title: 'Discard changes?',
  stay: 'Keep editing',
  leave: 'Discard & leave',
} as const

/**
 * Press Back the way the chrome does.
 *
 * `window.history.back()` rather than `page.goBack()`: a BLOCKED back is reverted by
 * `history.go(1)` inside the same task, so Playwright's navigation bookkeeping has no
 * settled navigation to resolve against and the call can hang. This fires the identical
 * browser API the Back button fires, and every assertion after it auto-retries.
 */
const pressBack = (page: Page) => page.evaluate(() => window.history.back())

/** The `?event=` value currently in the address bar, or `null`. */
const eventParam = (page: Page) =>
  new URL(page.url()).searchParams.get('event')

test.describe('Tournaments · the event editor is a URL, and Back dismisses it', () => {
  test('opening an event writes its id into the URL', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)

    await pom.openEditor(EVENT.JOURNEY)

    await expect(pom.eventEditor).toBeVisible()
    await expect(page).toHaveURL(/[?&]event=[0-9a-f-]{36}/)
  })

  test('Back closes a CLEAN editor and stays on the tournament', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)
    await pom.openEditor(EVENT.JOURNEY)
    await expect(pom.eventEditor).toBeVisible()

    await pressBack(page)

    // The sheet goes, the param goes, and the page does NOT: the reported defect was
    // landing back on the tournaments list with the editor's work gone.
    await expect(pom.eventEditor).toHaveCount(0)
    await expect(page).toHaveURL(TOURNAMENT_URL)
  })

  test('Back on a DIRTY editor asks first, and Keep editing survives a second Back', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)
    await pom.openEditor(EVENT.JOURNEY)
    await pom.eventNameInput.fill('Open Singles (renamed)')

    await pressBack(page)

    // Nothing has closed yet, and nothing has navigated. The sheet is read by TEST
    // ID rather than by role: the confirmation on top is modal, so Radix
    // `aria-hidden`s the rest of the document and a role query cannot see the sheet
    // underneath — which would read as "the editor closed".
    await expect(page.getByRole('alertdialog')).toContainText(DISCARD.title)
    await expect(page.getByTestId('event-editor-body')).toBeAttached()

    await page.getByRole('button', { name: DISCARD.stay }).click()

    // The entry is BACK. Without it the next press leaves the page with the sheet
    // still open — the failure mode this whole criterion exists for.
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(pom.eventEditor).toBeVisible()
    expect(eventParam(page)).not.toBeNull()
    await expect(pom.eventNameInput).toHaveValue('Open Singles (renamed)')

    await pressBack(page)
    await expect(page.getByRole('alertdialog')).toContainText(DISCARD.title)

    await page.getByRole('button', { name: DISCARD.leave }).click()

    await expect(pom.eventEditor).toHaveCount(0)
    await expect(page).toHaveURL(TOURNAMENT_URL)
  })

  test('Escape and Cancel raise the same confirmation while the form is dirty', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)
    await pom.openEditor(EVENT.JOURNEY)
    await pom.eventNameInput.fill('Open Singles (renamed)')

    await page.keyboard.press('Escape')
    await expect(page.getByRole('alertdialog')).toContainText(DISCARD.title)
    await page.getByRole('button', { name: DISCARD.stay }).click()
    await expect(pom.eventEditor).toBeVisible()


    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('alertdialog')).toContainText(DISCARD.title)
    await page.getByRole('button', { name: DISCARD.leave }).click()

    await expect(pom.eventEditor).toHaveCount(0)
    await expect(page).toHaveURL(TOURNAMENT_URL)
  })

  test('a clean editor closes silently on Cancel and consumes its history entry', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)
    await pom.openEditor(EVENT.JOURNEY)
    await expect(pom.eventEditor).toBeVisible()

    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(pom.eventEditor).toHaveCount(0)
    await expect(page).toHaveURL(TOURNAMENT_URL)
  })

  test('a deep link opens the editor on first render and closes by replacing the entry', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)
    // Learn a real event id the way a shared link carries one.
    await pom.openEditor(EVENT.JOURNEY)
    await expect(pom.eventEditor).toBeVisible()
    const eventId = eventParam(page)
    expect(eventId).not.toBeNull()

    // A fresh load straight onto the editor — no in-app entry behind it.
    await page.goto(`${TOURNAMENT_URL}?event=${eventId}`)
    await expect(pom.eventEditor).toBeVisible()
    await expect(pom.eventNameInput).toHaveValue(EVENT.JOURNEY)

    await page.getByRole('button', { name: 'Cancel' }).click()

    // Replaced, not popped: the director is still on the tournament rather than off
    // the site altogether.
    await expect(pom.eventEditor).toHaveCount(0)
    await expect(page).toHaveURL(TOURNAMENT_URL)
    await expect(pom.eventCard(EVENT.JOURNEY)).toBeVisible()
  })

  test('a uuid that names no event on this tournament leaves the editor closed', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)

    await page.goto(`${TOURNAMENT_URL}?event=${UNKNOWN_EVENT}`)

    await expect(pom.eventCard(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.eventEditor).toHaveCount(0)
  })

  test('a value that is neither a uuid nor `new` leaves the editor closed', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)

    await page.goto(`${TOURNAMENT_URL}?event=not-a-uuid`)

    await expect(pom.eventCard(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.eventEditor).toHaveCount(0)
  })

  test('`?event=new` opens the unsaved editor for an owner', async ({ page }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page)

    await page.goto(`${TOURNAMENT_URL}?event=new`)

    await expect(pom.eventEditor).toBeVisible()
    await expect(page.getByTestId('event-editor-overline')).toHaveText('New event')
  })

  test('`?event=new` leaves the editor closed for a viewer who cannot edit', async ({
    page,
  }) => {
    const { pom } = await TournamentDetailPage.navigateTo(page, { canEdit: false })

    await page.goto(`${TOURNAMENT_URL}?event=new`)

    await expect(pom.eventCard(EVENT.JOURNEY)).toBeVisible()
    await expect(pom.eventEditor).toHaveCount(0)
  })
})
