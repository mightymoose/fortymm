import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import type { GalleryPage } from './pages/GalleryPage.ts'

// Checks `target` against the screenshot `name` in a step of its own. The
// check is soft, so a mismatch fails the journey but the journey still takes
// its later screenshots.
async function screenshotStep(
  title: string,
  target: Locator,
  name: string,
): Promise<void> {
  await test.step(title, async () => {
    await expect.soft(target).toHaveScreenshot(name)
  })
}

// Checks the whole viewport against the screenshot `name`, as
// screenshotStep() does, for an overlay: a raised toast, a tooltip, a dialog
// or a sheet. Each shows outside the example that opened it, and its shadow
// or backdrop reaches past its edges.
async function pageScreenshotStep(
  title: string,
  gallery: GalleryPage,
  name: string,
): Promise<void> {
  await test.step(title, async () => {
    await expect.soft(gallery.page).toHaveScreenshot(name)
  })
}

// Focuses `control` and checks it and its focus ring, which reaches 4px
// past its edges, against the screenshot `name`, as screenshotStep() does.
async function focusedScreenshotStep(
  title: string,
  control: Locator,
  name: string,
): Promise<void> {
  await test.step(title, async () => {
    await control.focus()
    const box = (await control.boundingBox())!
    const ring = 4
    await expect.soft(control.page()).toHaveScreenshot(name, {
      clip: {
        x: box.x - ring,
        y: box.y - ring,
        width: box.width + 2 * ring,
        height: box.height + 2 * ring,
      },
    })
  })
}

// Hovers `control` and checks it against the screenshot `name`, as
// screenshotStep() does.
async function hoveredScreenshotStep(
  title: string,
  control: Locator,
  name: string,
): Promise<void> {
  await test.step(title, async () => {
    await control.hover()
    await expect.soft(control).toHaveScreenshot(name)
  })
}

test('shows the Design System title', async ({ designSystemPage }) => {
  await designSystemPage.goto()

  await expect(designSystemPage.title).toHaveText('Design System')
})

test('shows no loading screen and checks no health', async ({
  designSystemPage,
  page,
}) => {
  const healthRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/health')) {
      healthRequests.push(request.url())
    }
  })

  await designSystemPage.goto()
  await expect(designSystemPage.title).toBeVisible()
  await page.waitForLoadState('networkidle')

  await expect(designSystemPage.loadingScreen).toHaveCount(0)
  expect(healthRequests).toEqual([])
})

// Each pair of tests below compares the app and the reference gallery with
// the same screenshot, so the two must render identically. Update a
// screenshot with `npx playwright test --update-snapshots` only when the
// reference itself changes, then run again without the flag: the update
// writes whichever page it checks last and never fails.
test.describe('title', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.title).toHaveScreenshot('title.png')
  })

  test("matches the gallery's title with the app's text", async ({
    designSystemPage,
    referenceKitPage,
  }) => {
    await designSystemPage.goto()
    const title = await designSystemPage.title.innerText()

    await referenceKitPage.goto()
    await referenceKitPage.setTitleText(title)

    await expect(referenceKitPage.title).toHaveScreenshot('title.png')
  })
})

// The intro uses the gallery's own copy, so it's compared with the gallery
// as is.
test.describe('intro', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.intro).toHaveScreenshot('intro.png')
  })

  test("matches the gallery's intro", async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.intro).toHaveScreenshot('intro.png')
  })
})

// Each section's journey takes the same screenshots on the app and then on
// the gallery, so each pair must render identically. It opens each section
// and example on its own with `only`, then takes its resting screenshot
// before anything is hovered or focused.
async function buttonsScreenshots(gallery: GalleryPage): Promise<void> {
  const buttons = gallery.buttons
  await gallery.goto(buttons.testId)
  await screenshotStep('heading', buttons.heading, 'buttons-heading.png')
  await screenshotStep('lead', buttons.lead, 'buttons-lead.png')

  await gallery.goto('ex-loading-and-disabled')
  await screenshotStep(
    'Loading and disabled',
    buttons.loadingAndDisabled,
    'buttons-loading-and-disabled.png',
  )
  await hoveredScreenshotStep(
    'Start match, hovered',
    buttons.button('Start match'),
    'button-disabled-hovered.png',
  )

  await gallery.goto('ex-variants')
  await screenshotStep('Variants', buttons.variants, 'buttons-variants.png')
  for (const [name, file] of [
    ['Call to table', 'primary'],
    ['Reschedule', 'secondary'],
    ['Print score sheet', 'ghost'],
    ['Withdraw player…', 'danger'],
  ]) {
    await hoveredScreenshotStep(
      `${name}, hovered`,
      buttons.button(name),
      `button-${file}-hovered.png`,
    )
  }
  await focusedScreenshotStep(
    'Call to table, focused',
    buttons.button('Call to table'),
    'button-primary-focused.png',
  )
  await gallery.showTooltip(buttons.button('More options'), 'More options')
  await pageScreenshotStep(
    'More options, tooltip shown',
    gallery,
    'buttons-more-options-tooltip.png',
  )
  await gallery.openWithdrawDialog(buttons.button('Withdraw player…'))
  await pageScreenshotStep(
    'Withdraw player…, dialog open',
    gallery,
    'buttons-withdraw-dialog.png',
  )

  await gallery.goto('ex-loading-and-disabled')
  await gallery.raiseToast(
    buttons.button('Save result'),
    'Result saved. Okafor-Adeyemi ▲ +9',
  )
  await pageScreenshotStep(
    'Save result, saved',
    gallery,
    'buttons-save-result-toast.png',
  )
}

test('the Buttons section matches its screenshots and the gallery', async ({
  designSystemPage,
  referenceKitPage,
}) => {
  await test.step('app', () => buttonsScreenshots(designSystemPage))
  await test.step('gallery', () => buttonsScreenshots(referenceKitPage))
})

async function fieldsScreenshots(gallery: GalleryPage): Promise<void> {
  const fields = gallery.fields
  await gallery.goto(fields.testId)
  await screenshotStep('heading', fields.heading, 'fields-heading.png')
  await screenshotStep('lead', fields.lead, 'fields-lead.png')

  await gallery.goto('ex-text-field')
  await screenshotStep('Text field', fields.textField, 'fields-text-field.png')
  // A focused invalid field keeps its red edge, icon and message.
  await fields.table.focus()
  await screenshotStep(
    'Text field, Table focused while invalid',
    fields.textField,
    'fields-text-field-invalid-focused.png',
  )

  await gallery.goto('ex-code-input')
  await screenshotStep('Code input', fields.codeInput, 'fields-code-input.png')
  await fields.typeCode('sp26rx')
  await screenshotStep(
    'Code input, unknown code',
    fields.codeInput,
    'fields-code-input-unknown.png',
  )
  await gallery.goto('ex-code-input')
  await fields.typeCode('sp26rv')
  await screenshotStep(
    'Code input, tournament found',
    fields.codeInput,
    'fields-code-input-found.png',
  )

  await gallery.goto('ex-combobox')
  await screenshotStep('Combobox', fields.combobox, 'fields-combobox.png')
  await fields.searchOpponent('ngu')
  await pageScreenshotStep('Combobox, "ngu" typed', gallery, 'fields-combobox-ngu.png')
  await gallery.page.keyboard.press('ArrowDown')
  await pageScreenshotStep(
    'Combobox, second match active',
    gallery,
    'fields-combobox-ngu-second.png',
  )
  await gallery.page.keyboard.press('Enter')
  await screenshotStep('Combobox, picked', fields.combobox, 'fields-combobox-picked.png')
  await fields.opponent.click()
  await pageScreenshotStep(
    'Combobox, reopened on the pick',
    gallery,
    'fields-combobox-reopened.png',
  )

  await gallery.goto('ex-date-picker')
  await screenshotStep('Date picker', fields.datePicker, 'fields-date-picker.png')
  await fields.openCalendar()
  await pageScreenshotStep('Date picker, open', gallery, 'fields-date-picker-open.png')
  await gallery.page.keyboard.press('ArrowRight')
  await pageScreenshotStep(
    'Date picker, a day on by keyboard',
    gallery,
    'fields-date-picker-day-moved.png',
  )
  await gallery.page.keyboard.press('PageDown')
  await pageScreenshotStep(
    'Date picker, a month on by keyboard',
    gallery,
    'fields-date-picker-month-moved.png',
  )
  await gallery.goto('ex-date-picker')
  await fields.date.fill('9 April')
  await fields.date.press('Enter')
  await screenshotStep(
    'Date picker, a past date typed',
    fields.datePicker,
    'fields-date-picker-too-early.png',
  )

  await gallery.goto('ex-checkbox-radio-and-switch')
  await screenshotStep(
    'Checkbox, radio and switch',
    fields.choices,
    'fields-checkbox-radio-and-switch.png',
  )
  await focusedScreenshotStep(
    'Needs an umpire, focused',
    fields.control('checkbox', 'Needs an umpire'),
    'fields-checkbox-focused.png',
  )
  await focusedScreenshotStep(
    'Best of 5, focused',
    fields.control('radio', 'Best of 5'),
    'fields-radio-focused.png',
  )
  await focusedScreenshotStep(
    'Call players automatically, focused',
    fields.control('switch', 'Call players automatically'),
    'fields-switch-focused.png',
  )
  await fields.control('checkbox', 'Needs an umpire').check()
  await fields.control('radio', 'Best of 7').check()
  await fields.control('switch', 'Show ratings to spectators').click()
  await gallery.page.mouse.move(0, 0)
  await screenshotStep(
    'Checkbox, radio and switch, changed',
    fields.choices,
    'fields-checkbox-radio-and-switch-changed.png',
  )
}

test('the Fields and choices section matches its screenshots and the gallery', async ({
  designSystemPage,
  referenceKitPage,
}) => {
  await test.step('app', () => fieldsScreenshots(designSystemPage))
  await test.step('gallery', () => fieldsScreenshots(referenceKitPage))
})

async function feedbackScreenshots(gallery: GalleryPage): Promise<void> {
  const feedback = gallery.feedback
  await gallery.goto(feedback.testId)
  await screenshotStep('heading', feedback.heading, 'feedback-heading.png')
  await screenshotStep('lead', feedback.lead, 'feedback-lead.png')

  await gallery.goto('ex-inline-notice')
  await screenshotStep(
    'Inline notice',
    feedback.inlineNotice,
    'feedback-inline-notice.png',
  )

  await gallery.goto('ex-status-set')
  await screenshotStep('Status set', feedback.statusSet, 'feedback-status-set.png')

  await gallery.goto('ex-toast')
  await screenshotStep('Toast', feedback.toast, 'feedback-toast.png')
  await gallery.raiseToast(
    feedback.button('Call Chen vs Ali'),
    'Chen vs Ali called to Table 1',
  )
  await pageScreenshotStep(
    'Call Chen vs Ali, toast raised',
    gallery,
    'feedback-toast-raised.png',
  )
  await hoveredScreenshotStep(
    'Undo, hovered',
    gallery.toastButton('Undo'),
    'feedback-toast-undo-hovered.png',
  )
  await hoveredScreenshotStep(
    'Dismiss, hovered',
    gallery.toastButton('Dismiss'),
    'feedback-toast-dismiss-hovered.png',
  )
  await gallery.toastButton('Undo').click()
  await expect(gallery.toasts).toBeEmpty()
  await screenshotStep('Toast, undone', feedback.toast, 'feedback-toast-undone.png')
  await gallery.raiseToast(feedback.button('Mark Table 4 free'), 'Table 4 marked free')
  await pageScreenshotStep(
    'Mark Table 4 free, toast raised',
    gallery,
    'feedback-toast-no-undo-raised.png',
  )

  await gallery.goto('ex-warning-and-error')
  await screenshotStep(
    'Warning and error',
    feedback.warningAndError,
    'feedback-warning-and-error.png',
  )
  await gallery.raiseToast(
    feedback.button('Choose another time'),
    '“Choose another time” isn’t wired up in this demo',
  )
  await pageScreenshotStep(
    'Choose another time, demo toast raised',
    gallery,
    'feedback-demo-toast-raised.png',
  )
  await gallery.toastButton('Dismiss').click()
  await gallery.raiseToast(
    feedback.button('Move doubles to 12:40'),
    'Doubles moved to 12:40',
  )
  await screenshotStep(
    'Warning and error, resolved',
    feedback.warningAndError,
    'feedback-warning-and-error-resolved.png',
  )
}

test('the Feedback section matches its screenshots and the gallery', async ({
  designSystemPage,
  referenceKitPage,
}) => {
  await test.step('app', () => feedbackScreenshots(designSystemPage))
  await test.step('gallery', () => feedbackScreenshots(referenceKitPage))
})

async function overlaysScreenshots(gallery: GalleryPage): Promise<void> {
  const overlays = gallery.overlays
  await gallery.goto(overlays.testId)
  await screenshotStep('heading', overlays.heading, 'overlays-heading.png')
  await screenshotStep('lead', overlays.lead, 'overlays-lead.png')

  await gallery.goto('ex-tooltip')
  await screenshotStep('Tooltip', overlays.tooltip, 'overlays-tooltip.png')
  await gallery.showTooltip(
    overlays.button('Move to free table'),
    'Moves this match to the next free table and tells both players. Their rest times are kept.',
  )
  await pageScreenshotStep(
    'Move to free table, tooltip shown',
    gallery,
    'overlays-tooltip-shown.png',
  )
  await gallery.showTooltip(overlays.button('Print score sheet'), 'Print score sheet')
  await pageScreenshotStep(
    'Print score sheet, tooltip shown',
    gallery,
    'overlays-tooltip-icon-shown.png',
  )
  await gallery.page.mouse.move(0, 0)

  await gallery.goto('ex-dialog')
  await screenshotStep('Dialog', overlays.dialog, 'overlays-dialog.png')
  await gallery.openWithdrawDialog(gallery.page.getByTestId('dialog-trigger'))
  await pageScreenshotStep('Dialog, open', gallery, 'overlays-dialog-open.png')

  await gallery.goto('ex-menu')
  await screenshotStep('Menu', overlays.menu, 'overlays-menu.png')
  await hoveredScreenshotStep(
    'Edit match, hovered',
    overlays.menuItem('Edit match'),
    'overlays-menu-item-hovered.png',
  )

  await gallery.goto('ex-sheet-and-drawer')
  await screenshotStep(
    'Sheet and drawer',
    overlays.sheetAndDrawer,
    'overlays-sheet-and-drawer.png',
  )
  await overlays.openMatchSheet()
  await pageScreenshotStep('Match drawer, open', gallery, 'overlays-sheet-match-open.png')
  await gallery.page.keyboard.press('Escape')
  await overlays.openMoveSheet()
  await pageScreenshotStep('Move sheet, open', gallery, 'overlays-sheet-move-open.png')
  await gallery.raiseToast(
    overlays.moveSheet.getByRole('button', { name: 'Move match' }),
    'Moved to Table 2',
  )
  await pageScreenshotStep('Move sheet, moved', gallery, 'overlays-sheet-move-moved.png')

  await gallery.goto('ex-command-palette')
  await screenshotStep(
    'Command palette',
    overlays.commandPalette,
    'overlays-command-palette.png',
  )
  await overlays.openPalette('patel')
  await pageScreenshotStep(
    'Command palette, open with "patel"',
    gallery,
    'overlays-palette-patel.png',
  )
}

test('the Overlays section matches its screenshots and the gallery', async ({
  designSystemPage,
  referenceKitPage,
}) => {
  await test.step('app', () => overlaysScreenshots(designSystemPage))
  await test.step('gallery', () => overlaysScreenshots(referenceKitPage))
})

// The overlays' behaviour, which jsdom can't show: the top layer, focus,
// :focus-visible and layout. Each test runs on the app and on the gallery,
// so both behave alike.
for (const site of ['app', 'gallery'] as const) {
  test.describe(`Overlays on the ${site}`, () => {
    let gallery: GalleryPage
    test.beforeEach(({ designSystemPage, referenceKitPage }) => {
      gallery = site === 'app' ? designSystemPage : referenceKitPage
    })

    test('a tooltip shows on keyboard focus and Esc hides it', async ({ page }) => {
      await gallery.goto('ex-tooltip')
      const print = gallery.overlays.button('Print score sheet')

      await page.keyboard.press('Tab')

      await expect(print).toBeFocused()
      await expect(gallery.shownTooltip).toHaveText('Print score sheet')
      await expect(print).toHaveAccessibleDescription('Print score sheet')
      await page.keyboard.press('Escape')
      await expect(gallery.shownTooltip).toBeHidden()
      await expect(print).not.toHaveAttribute('aria-describedby')
    })

    test('a tooltip goes below its trigger when there is no room above', async ({
      page,
    }) => {
      await gallery.goto()
      const trigger = page.getByTestId('tooltip-trigger')
      await trigger.evaluate((el) => el.scrollIntoView())

      await trigger.hover()

      const triggerBox = (await trigger.boundingBox())!
      const tipBox = (await gallery.shownTooltip.boundingBox())!
      expect(tipBox.y).toBe(triggerBox.y + triggerBox.height + 8)
      expect(tipBox.x).toBeGreaterThanOrEqual(8)
      expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(page.viewportSize()!.width - 8)
    })

    test('the dialog closes on Esc, the backdrop and Keep in draw, and focus returns', async ({
      page,
    }) => {
      await gallery.goto('ex-dialog')
      const trigger = page.getByTestId('dialog-trigger')
      const dialog = gallery.withdrawDialog

      await gallery.openWithdrawDialog(trigger)
      await expect(dialog.getByRole('button', { name: 'Keep in draw' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(trigger).toBeFocused()

      await gallery.openWithdrawDialog(trigger)
      await page.mouse.click(5, 5)
      await expect(dialog).toBeHidden()
      await expect(trigger).toBeFocused()

      await gallery.openWithdrawDialog(trigger)
      await dialog.getByRole('button', { name: 'Keep in draw' }).click()
      await expect(dialog).toBeHidden()
      await expect(trigger).toBeFocused()
    })

    test('the match drawer closes with Close and focus returns', async ({ page }) => {
      await gallery.goto('ex-sheet-and-drawer')
      const overlays = gallery.overlays

      await overlays.openMatchSheet()
      // The head's X and the footer's button are both named Close.
      await overlays.matchSheet.getByRole('button', { name: 'Close', exact: true }).last().click()

      await expect(overlays.matchSheet).toBeHidden()
      await expect(page.getByTestId('sheet-match-trigger')).toBeFocused()
    })

    test('the move sheet moves the match, and Undo moves it back', async () => {
      await gallery.goto('ex-sheet-and-drawer')
      const overlays = gallery.overlays

      await overlays.openMoveSheet()
      await overlays.moveSheet.getByRole('radio', { name: /^Table 5/ }).check()
      await gallery.raiseToast(
        overlays.moveSheet.getByRole('button', { name: 'Move match' }),
        'Moved to Table 5',
      )
      await expect(overlays.matchTable).toHaveText('Table 5')

      await overlays.openMoveSheet()
      await expect(overlays.moveSheet).toContainText('now on Table 5')
      await expect(overlays.moveSheet.getByRole('radio', { name: /^Table 2/ })).toBeChecked()
      await expect(overlays.moveSheet.getByRole('radio', { name: /^Table 4/ })).toBeDisabled()
      await expect(overlays.moveSheet.getByRole('radio', { name: /^Table 5/ })).toHaveCount(0)
      await overlays.moveSheet.getByRole('button', { name: 'Cancel' }).click()
      await expect(overlays.moveSheet).toBeHidden()
      await expect(overlays.matchTable).toHaveText('Table 5')

      await gallery.toastButton('Undo').click()
      await expect(overlays.matchTable).toHaveText('Table 3')
    })

    test('Ctrl+K opens the palette, which finds players ignoring accents', async ({
      page,
    }) => {
      await gallery.goto()
      const overlays = gallery.overlays

      await page.keyboard.press('Control+K')
      await expect(overlays.paletteSearch).toBeFocused()
      await overlays.paletteSearch.fill('wojcik')

      await expect(overlays.palette.getByRole('option')).toHaveText([
        'Wójcik-Szymańska, AgnieszkaNorthside',
      ])
      await page.keyboard.press('Control+K')
      await expect(overlays.palette).toBeHidden()
    })

    test('the palette moves with the arrow keys and runs with Enter', async ({ page }) => {
      await gallery.goto('ex-command-palette')
      const overlays = gallery.overlays

      await overlays.openPalette('sheet')
      const drawer = overlays.paletteOption('Match drawer')
      const move = overlays.paletteOption('Move match to another table')
      await expect(overlays.palette.getByRole('option')).toHaveCount(2)
      await expect(drawer).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('ArrowDown')
      await expect(move).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('ArrowDown')
      await expect(drawer).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('ArrowUp')
      await expect(move).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('Enter')

      await expect(overlays.palette).toBeHidden()
      await expect(overlays.moveSheet).toBeVisible()
    })

    test('the palette closes on Esc', async ({ page }) => {
      await gallery.goto('ex-command-palette')
      const overlays = gallery.overlays

      await overlays.openPalette()
      await page.keyboard.press('Escape')

      await expect(overlays.palette).toBeHidden()
      await expect(page.getByTestId('palette-trigger')).toBeFocused()
    })
  })
}

// The fields' behaviour in a real browser: focus moves, selection, paste,
// autofill and the keyboard. Each test runs on the app and on the gallery,
// so both behave alike.
for (const site of ['app', 'gallery'] as const) {
  test.describe(`Fields and choices on the ${site}`, () => {
    let gallery: GalleryPage
    test.beforeEach(({ designSystemPage, referenceKitPage }) => {
      gallery = site === 'app' ? designSystemPage : referenceKitPage
    })

    test('the Table field shows its error until it holds 1 to 6', async () => {
      await gallery.goto('ex-text-field')
      const fields = gallery.fields
      const error = fields.textField.getByText('This venue has 6 tables. Enter 1–6.')

      await fields.table.fill('4')
      await expect(fields.table).toHaveAttribute('aria-invalid', 'false')
      await expect(error).toBeHidden()

      await fields.table.fill('7')
      await expect(fields.table).toHaveAttribute('aria-invalid', 'true')
      await expect(fields.table).toHaveAccessibleDescription(
        'This venue has 6 tables. Enter 1–6.',
      )
    })

    test('the code input spreads autofill, and Backspace and the arrows step back', async ({
      page,
    }) => {
      await gallery.goto('ex-code-input')
      const fields = gallery.fields

      // Autofill writes the whole code into the first box.
      await fields.codeBox(1).fill('sp26rv')

      for (const [n, character] of [...'SP26RV'].entries()) {
        await expect(fields.codeBox(n + 1)).toHaveValue(character)
      }
      await expect(fields.codeBox(6)).toBeFocused()
      await expect(fields.codeInput.getByText('Spring Open 2026')).toBeVisible()

      await page.keyboard.press('Backspace')
      await expect(fields.codeBox(6)).toHaveValue('')
      await expect(fields.codeInput.getByText('Spring Open 2026')).toBeHidden()
      await page.keyboard.press('Backspace')
      await expect(fields.codeBox(5)).toHaveValue('')
      await expect(fields.codeBox(5)).toBeFocused()
      await page.keyboard.press('ArrowLeft')
      await expect(fields.codeBox(4)).toBeFocused()
      await page.keyboard.press('ArrowRight')
      await expect(fields.codeBox(5)).toBeFocused()
    })

    test('a code pasted into the code input spreads across its boxes', async ({
      page,
      context,
    }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await gallery.goto('ex-code-input')
      const fields = gallery.fields
      // A string, because the suite's types have no DOM.
      await page.evaluate("navigator.clipboard.writeText('xy-12 zz')")

      await fields.codeBox(1).focus()
      await page.keyboard.press('ControlOrMeta+V')

      for (const [n, character] of [...'XY12ZZ'].entries()) {
        await expect(fields.codeBox(n + 1)).toHaveValue(character)
      }
      await expect(fields.codeBox(1)).toHaveAttribute('aria-invalid', 'true')
      await expect(fields.codeBox(1)).toHaveAccessibleDescription(
        'No tournament uses that code. Check the poster or ask the desk. On the poster at the venue entrance. Try SP26RV.',
      )
    })

    test('the combobox picks with Enter, and Esc closes the list, then clears', async ({
      page,
    }) => {
      await gallery.goto('ex-combobox')
      const fields = gallery.fields

      await fields.searchOpponent('wojcik')
      await expect(fields.opponentList.getByRole('option')).toHaveCount(1)
      await page.keyboard.press('Enter')
      await expect(fields.opponent).toHaveValue('Wójcik-Szymańska, Agnieszka')
      await expect(fields.opponentList).toBeHidden()
      await expect(fields.combobox).toContainText(
        'Picked: Wójcik-Szymańska, Agnieszka · Northside',
      )

      await fields.searchOpponent('east')
      await expect(fields.opponentList.getByRole('option')).toHaveCount(5)
      await page.keyboard.press('Escape')
      await expect(fields.opponentList).toBeHidden()
      await expect(fields.opponent).toHaveValue('east')
      await page.keyboard.press('Escape')
      await expect(fields.opponent).toHaveValue('')
    })

    test('a player from the palette goes to the opponent combobox', async ({ page }) => {
      await gallery.goto()
      const fields = gallery.fields

      await page.keyboard.press('Control+K')
      await gallery.overlays.paletteSearch.fill('patel')
      await page.keyboard.press('Enter')

      await expect(fields.opponent).toBeFocused()
      await expect(fields.opponent).toHaveValue('Patel, Meera')
      await expect(fields.opponentList.getByRole('option')).toHaveCount(1)
      await expect(fields.opponentList.getByRole('option')).toContainText('Patel, Meera')
    })

    test('typed dates are read and shown in full', async ({ page }) => {
      await gallery.goto('ex-date-picker')
      const { date } = gallery.fields

      for (const [typed, shown] of [
        ['11/4/2026', 'Saturday 11 April 2026'],
        ['Sat 25 Apr', 'Saturday 25 April 2026'],
        ['April 20 2026', 'Monday 20 April 2026'],
        ['12.4.26', 'Sunday 12 April 2026'],
        ['2026-05-01', 'Friday 1 May 2026'],
      ]) {
        await date.fill(typed)
        await date.press('Enter')
        await expect(date).toHaveValue(shown)
      }

      await date.fill('19 April 2026')
      await page.keyboard.press('Tab')
      await expect(date).toHaveValue('Sunday 19 April 2026')

      await date.fill('31/2/2026')
      await date.press('Enter')
      await expect(date).toHaveAttribute('aria-invalid', 'true')
      await expect(date).toHaveAccessibleDescription(
        'Players see this on the entry page. Enter a date like 11 April 2026 or 11/4/2026.',
      )
    })

    test('Alt+↓ opens the calendar, the keys move by day, week and month, and Esc returns focus', async ({
      page,
    }) => {
      await gallery.goto('ex-date-picker')
      const fields = gallery.fields

      await fields.date.press('Alt+ArrowDown')
      await expect(fields.day('Saturday 11 April 2026')).toBeFocused()
      await page.keyboard.press('PageDown')
      await expect(fields.day('Monday 11 May 2026')).toBeFocused()
      await page.keyboard.press('End')
      await expect(fields.day('Sunday 17 May 2026')).toBeFocused()
      await page.keyboard.press('Home')
      await expect(fields.day('Monday 11 May 2026')).toBeFocused()
      await page.keyboard.press('ArrowUp')
      await expect(fields.day('Monday 4 May 2026')).toBeFocused()
      await page.keyboard.press('ArrowLeft')
      await expect(fields.day('Sunday 3 May 2026')).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('PageUp')
      await expect(fields.day('Friday 10 April 2026, today')).toBeFocused()

      await page.keyboard.press('Escape')
      await expect(fields.calendar).toBeHidden()
      await expect(fields.calendarButton).toBeFocused()
    })

    test('a day picked in the calendar fills the field and closes it', async ({ page }) => {
      await gallery.goto('ex-date-picker')
      const fields = gallery.fields

      await fields.openCalendar()
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')

      await expect(fields.date).toHaveValue('Saturday 18 April 2026')
      await expect(fields.calendar).toBeHidden()
      await expect(fields.calendarButton).toBeFocused()
      await fields.openCalendar()
      await expect(fields.day('Saturday 18 April 2026')).toHaveAttribute('aria-selected', 'true')
    })

    test('a click outside closes the calendar', async ({ page }) => {
      await gallery.goto('ex-date-picker')
      const fields = gallery.fields

      await fields.openCalendar()
      await page.mouse.click(5, 5)

      await expect(fields.calendar).toBeHidden()
    })

    test('the inline calendar picks a day and keeps focus on it', async () => {
      await gallery.goto('ex-date-picker')
      const day = gallery.fields.inlineCalendar.getByRole('button', {
        name: 'Wednesday 15 April 2026',
      })

      await day.click()

      await expect(day).toHaveAttribute('aria-selected', 'true')
      await expect(day).toBeFocused()
    })
  })
}
