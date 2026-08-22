/**
 * The two confirm dialogs, against a tournament name with **no break opportunity in
 * it** (#1417).
 *
 * Quinn opened the delete confirmation for a 120-character unbroken tournament name at
 * 1280x800 and the Cancel and Delete buttons were not on the screen. The dialog's own
 * box stayed 420px wide. Only its buttons left.
 *
 * ## The mechanism
 *
 * `DialogContent` and `AlertDialogContent` are both a CSS grid with a fixed
 * `w-[420px]`. A grid's automatic column track takes its base size from the content's
 * **min-content** width, and an unbroken 255-character word has a min-content width of
 * its whole rendered length — 1847px, measured. So the track overflowed the box, the
 * footer sat in that same track, and `sm:justify-end` pinned the buttons to the track's
 * far right edge rather than the box's.
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
 * All three states were **measured**, with the 255-character
 * `UNBREAKABLE_TOURNAMENT_NAME`, after the `zoom-in-95` entrance had settled:
 *
 * | Primitive class string | Delete's right edge, 1280x800 | Delete's right edge, 375x667 | Description box |
 * | --- | --- | --- | --- |
 * | unfixed | 2302px | 1888px | 1847px wide, 42px tall |
 * | `min-w-0 break-words` added | 2302px | 1888px | 1847px wide, 42px tall |
 * | `min-w-0 wrap-anywhere` added | 825px | 334px | 370px wide, 126px tall |
 *
 * The `break-words` row is not inferred. It was run, and all sixteen of the probe's
 * numbers came back identical to the unfixed tree's, to the pixel. `break-words`
 * changes nothing about this defect.
 *
 * `min-w-0` earns nothing here and is kept only because it is harmless: the container
 * is fixed-width, so its own min-width never sizes the track. `wrap-anywhere` is the
 * whole fix.
 *
 * ## Observed failing
 *
 * Reverting the two class strings reds **eight** of the twelve tests below, each with a
 * measured number and none by timeout. Measured on darwin, at the FIRST assertion each
 * test makes — which is why the coordinate rows name Cancel and Go back rather than the
 * confirm buttons beside them:
 *
 * | Test | Under the revert | With the fix |
 * | --- | --- | --- |
 * | delete dialog, desktop, Cancel on screen | ends 2195px from the left, past the 1280px viewport | ends at 718 |
 * | delete dialog, phone, Cancel on screen | ends 1888px from the left, past the 375px viewport | ends at 334 |
 * | publish confirm, desktop, Go back on screen | ends 2102px from the left, past the 1280px viewport | ends at 625 |
 * | publish confirm, phone, Go back on screen | ends 1888px from the left, past the 375px viewport | ends at 334 |
 * | delete dialog, desktop, name wraps | 42px tall, 2 lines of 21px | 126px, 6 lines |
 * | delete dialog, phone, name wraps | 42px tall, 2 lines | 168px, 8 lines |
 * | publish confirm, desktop, name wraps | 63px tall, 3 lines | 189px, 9 lines |
 * | publish confirm, phone, name wraps | 63px tall, 3 lines | 231px, 11 lines |
 *
 * The four **dialog-box** tests are green in all three states, deliberately. The
 * ticket's Constraints forbid widening the box, and the box was never what overflowed —
 * those tests guard the fix rather than prove it. The panel measures exactly 420px at
 * 1280 and exactly 343px at 375 whether the fix is in or out.
 *
 * ## Why the wrap tests exist, beside the coordinate ones
 *
 * A fix that put `truncate` on the description would pass every coordinate assertion
 * here, and would pass the vitest full-string assertion too — `overflow: hidden` hides
 * text from the user, not from the DOM. So the coordinate tests alone cannot tell this
 * fix from one that shortens the name, which criterion 4 forbids.
 * `tournament-mobile-header.spec.ts` says the same thing about the `h1` and answers it
 * the same way: measure the box's height in lines, and check nothing is clipped out of
 * it.
 *
 * That was falsified too, and not only reasoned about. Adding `truncate` to both
 * description class strings, on top of the real fix, reds all four wrap tests at
 * `21px tall — 1.0 lines of 21px` — and reds the four coordinate tests as well, harder
 * than the original bug did (Cancel at 2454px), because `truncate` carries
 * `whitespace-nowrap` and hands the track its min-content width straight back.
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
import { expectNoHorizontalScroll, expectOnScreen } from '../support/viewport'

/** The desktop Quinn measured the defect at, and the config's own default. */
const DESKTOP = { width: 1280, height: 800 }

/** The repo's established phone viewport — `app-shell.spec.ts`,
 * `tournament-mobile-header.spec.ts` and `design-system.spec.ts` all use it. It is also
 * where the footer stacks (`flex-col-reverse`), so both buttons share one right edge and
 * leave together. */
const PHONE = { width: 375, height: 667 }

/**
 * How many lines of its own leading the description must occupy before this file calls
 * the name **wrapped**.
 *
 * Four, and the margin either side of it is wide. Under the revert the description is
 * two lines in the delete dialog and three in the publish confirm — the name lays out on
 * one 1847px line and only the surrounding sentence wraps. With the fix the thinnest of
 * the four cases is six lines and the widest is eleven. A `truncate` "fix" would be one.
 */
const WRAPPED_LINES = 4

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
 * Measured with `offsetWidth`, and NOT with `boundingBox()`. The difference is not a
 * preference: `data-open:zoom-in-95` scales the panel on the way in, `boundingBox()`
 * reflects CSS transforms, and a reading taken mid-entrance comes back at 97.9% of the
 * true width — 411 against a 420px bound. That is a 2% blind spot on the one assertion
 * whose whole job is to catch a box someone widened. `offsetWidth` is layout, and a
 * transform moves a box without resizing its layout box, so it reports 420 and 343
 * exactly. `expectNoHorizontalScroll` states the same distinction in `support/viewport.ts`.
 *
 * This is the assertion that catches a "fix" that widened the box instead of wrapping
 * the content. The ticket's Constraints forbid that.
 */
async function expectPanelWithinItsBound(page: Page, panel: Locator, what: string) {
  const viewport = page.viewportSize()
  expect(viewport, 'the test must set a viewport size').not.toBeNull()
  if (!viewport) return

  const width = await panel.evaluate((el) => (el as HTMLElement).offsetWidth)
  const bound = Math.min(420, viewport.width - 32)
  expect(
    width,
    `${what} is ${width}px wide, past its ${bound}px bound in a ${viewport.width}px viewport`,
  ).toBeLessThanOrEqual(bound)
}

/**
 * The name **wraps** across lines inside the dialog, and none of it is hidden.
 *
 * Three claims, because a shortening fix would satisfy fewer than three:
 *
 * 1. the description holds the whole 255-character name — the same claim the vitest
 *    file makes, restated here so a browser-only regression cannot slip past it;
 * 2. the box is at least `WRAPPED_LINES` lines of its own leading tall — `truncate`
 *    and `line-clamp-1` both make it one;
 * 3. nothing overflows the box in either direction — which is what separates "wrapped"
 *    from "clipped", since `overflow: hidden` keeps the box small by hiding the text
 *    rather than by laying it out.
 */
async function expectNameWrapsInFull(description: Locator, what: string) {
  await expect(description, `${what} should hold the whole name`).toContainText(
    UNBREAKABLE_TOURNAMENT_NAME,
  )

  const box = await description.evaluate((el) => ({
    lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight),
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }))

  const lines = box.clientHeight / box.lineHeight
  expect(
    lines,
    `${what} is ${box.clientHeight}px tall — ${lines.toFixed(1)} lines of ${box.lineHeight}px. The name is not wrapping`,
  ).toBeGreaterThanOrEqual(WRAPPED_LINES)

  // 1px of slack for sub-pixel layout rounding, as `expectNoHorizontalScroll` takes.
  expect(
    box.scrollHeight,
    `${what} hides ${box.scrollHeight - box.clientHeight}px of the name below its box — it is clipped, not wrapped`,
  ).toBeLessThanOrEqual(box.clientHeight + 1)
  // The horizontal half is exactly `expectNoHorizontalScroll` — same measurement, same
  // 1px slack — so it is called rather than re-written here. It adds a `scrollLeft === 0`
  // check this file did not make, which a description that is not overflowing satisfies
  // trivially.
  await expectNoHorizontalScroll(description, what)
}

/** Open `/tournaments` seeded with the unbreakable name, and press the delete control on
 * that tournament's card. The control's accessible name carries the whole 255-character
 * name (`aria-label={`Delete ${t.name}`}`), so the locator is unambiguous by
 * construction. */
async function openDeleteDialog(page: Page) {
  const { pom } = await TournamentsListPage.navigateTo(page, { longName: true })
  await fontsReady(page)

  const deleteControl = page.getByRole('button', {
    name: `Delete ${UNBREAKABLE_TOURNAMENT_NAME}`,
  })
  // Asserted as its own step: the control is gated on `canEdit`, and a dialog that never
  // opened would red the geometry assertions with "not visible" — which proves nothing
  // about layout.
  await expect(deleteControl, "the card's delete control").toBeVisible()
  await deleteControl.click()

  const dialog = pom.dialog
  await expect(dialog).toBeVisible()
  await fontsReady(page)
  return { dialog, description: dialog.locator('[data-slot="dialog-description"]') }
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
  return {
    pom,
    dialog,
    description: dialog.locator('[data-slot="alert-dialog-description"]'),
  }
}

for (const viewport of [DESKTOP, PHONE]) {
  const where = `${viewport.width}x${viewport.height}`

  test.describe(`the delete confirmation at ${where}`, () => {
    test.use({ viewport })

    test('keeps Cancel and Delete wholly on screen', async ({ page }) => {
      const { dialog } = await openDeleteDialog(page)

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

    test('wraps the whole name across lines rather than shortening it', async ({
      page,
    }) => {
      const { description } = await openDeleteDialog(page)

      await expectNameWrapsInFull(description, "the delete dialog's description")
    })

    test('keeps the dialog box inside its own width bound', async ({ page }) => {
      const { dialog } = await openDeleteDialog(page)

      await expectPanelWithinItsBound(page, dialog, 'the delete dialog')
    })
  })

  test.describe(`the irreversible-act confirmation at ${where}`, () => {
    test.use({ viewport })

    test('keeps Go back and the confirm button wholly on screen', async ({ page }) => {
      const { pom } = await openIrreversibleActDialog(page)

      await expectOnScreen(
        page,
        pom.irreversibleActCancelButton,
        "the publish confirm's Go back button",
      )
      await expectOnScreen(
        page,
        pom.irreversibleActConfirmButton,
        "the publish confirm's Publish the tournament button",
      )
    })

    test('wraps the whole name across lines rather than shortening it', async ({
      page,
    }) => {
      const { description } = await openIrreversibleActDialog(page)

      await expectNameWrapsInFull(description, "the publish confirm's description")
    })

    test('keeps the dialog box inside its own width bound', async ({ page }) => {
      const { dialog } = await openIrreversibleActDialog(page)

      await expectPanelWithinItsBound(page, dialog, 'the publish confirm dialog')
    })
  })
}
