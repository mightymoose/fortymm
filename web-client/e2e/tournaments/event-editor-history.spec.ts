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

/** Press Back the way the chrome does. */
const pressBack = (page: Page) => page.goBack()

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

  test('a close the director backs out of STILL consumes the entry when it finally happens', async ({
    page,
  }) => {
    // The criterion is "closing the editor by any path consumes its history entry, so
    // the next Back press leaves the tournament page" — and a close can be REFUSED on
    // the way there. A first Cancel is blocked and the director keeps editing; the
    // pushed entry is still underneath them, so the close that eventually lands must
    // still pop it rather than replace the entry it is sitting on.
    //
    // Asserting the URL after the close cannot see this: a `replace` leaves exactly the
    // same address bar and strands the pushed entry, so the next Back lands the director
    // straight back on the same tournament page. Only the press afterwards discriminates.
    const { pom } = await TournamentDetailPage.navigateTo(page)
    // Something in front of the tournament, the way arriving from the list gives it —
    // otherwise "Back leaves the page" has nowhere to leave to.
    await page.goto('/tournaments')
    await page.goto(TOURNAMENT_URL)
    await expect(pom.eventCard(EVENT.JOURNEY)).toBeVisible()

    await pom.openEditor(EVENT.JOURNEY)
    await pom.eventNameInput.fill('Open Singles (renamed)')

    // Refused once…
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('alertdialog')).toContainText(DISCARD.title)
    await page.getByRole('button', { name: DISCARD.stay }).click()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(pom.eventEditor).toBeVisible()

    // …and then allowed.
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('alertdialog')).toContainText(DISCARD.title)
    await page.getByRole('button', { name: DISCARD.leave }).click()
    await expect(pom.eventEditor).toHaveCount(0)
    await expect(page).toHaveURL(TOURNAMENT_URL)

    // The claim. One press, and the director is off the tournament page.
    await pressBack(page)
    await expect(page).toHaveURL('/tournaments')
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

  test('an event just CREATED can be opened again — its new id survives the boundary', async ({
    page,
  }) => {
    // The editor is a URL now, so the id of a brand-new event is load-bearing in a way
    // it never was: it goes in the address bar, and `?event=` is parsed as a uuid at the
    // route boundary. An id that fails that parse is dropped by `.catch({})`.
    //
    // ⚠️ The RELOAD is what makes this discriminating, and the URL shape alone is not.
    // An in-app `navigate` carries its search object through without re-running
    // `validateSearch`, so clicking the card opens the editor even on an id the boundary
    // would refuse — measured. Only a fresh parse of the address bar asks the boundary
    // anything, which is exactly the criterion at stake: "the URL is shareable and
    // survives a reload". Nothing else in this suite re-opens a created event.
    const { pom } = await TournamentDetailPage.navigateTo(page)

    await pom.newEventButton.click()
    await expect(pom.eventEditor).toBeVisible()
    await pom.eventNameInput.fill('Twilight Singles')
    await pom.saveEventButton.click()
    await expect(pom.eventEditor).toBeHidden()
    await expect(pom.eventCard('Twilight Singles')).toBeVisible()

    await pom.openEditor('Twilight Singles')

    await expect(pom.eventEditor).toBeVisible()
    await expect(pom.eventNameInput).toHaveValue('Twilight Singles')
    await expect(page).toHaveURL(/[?&]event=[0-9a-f-]{36}/)

    await page.reload()

    // Still open, on the same event: the id in the address bar is one the boundary
    // accepts, so the link a director could paste to somebody else works.
    await expect(pom.eventEditor).toBeVisible()
    await expect(pom.eventNameInput).toHaveValue('Twilight Singles')
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
