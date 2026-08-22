/**
 * The two confirm dialogs, against a tournament name with **no break opportunity in
 * it** (#1417).
 *
 * Quinn opened the delete confirmation for a 120-character unbroken tournament name at
 * 1280x800 and the Cancel and Delete buttons were not on the screen: Cancel at x=2158,
 * Delete at x=2244. The dialog's own box stayed 420px wide. Only its buttons left.
 *
 * ## The mechanism
 *
 * `DialogContent` and `AlertDialogContent` are both a CSS grid with a fixed
 * `w-[420px]`. A grid's automatic column track takes its base size from the content's
 * **min-content** width, and an unbroken 255-character word has a min-content width of
 * its whole rendered length — about 2000px. So the track overflowed the box, the footer
 * sat in that same track, and `sm:justify-end` pinned the buttons to the track's far
 * right edge rather than the box's.
 *
 * ## Why `wrap-anywhere` and not `break-words`
 *
 * `overflow-wrap: break-word` (Tailwind's `break-words`) is defined **not** to
 * contribute soft-wrap opportunities to intrinsic min-content sizing. It lets a long
 * word wrap inside a box already sized, and leaves the box's min-content width alone —
 * which is the only number this bug is about. `overflow-wrap: anywhere` (Tailwind's
 * `wrap-anywhere`) does contribute them, so it collapses the track's min-content width
 * to one glyph and the footer stays in the box.
 *
 * Measured at both viewports with the 255-character `UNBREAKABLE_TOURNAMENT_NAME`, as
 * the right-hand edge of the delete dialog's Delete button:
 *
 * | Primitive class string | Delete ends at, 1280x800 | Delete ends at, 375x667 |
 * | --- | --- | --- |
 * | unfixed | 2267px | 1871px |
 * | `min-w-0 break-words` added | 2267px — unchanged, the bug survives | 1871px — unchanged |
 * | `min-w-0 wrap-anywhere` added | 823px, on screen | 333px, on screen |
 *
 * The `break-words` row is not a guess. It was run, and it reported the same four
 * failures with the same four numbers as the unfixed tree.
 *
 * `min-w-0` earns nothing here and is kept only because it is harmless: the container is
 * fixed-width, so its own min-width never sizes the track. `wrap-anywhere` is the whole
 * fix.
 *
 * ## Observed failing
 *
 * Reverting the two class strings reds **four** of the eight tests below, each with a
 * measured coordinate and none by timeout. Measured on darwin, at the FIRST assertion
 * each test makes (the second never runs, which is why the table names Cancel and Go
 * back rather than the confirm buttons):
 *
 * | Test | Under the revert | With the fix |
 * | --- | --- | --- |
 * | delete dialog, desktop, Cancel | ends 2195px from the left, past the 1280px viewport | ends at 717 |
 * | delete dialog, phone, Cancel | ends 1888px from the left, past the 375px viewport | ends at 331 |
 * | publish confirm, desktop, Go back | ends 2102px from the left, past the 1280px viewport | ends at 625 |
 * | publish confirm, phone, Go back | ends 1888px from the left, past the 375px viewport | ends at 333 |
 *
 * The four **dialog-box** tests are green in both states, deliberately. The ticket's
 * Constraints forbid widening the box, and the box was never what overflowed — those
 * tests guard the fix rather than prove it. Under the revert the delete dialog measures
 * 404px at 1280 and 336px at 375, inside its bound in both.
 *
 * ## Everything is scoped to the dialog
 *
 * No assertion here measures `documentElement`. Both dialogs portal to the body, so
 * nothing about them is affected by #1361 (the shared `TabsList` is `inline-flex w-fit`
 * and puts 377px in a 375px viewport on Linux), and scoping keeps that known defect out
 * of this file's reds. It also means this file needs no `test.fail()` marks.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'

import { UNBREAKABLE_TOURNAMENT_NAME } from '../../src/mocks/factories/tournaments/tournament.factory'
import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import { TournamentsListPage } from '../page-objects/tournaments/tournaments-list.page'
import { expectOnScreen } from '../support/viewport'

/** The desktop Quinn measured the defect at, and the config's own default. */
const DESKTOP = { width: 1280, height: 800 }

/** The repo's established phone viewport — `app-shell.spec.ts`,
 * `tournament-mobile-header.spec.ts` and `design-system.spec.ts` all use it. It is also
 * where the footer stacks (`flex-col-reverse`), so both buttons share one right edge and
 * leave together. */
const PHONE = { width: 375, height: 667 }

/**
 * Wait for the **webfonts to settle** before measuring.
 *
 * Every number below is the box around some text, and `src/index.css` fetches Bebas Neue
 * and Space Grotesk from `fonts.googleapis.com` with `display=swap`. The store's
 * `page.route` covers the API only, so the first paint uses a fallback face with
 * different metrics. `document.fonts.ready` settles on failure as well as on success, so
 * this makes the measurement deterministic rather than making it depend on Google.
 */
async function fontsReady(page: Page) {
  await page.evaluate(() => document.fonts.ready)
}

/**
 * The dialog's own box stays within its declared bound.
 *
 * The bound is `min(420, innerWidth - 32)`, not a flat 420: `w-[420px]
 * max-w-[calc(100%-2rem)]` means the cap at 1280 is 420 and the cap at 375 is 343. A
 * flat `<= 420` would pass at 375 against a 400px box, which is a real defect.
 *
 * This is the assertion that catches a "fix" that widened the box instead of wrapping
 * the content. The ticket's Constraints forbid that.
 */
async function expectPanelWithinItsBound(page: Page, panel: Locator, what: string) {
  const viewport = page.viewportSize()
  expect(viewport, 'the test must set a viewport size').not.toBeNull()
  if (!viewport) return

  const box = await panel.boundingBox()
  expect(box, `${what} should have a bounding box`).not.toBeNull()
  if (!box) return

  const bound = Math.min(420, viewport.width - 32)
  expect(
    Math.round(box.width),
    `${what} is ${Math.round(box.width)}px wide, past its ${bound}px bound in a ${viewport.width}px viewport`,
  ).toBeLessThanOrEqual(bound)
}

/** Open `/tournaments` seeded with the unbreakable name, and press the delete control on
 * that tournament's card. The control's accessible name carries the whole 255-character
 * name (`aria-label={`Delete ${t.name}`}`), so the locator is unambiguous by
 * construction. */
async function openDeleteDialog(page: Page) {
  await TournamentsListPage.navigateTo(page, { longName: true })
  await fontsReady(page)

  const deleteControl = page.getByRole('button', {
    name: `Delete ${UNBREAKABLE_TOURNAMENT_NAME}`,
  })
  // Asserted as its own step: the control is gated on `canEdit`, and a dialog that never
  // opened would red the geometry assertions with "not visible" — which proves nothing
  // about layout.
  await expect(deleteControl, 'the card\'s delete control').toBeVisible()
  await deleteControl.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await fontsReady(page)
  return dialog
}

/** Open the tournament detail page as a draft seeded with the unbreakable name, and
 * press Publish — the header button that opens `ConfirmIrreversibleActDialog`. */
async function openIrreversibleActDialog(page: Page) {
  const { pom } = await TournamentDetailPage.navigateTo(page, {
    longName: true,
    status: 'draft',
  })
  await fontsReady(page)

  await pom.lifecycleButton('Publish').click()

  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await fontsReady(page)
  return { pom, dialog }
}

test.describe('the delete confirmation, desktop', () => {
  test.use({ viewport: DESKTOP })

  test('keeps Cancel and Delete wholly on screen', async ({ page }) => {
    const dialog = await openDeleteDialog(page)

    await expectOnScreen(
      page,
      dialog.getByRole('button', { name: 'Cancel' }),
      "the delete dialog's Cancel button",
    )
    await expectOnScreen(
      page,
      dialog.getByRole('button', { name: 'Delete' }),
      "the delete dialog's Delete button",
    )
  })

  test('keeps the dialog box inside its own width bound', async ({ page }) => {
    const dialog = await openDeleteDialog(page)

    await expectPanelWithinItsBound(page, dialog, 'the delete dialog')
  })
})

test.describe('the delete confirmation, phone', () => {
  test.use({ viewport: PHONE })

  test('keeps Cancel and Delete wholly on screen', async ({ page }) => {
    const dialog = await openDeleteDialog(page)

    await expectOnScreen(
      page,
      dialog.getByRole('button', { name: 'Cancel' }),
      "the delete dialog's Cancel button",
    )
    await expectOnScreen(
      page,
      dialog.getByRole('button', { name: 'Delete' }),
      "the delete dialog's Delete button",
    )
  })

  test('keeps the dialog box inside its own width bound', async ({ page }) => {
    const dialog = await openDeleteDialog(page)

    await expectPanelWithinItsBound(page, dialog, 'the delete dialog')
  })
})

test.describe('the irreversible-act confirmation, desktop', () => {
  test.use({ viewport: DESKTOP })

  test('keeps Go back and the confirm button wholly on screen', async ({ page }) => {
    const { pom, dialog } = await openIrreversibleActDialog(page)

    await expectOnScreen(
      page,
      dialog.getByTestId('confirm-irreversible-act-cancel'),
      "the publish confirm's Go back button",
    )
    await expectOnScreen(
      page,
      pom.irreversibleActConfirmButton,
      "the publish confirm's Publish the tournament button",
    )
  })

  test('keeps the dialog box inside its own width bound', async ({ page }) => {
    const { dialog } = await openIrreversibleActDialog(page)

    await expectPanelWithinItsBound(page, dialog, 'the publish confirm dialog')
  })
})

test.describe('the irreversible-act confirmation, phone', () => {
  test.use({ viewport: PHONE })

  test('keeps Go back and the confirm button wholly on screen', async ({ page }) => {
    const { pom, dialog } = await openIrreversibleActDialog(page)

    await expectOnScreen(
      page,
      dialog.getByTestId('confirm-irreversible-act-cancel'),
      "the publish confirm's Go back button",
    )
    await expectOnScreen(
      page,
      pom.irreversibleActConfirmButton,
      "the publish confirm's Publish the tournament button",
    )
  })

  test('keeps the dialog box inside its own width bound', async ({ page }) => {
    const { dialog } = await openIrreversibleActDialog(page)

    await expectPanelWithinItsBound(page, dialog, 'the publish confirm dialog')
  })
})
