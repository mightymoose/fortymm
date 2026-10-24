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

// The section has no examples, so each control's cell is checked in the
// section opened on its own. The section opens again before each control's
// clicks, because Chromium shows no focus ring for a scripted focus after a
// click.
async function selectionScreenshots(gallery: GalleryPage): Promise<void> {
  const selection = gallery.selection
  const { page } = gallery
  await gallery.goto(selection.testId)
  await screenshotStep('heading', selection.heading, 'selection-heading.png')
  await screenshotStep('lead', selection.lead, 'selection-lead.png')
  await screenshotStep('Tabs', selection.tabsCell, 'selection-tabs.png')
  await screenshotStep(
    'Segmented control',
    selection.segmentedCell,
    'selection-segmented-control.png',
  )
  await screenshotStep('Filter chips', selection.chipsCell, 'selection-filter-chips.png')
  await screenshotStep('Switch', selection.switchCell, 'selection-switch.png')

  await hoveredScreenshotStep(
    'Schedule tab, hovered',
    selection.tab('Schedule'),
    'selection-tab-hovered.png',
  )
  await page.mouse.move(0, 0)
  await focusedScreenshotStep(
    'Overview tab, selected and focused',
    selection.tab('Overview'),
    'selection-tab-focused.png',
  )
  await page.keyboard.press('ArrowRight')
  await screenshotStep(
    'Tabs, Schedule picked with →',
    selection.tabsCell,
    'selection-tabs-schedule-by-keyboard.png',
  )
  await gallery.goto(selection.testId)
  await selection.tab('Standings').click()
  await page.mouse.move(0, 0)
  await screenshotStep(
    'Tabs, Standings clicked',
    selection.tabsCell,
    'selection-tabs-standings-clicked.png',
  )

  await gallery.goto(selection.testId)
  await hoveredScreenshotStep(
    'List option, hovered',
    selection.option('List'),
    'selection-segmented-option-hovered.png',
  )
  await page.mouse.move(0, 0)
  await focusedScreenshotStep(
    'Timeline option, on and focused',
    selection.option('Timeline'),
    'selection-segmented-option-focused.png',
  )
  await page.keyboard.press('End')
  await screenshotStep(
    'Segmented control, By player picked with End',
    selection.segmentedCell,
    'selection-segmented-control-by-player-by-keyboard.png',
  )
  await gallery.goto(selection.testId)
  await selection.option('List').click()
  await page.mouse.move(0, 0)
  await screenshotStep(
    'Segmented control, List clicked',
    selection.segmentedCell,
    'selection-segmented-control-list-clicked.png',
  )

  await gallery.goto(selection.testId)
  await hoveredScreenshotStep(
    'Under 18 chip, hovered',
    selection.chip('Under 18'),
    'selection-chip-hovered.png',
  )
  await page.mouse.move(0, 0)
  await focusedScreenshotStep(
    'All events chip, on and focused',
    selection.chip('All events'),
    'selection-chip-focused.png',
  )
  await page.keyboard.press('Tab')
  await page.keyboard.press('Space')
  await screenshotStep(
    'Filter chips, Open singles turned on with Space',
    selection.chipsCell,
    'selection-filter-chips-open-singles-by-keyboard.png',
  )
  await gallery.goto(selection.testId)
  await selection.chip('Open singles').click()
  await selection.chip('Under 18').click()
  await page.mouse.move(0, 0)
  await expect(selection.showing).toHaveText('Showing: Open singles, Under 18')
  await screenshotStep(
    'Filter chips, Open singles and Under 18 clicked',
    selection.chipsCell,
    'selection-filter-chips-two-clicked.png',
  )

  await gallery.goto(selection.testId)
  await hoveredScreenshotStep(
    'Call players automatically, hovered',
    selection.callPlayers,
    'selection-switch-hovered.png',
  )
  await page.mouse.move(0, 0)
  await focusedScreenshotStep(
    'Call players automatically, focused',
    selection.callPlayers,
    'selection-switch-focused.png',
  )
  await page.keyboard.press('Space')
  await screenshotStep(
    'Switch, turned off with Space',
    selection.switchCell,
    'selection-switch-off-by-keyboard.png',
  )
  await gallery.goto(selection.testId)
  await selection.callPlayers.click()
  await page.mouse.move(0, 0)
  await screenshotStep(
    'Switch, turned off by click',
    selection.switchCell,
    'selection-switch-off-clicked.png',
  )
}

test('the Selection section matches its screenshots and the gallery', async ({
  designSystemPage,
  referenceKitPage,
}) => {
  await test.step('app', () => selectionScreenshots(designSystemPage))
  await test.step('gallery', () => selectionScreenshots(referenceKitPage))
})

// Moves the pointer off the page's controls and hides the tooltip that a
// click leaves on the focused control, so the next screenshot has neither.
async function settlePointer(gallery: GalleryPage): Promise<void> {
  await gallery.page.mouse.move(0, 0)
  await gallery.page.keyboard.press('Escape')
  await expect(gallery.shownTooltip).toBeHidden()
}

async function containersScreenshots(gallery: GalleryPage): Promise<void> {
  const containers = gallery.containers
  const page = gallery.page
  await gallery.goto(containers.testId)
  await screenshotStep('heading', containers.heading, 'containers-heading.png')
  await screenshotStep('lead', containers.lead, 'containers-lead.png')

  await gallery.goto('ex-card')
  await screenshotStep('Card', containers.card, 'containers-card.png')
  const gameScores = containers.button('Game scores')
  await hoveredScreenshotStep(
    'Game scores, hovered',
    gameScores,
    'containers-card-game-scores-hovered.png',
  )
  await gameScores.click()
  await page.mouse.move(0, 0)
  await screenshotStep(
    'Card, game scores shown',
    containers.card,
    'containers-card-game-scores-shown.png',
  )
  await gallery.raiseToast(
    containers.button('Move table'),
    '“Move table” isn’t wired up in this demo',
  )
  await page.mouse.move(0, 0)
  await pageScreenshotStep(
    'Move table, demo toast raised',
    gallery,
    'containers-card-demo-toast-raised.png',
  )

  await gallery.goto('ex-scroll-area')
  await screenshotStep('Scroll area', containers.scrollArea, 'containers-scroll-area.png')
  await focusedScreenshotStep(
    'Players, focused',
    containers.players,
    'containers-scroll-area-focused.png',
  )
  await test.step('Players, scrolled by the mouse wheel', async () => {
    const box = (await containers.players.boundingBox())!
    await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2))
    await page.mouse.wheel(0, 120)
    await expect.poll(() => containers.players.evaluate((el) => el.scrollTop)).toBe(120)
    await page.mouse.move(0, 0)
    await expect
      .soft(containers.scrollArea)
      .toHaveScreenshot('containers-scroll-area-scrolled.png')
  })
  await gallery.goto('ex-scroll-area')
  await gallery.raiseToast(containers.button('Check in all'), '3 more players checked in')
  await page.mouse.move(0, 0)
  await pageScreenshotStep(
    'Check in all, toast raised',
    gallery,
    'containers-scroll-area-checked-in-raised.png',
  )

  await gallery.goto('ex-split-view')
  await screenshotStep('Split view', containers.splitView, 'containers-split-view.png')
  await gallery.showTooltip(
    containers.block('Patel, Meera vs Park, Ji-ho'),
    'Patel, Meera vs Park, Ji-ho · Table 2 · 11:50–12:25 · Patel would rest 5 min',
  )
  await pageScreenshotStep(
    'Patel vs Park, tooltip shown',
    gallery,
    'containers-split-view-block-tooltip-shown.png',
  )
  await settlePointer(gallery)
  await gallery.raiseToast(
    containers.button('Move to 12:05'),
    'Works on the tournament screen, not in this gallery',
  )
  await page.mouse.move(0, 0)
  await pageScreenshotStep(
    'Move to 12:05, toast raised',
    gallery,
    'containers-split-view-act-toast-raised.png',
  )
  await gallery.toastButton('Dismiss').click()
  for (const [match, name] of [
    ['Patel, Meera vs Wójcik-Szymańska, Agnieszka', 'live'],
    ['Nguyen, Thanh vs Silva, Rafael', 'final'],
    ['Rossi, Giulia / Haddad, Youssef vs Fernández-Castillo, Marisol / Kim, Hyun-woo', 'offline'],
    ['Dubois, Camille vs Lindqvist, Erik', 'resting'],
  ]) {
    await containers.block(match).click()
    await settlePointer(gallery)
    await screenshotStep(
      `Split view, ${match} picked`,
      containers.splitView,
      `containers-split-view-${name}.png`,
    )
  }
  await gallery.showTooltip(
    containers.button('Call to table'),
    'Lindqvist is resting until 12:10',
  )
  await pageScreenshotStep(
    'Call to table, tooltip shown',
    gallery,
    'containers-split-view-call-tooltip-shown.png',
  )
  await settlePointer(gallery)
  await containers.button('Withdraw a player…').click()
  await containers.withdrawPlayerDialog.waitFor()
  await page.mouse.move(0, 0)
  await pageScreenshotStep(
    'Withdraw a player, dialog open',
    gallery,
    'containers-split-view-withdraw-dialog.png',
  )

  await gallery.goto('ex-split-view')
  await test.step('Split view, resized by keyboard', async () => {
    await containers.splitHandle.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(containers.splitHandle).toHaveAttribute('aria-valuenow', '50')
    await expect
      .soft(containers.splitView)
      .toHaveScreenshot('containers-split-view-keyboard-resized.png')
  })
  await gallery.goto('ex-split-view')
  await test.step('Split view, resized by dragging', async () => {
    const box = (await containers.splitHandle.boundingBox())!
    const x = Math.round(box.x + box.width / 2)
    const y = Math.round(box.y + box.height / 2)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 60, y, { steps: 4 })
    await page.mouse.up()
    await page.mouse.move(0, 0)
    await expect
      .soft(containers.splitView)
      .toHaveScreenshot('containers-split-view-dragged.png')
  })
}

test('the Containers section matches its screenshots and the gallery', async ({
  designSystemPage,
  referenceKitPage,
}) => {
  await test.step('app', () => containersScreenshots(designSystemPage))
  await test.step('gallery', () => containersScreenshots(referenceKitPage))
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

async function matchScreenshots(gallery: GalleryPage): Promise<void> {
  const match = gallery.match
  const page = gallery.page
  await gallery.goto(match.testId)
  await screenshotStep('heading', match.heading, 'match-heading.png')
  await screenshotStep('lead', match.lead, 'match-lead.png')

  await gallery.goto('ex-match-row')
  await screenshotStep('Match row', match.matchRow, 'match-match-row.png')
  const gameScores = match
    .row('Nguyen, Thanh vs Silva, Rafael')
    .getByRole('button', { name: 'Game scores' })
  await hoveredScreenshotStep(
    'Game scores, hovered',
    gameScores,
    'match-match-row-game-scores-hovered.png',
  )
  await page.mouse.move(0, 0)
  await focusedScreenshotStep(
    'Game scores, focused',
    gameScores,
    'match-match-row-game-scores-focused.png',
  )
  await gameScores.click()
  await page.mouse.move(0, 0)
  await screenshotStep(
    'Match row, game scores shown',
    match.matchRow,
    'match-match-row-game-scores-shown.png',
  )

  await gallery.goto('ex-empty-and-disconnected')
  await screenshotStep(
    'Empty and disconnected',
    match.emptyAndDisconnected,
    'match-empty-and-disconnected.png',
  )

  await gallery.goto('ex-score-entry-and-game-history')
  await screenshotStep('Score entry', match.scoreEntry, 'match-score-entry.png')
  const plusPatel = match.button('+1 Patel')
  await hoveredScreenshotStep('+1 Patel, hovered', plusPatel, 'match-score-entry-add-hovered.png')
  await page.mouse.move(0, 0)
  await focusedScreenshotStep('+1 Patel, focused', plusPatel, 'match-score-entry-add-focused.png')
  await match.score('Patel', 'Wójcik-Szymańska')
  await page.mouse.move(0, 0)
  await expect(match.points('Wójcik-Szymańska')).toHaveText('10')
  await screenshotStep(
    'Score entry, 10–10',
    match.scoreEntry,
    'match-score-entry-scored.png',
  )
  await match.score('Patel')
  await gallery.raiseToast(plusPatel, 'Game 5 to Patel, 12–10')
  await page.mouse.move(0, 0)
  await pageScreenshotStep('Score entry, game won', gallery, 'match-score-entry-game-won.png')
  await gallery.toastButton('Undo').click()
  await page.mouse.move(0, 0)
  await expect(match.points('Patel')).toHaveText('11')
  await screenshotStep(
    'Score entry, game won and undone',
    match.scoreEntry,
    'match-score-entry-undone.png',
  )

  await gallery.goto('ex-schedule-blocks')
  await screenshotStep('Schedule blocks', match.scheduleBlocks, 'match-schedule-blocks.png')
  const conflict = match.block('Patel, Meera vs Park, Ji-ho')
  await hoveredScreenshotStep(
    'Patel vs Park, hovered',
    conflict,
    'match-schedule-blocks-block-hovered.png',
  )
  await pageScreenshotStep(
    'Patel vs Park, tooltip shown',
    gallery,
    'match-schedule-blocks-tooltip-shown.png',
  )
  await settlePointer(gallery)
  await focusedScreenshotStep(
    'Patel vs Park, focused',
    conflict,
    'match-schedule-blocks-block-focused.png',
  )
  await conflict.click()
  await settlePointer(gallery)
  await expect(conflict).toHaveAttribute('aria-pressed', 'true')
  await screenshotStep(
    'Schedule blocks, Patel vs Park picked',
    match.scheduleBlocks,
    'match-schedule-blocks-picked.png',
  )

  await gallery.goto('ex-rest-indicator')
  await screenshotStep('Rest indicator', match.restIndicator, 'match-rest-indicator.png')
}

test('the Match components section matches its screenshots and the gallery', async ({
  designSystemPage,
  referenceKitPage,
}) => {
  await test.step('app', () => matchScreenshots(designSystemPage))
  await test.step('gallery', () => matchScreenshots(referenceKitPage))
})

async function moreScreenshots(gallery: GalleryPage): Promise<void> {
  const more = gallery.more
  const page = gallery.page
  // The section has no lead line, so only its heading is checked.
  await gallery.goto(more.testId)
  await screenshotStep('heading', more.heading, 'more-heading.png')

  await gallery.goto('ex-data-table')
  await screenshotStep('Data table', more.dataTable, 'more-data-table.png')

  await gallery.goto('ex-tags-avatar-progress')
  await screenshotStep(
    'Tags, avatar, progress',
    more.tagsAvatarProgress,
    'more-tags-avatar-progress.png',
  )

  await gallery.goto('ex-navigation')
  await screenshotStep('Navigation', more.navigation, 'more-navigation.png')
  await hoveredScreenshotStep(
    'Spring Open, hovered',
    more.link('Spring Open'),
    'more-navigation-crumb-hovered.png',
  )
  await hoveredScreenshotStep('Draws, hovered', more.link('Draws'), 'more-navigation-nav-hovered.png')
  await hoveredScreenshotStep('Page 2, hovered', more.button('2'), 'more-navigation-page-hovered.png')
  await page.mouse.move(0, 0)

  await gallery.goto('ex-menubar')
  await screenshotStep('Menubar', more.menubar, 'more-menubar.png')
  await hoveredScreenshotStep(
    'Tournament, hovered',
    more.menuButton('Tournament'),
    'more-menubar-top-hovered.png',
  )
  await page.mouse.move(0, 0)
  await page.keyboard.press('Tab')
  await expect(more.menuButton('Tournament')).toBeFocused()
  await focusedScreenshotStep(
    'Tournament, focused',
    more.menuButton('Tournament'),
    'more-menubar-top-focused.png',
  )
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await expect(more.command('Add a break')).toBeFocused()
  await pageScreenshotStep(
    'Schedule, opened with → and ↓',
    gallery,
    'more-menubar-schedule-open.png',
  )
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(more.chosen).toHaveText(
    'Chose Schedule → Re-plan from now. (Demo: nothing else happens.)',
  )
  await screenshotStep('Menubar, Re-plan from now chosen', more.menubar, 'more-menubar-chosen.png')

  await gallery.goto('ex-carousel')
  await expect(more.carouselPosition).toHaveText('1–3 of 5')
  await screenshotStep('Carousel', more.carousel, 'more-carousel.png')
  await more.button('Next results').click()
  await page.mouse.move(0, 0)
  await expect(more.carouselPosition).toHaveText('2–4 of 5')
  await screenshotStep('Carousel, one card on', more.carousel, 'more-carousel-next.png')

  await gallery.goto('ex-accordion')
  await screenshotStep('Accordion', more.accordion, 'more-accordion.png')
  await more.summary('How are matches scheduled?').click()
  await more.summary('Scheduling details').click()
  await page.mouse.move(0, 0)
  await screenshotStep(
    'Accordion, the first closed and the second open',
    more.accordion,
    'more-accordion-swapped.png',
  )
}

test('the More components section matches its screenshots and the gallery', async ({
  designSystemPage,
  referenceKitPage,
}) => {
  await test.step('app', () => moreScreenshots(designSystemPage))
  await test.step('gallery', () => moreScreenshots(referenceKitPage))
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

// The selection controls' keyboard models in a real browser. Each test runs
// on the app and on the gallery, so both behave alike.
for (const site of ['app', 'gallery'] as const) {
  test.describe(`Selection on the ${site}`, () => {
    let gallery: GalleryPage
    test.beforeEach(({ designSystemPage, referenceKitPage }) => {
      gallery = site === 'app' ? designSystemPage : referenceKitPage
    })

    test('Tab stops once in the tabs and the segmented control, on the option that is on', async ({
      page,
    }) => {
      await gallery.goto('section-selection')
      const selection = gallery.selection
      await selection.tab('Schedule').click()
      await selection.option('By player').click()
      await page.getByRole('heading', { level: 2, name: 'Selection' }).click()

      await page.keyboard.press('Tab')
      await expect(selection.tab('Schedule')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(selection.option('By player')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(selection.chip('All events')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(selection.chip('Open singles')).toBeFocused()
    })

    test('the arrow keys, Home and End move between tabs and show their panels', async ({
      page,
    }) => {
      await gallery.goto('section-selection')
      const selection = gallery.selection

      await selection.tab('Overview').focus()
      for (const [key, name, panel] of [
        ['ArrowLeft', 'Standings', 'Groups A–D, top two advance.'],
        ['ArrowRight', 'Overview', '32 players · 4 tables · expected finish 18:45'],
        ['ArrowDown', 'Schedule', '14 of 31 matches played.'],
        ['ArrowUp', 'Overview', '32 players · 4 tables · expected finish 18:45'],
        ['End', 'Standings', 'Groups A–D, top two advance.'],
        ['Home', 'Overview', '32 players · 4 tables · expected finish 18:45'],
      ]) {
        await page.keyboard.press(key)
        await expect(selection.tab(name)).toBeFocused()
        await expect(selection.tab(name)).toHaveAttribute('aria-selected', 'true')
        await expect(selection.tabPanel).toHaveText(panel)
      }
    })

    test('the arrow keys, Home and End move the segmented control', async ({ page }) => {
      await gallery.goto('section-selection')
      const selection = gallery.selection

      await selection.option('Timeline').focus()
      for (const [key, name] of [
        ['ArrowRight', 'List'],
        ['ArrowDown', 'By player'],
        ['ArrowRight', 'Timeline'],
        ['ArrowUp', 'By player'],
        ['Home', 'Timeline'],
        ['End', 'By player'],
      ]) {
        await page.keyboard.press(key)
        await expect(selection.option(name)).toBeFocused()
        await expect(selection.option(name)).toBeChecked()
      }
      await expect(selection.segmentedCell.getByRole('radio', { checked: true })).toHaveCount(1)
    })

    test('All events clears the chips and comes back when none are on', async () => {
      await gallery.goto('section-selection')
      const selection = gallery.selection
      const allEvents = selection.chip('All events')

      await selection.chip('Doubles').click()
      await selection.chip('Under 18').click()
      await expect(allEvents).toHaveAttribute('aria-pressed', 'false')
      await expect(selection.showing).toHaveText('Showing: Under 18, Doubles')

      await allEvents.click()
      for (const name of ['Open singles', 'Under 18', 'Doubles']) {
        await expect(selection.chip(name)).toHaveAttribute('aria-pressed', 'false')
      }
      await expect(allEvents).toHaveAttribute('aria-pressed', 'true')
      await expect(selection.showing).toHaveText('Showing: All events')

      await selection.chip('Open singles').click()
      await expect(selection.showing).toHaveText('Showing: Open singles')
      await selection.chip('Open singles').click()
      await expect(allEvents).toHaveAttribute('aria-pressed', 'true')
      await expect(selection.showing).toHaveText('Showing: All events')
    })

    test('Space and Enter turn the switch over', async ({ page }) => {
      await gallery.goto('section-selection')
      const { callPlayers } = gallery.selection

      await callPlayers.focus()
      await page.keyboard.press('Space')
      await expect(callPlayers).toHaveAttribute('aria-checked', 'false')
      await page.keyboard.press('Enter')
      await expect(callPlayers).toHaveAttribute('aria-checked', 'true')
    })
  })
}

// The containers' behaviour in a real browser: the split handle's keys and
// drag, picking blocks, scrolling, and the layout at phone width. Each test
// runs on the app and on the gallery, so both behave alike.
for (const site of ['app', 'gallery'] as const) {
  test.describe(`Containers on the ${site}`, () => {
    let gallery: GalleryPage
    test.beforeEach(({ designSystemPage, referenceKitPage }) => {
      gallery = site === 'app' ? designSystemPage : referenceKitPage
    })

    test('the arrow keys, Home and End resize the split view within its bounds', async ({
      page,
    }) => {
      await gallery.goto('ex-split-view')
      const handle = gallery.containers.splitHandle

      await handle.focus()
      for (const [key, value] of [
        ['ArrowRight', '62'],
        ['ArrowLeft', '58'],
        ['ArrowLeft', '54'],
        ['End', '72'],
        ['ArrowRight', '72'],
        ['Home', '35'],
        ['ArrowLeft', '35'],
      ]) {
        await page.keyboard.press(key)
        await expect(handle).toHaveAttribute('aria-valuenow', value)
      }
    })

    test('dragging the handle resizes the split view to the pointer', async ({ page }) => {
      await gallery.goto('ex-split-view')
      const { splitHandle, schedule } = gallery.containers
      const box = (await splitHandle.boundingBox())!
      const y = Math.round(box.y + box.height / 2)
      const before = (await schedule.boundingBox())!.width

      await page.mouse.move(Math.round(box.x + box.width / 2), y)
      await page.mouse.down()
      await page.mouse.move(Math.round(box.x + box.width / 2) - 200, y, { steps: 4 })
      await page.mouse.up()

      expect(Number(await splitHandle.getAttribute('aria-valuenow'))).toBeLessThan(58)
      expect((await schedule.boundingBox())!.width).toBeLessThan(before)
    })

    test('a picked block is pressed and its match shows in the details', async () => {
      await gallery.goto('ex-split-view')
      const containers = gallery.containers
      const conflict = containers.block('Patel, Meera vs Park, Ji-ho')
      const live = containers.block('Patel, Meera vs Wójcik-Szymańska, Agnieszka')
      await expect(conflict).toHaveAttribute('aria-pressed', 'true')
      await expect(containers.matchDetails.getByRole('heading', { level: 3 })).toHaveText(
        'Patel vs Park',
      )

      await live.click()

      await expect(live).toHaveAttribute('aria-pressed', 'true')
      await expect(conflict).toHaveAttribute('aria-pressed', 'false')
      await expect(containers.matchDetails.getByRole('heading', { level: 3 })).toHaveText(
        'Patel vs Wójcik-Szymańska',
      )
    })

    test('Call to table stays off while Lindqvist rests', async () => {
      await gallery.goto('ex-split-view')
      const containers = gallery.containers
      await containers.block('Dubois, Camille vs Lindqvist, Erik').click()

      // Playwright waits for an aria-disabled control to turn on before it
      // clicks, so the click is forced.
      await containers.button('Call to table').click({ force: true })

      await expect(containers.button('Call to table')).toHaveAttribute('aria-disabled', 'true')
      // The gallery adds its toast region with its first toast.
      await expect(gallery.toasts.locator('.fm-toast')).toHaveCount(0)
    })

    test('Check in all checks everyone in, and Undo puts the boxes back', async () => {
      await gallery.goto('ex-scroll-area')
      const { players } = gallery.containers
      const kim = players.getByRole('checkbox', { name: 'Kim, Hyun-woo' })
      const nguyen = players.getByRole('checkbox', { name: 'Nguyen, Thanh' })
      await nguyen.uncheck()

      await gallery.raiseToast(
        gallery.containers.button('Check in all'),
        '4 more players checked in',
      )
      await expect(players.getByRole('checkbox', { checked: false })).toHaveCount(0)
      await gallery.toastButton('Undo').click()

      await expect(kim).not.toBeChecked()
      await expect(nguyen).not.toBeChecked()
      await expect(players.getByRole('checkbox', { checked: true })).toHaveCount(8)
    })

    test('Check in all says when everyone was already in, with no Undo', async () => {
      await gallery.goto('ex-scroll-area')
      const containers = gallery.containers
      for (const name of ['Kim, Hyun-woo', 'Lindqvist, Erik', 'Fernández-Castillo, Marisol']) {
        await containers.players.getByRole('checkbox', { name }).check()
      }

      await gallery.raiseToast(containers.button('Check in all'), 'Everyone was already checked in')

      await expect(gallery.toastButton('Undo')).toHaveCount(0)
    })

    test('Tab reaches the check-in list, and the arrow keys scroll it under its heading', async ({
      page,
    }) => {
      await gallery.goto('ex-scroll-area')
      const { players } = gallery.containers
      const heading = players.getByText('Player', { exact: true })
      await gallery.containers.button('Check in all').focus()

      await page.keyboard.press('Tab')
      await expect(players).toBeFocused()
      const top = (await heading.boundingBox())!.y
      await page.keyboard.press('ArrowDown')

      await expect.poll(() => players.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
      expect((await heading.boundingBox())!.y).toBe(top)
    })

    test('Game scores shows and hides the game scores', async () => {
      await gallery.goto('ex-card')
      const toggle = gallery.containers.button('Game scores')
      const table = gallery.containers.card.getByRole('table')
      await expect(table).toBeHidden()

      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(table).toBeVisible()

      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(table).toBeHidden()
    })

    test('at phone width the split view stacks the details under the schedule, with no handle', async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await gallery.goto('ex-split-view')
      const { splitHandle, schedule, matchDetails } = gallery.containers

      await expect(splitHandle).toBeHidden()
      const scheduleBox = (await schedule.boundingBox())!
      const detailsBox = (await matchDetails.boundingBox())!
      expect(detailsBox.y).toBeGreaterThanOrEqual(scheduleBox.y + scheduleBox.height)
      expect(detailsBox.x).toBe(scheduleBox.x)
      expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(390)
    })
  })
}

// The match components' behaviour in a real browser: scoring, picking
// blocks, keyboard tooltips and names at phone width. Each test runs on the
// app and on the gallery, so both behave alike.
for (const site of ['app', 'gallery'] as const) {
  test.describe(`Match components on the ${site}`, () => {
    let gallery: GalleryPage
    test.beforeEach(({ designSystemPage, referenceKitPage }) => {
      gallery = site === 'app' ? designSystemPage : referenceKitPage
    })

    test('a point flashes the number it changed, and Undo last point takes it back', async () => {
      await gallery.goto('ex-score-entry-and-game-history')
      const match = gallery.match
      const undo = match.button('Undo last point')
      await expect(undo).toBeDisabled()

      await match.score('Wójcik-Szymańska')

      await expect(match.points('Wójcik-Szymańska')).toHaveText('10')
      await expect(match.points('Wójcik-Szymańska')).toHaveClass(/score-updated/)
      await expect(match.points('Patel')).not.toHaveClass(/score-updated/)
      await expect(match.history.getByRole('row').nth(2)).toHaveText(
        /^Wójcik-Szymańska\s*8\s*11\s*9\s*11\s*10$/,
      )
      await undo.click()
      await expect(match.points('Wójcik-Szymańska')).toHaveText('9')
      await expect(undo).toBeDisabled()
    })

    test('a won game ends the match, and the toast’s Undo takes the winning point back', async () => {
      await gallery.goto('ex-score-entry-and-game-history')
      const match = gallery.match
      await match.score('Wójcik-Szymańska')

      await gallery.raiseToast(match.button('+1 Wójcik-Szymańska'), 'Game 5 to Wójcik-Szymańska, 11–9')
      await expect(match.button('+1 Patel')).toBeDisabled()
      await expect(match.button('+1 Wójcik-Szymańska')).toBeDisabled()
      await expect(match.points('Wójcik-Szymańska')).toHaveText('0')
      await gallery.toastButton('Undo').click()

      await expect(match.points('Wójcik-Szymańska')).toHaveText('10')
      await expect(match.points('Patel')).toHaveText('9')
      await expect(match.button('+1 Patel')).toBeEnabled()
    })

    test('no block starts picked, and a click picks one', async () => {
      await gallery.goto('ex-schedule-blocks')
      const { scheduleBlocks } = gallery.match
      await expect(scheduleBlocks.getByRole('button', { pressed: true })).toHaveCount(0)

      await gallery.match.block('Dubois, Camille vs Lindqvist, Erik').click()

      await expect(scheduleBlocks.getByRole('button', { pressed: true })).toHaveAccessibleName(
        /Dubois, Camille vs Lindqvist, Erik/,
      )
    })

    test('a block’s tooltip shows on keyboard focus with its full names', async ({ page }) => {
      await gallery.goto('ex-schedule-blocks')
      const first = gallery.match.block('Nguyen, Thanh vs Silva, Rafael')

      await page.keyboard.press('Tab')

      await expect(first).toBeFocused()
      await expect(gallery.shownTooltip).toHaveText(
        'Nguyen, Thanh vs Silva, Rafael · Table 1 · 10:30–11:05',
      )
    })

    test('Game scores shows and hides a row’s game scores', async () => {
      await gallery.goto('ex-match-row')
      const row = gallery.match.row('Okafor-Adeyemi, Daniel vs Johansen-Whitfield, Annika')
      const toggle = row.getByRole('button', { name: 'Game scores' })
      const table = row.getByRole('table')
      await expect(table).toBeHidden()

      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(table).toBeVisible()

      await toggle.click()
      await expect(table).toBeHidden()
    })

    test('at phone width the longest names wrap instead of being cut off', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await gallery.goto()
      const match = gallery.match
      const names = [
        match.emptyAndDisconnected.getByText(
          'Fernández-Castillo, Marisol / Kim, Hyun-woo',
          { exact: true },
        ),
        match.scoreEntry.getByText('Wójcik-Szymańska, Agnieszka', { exact: true }),
      ]

      for (const name of names) {
        await name.scrollIntoViewIfNeeded()
        const { scrollWidth, clientWidth, height, lineHeight } = await name.evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          height: el.getBoundingClientRect().height,
          lineHeight: parseFloat(el.ownerDocument.defaultView!.getComputedStyle(el).lineHeight),
        }))
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
        expect(height).toBeGreaterThan(lineHeight * 1.5)
      }
    })
  })
}

// The menubar's and the carousel's behaviour in a real browser: focus, the
// keys, and the track's scrolling. Each test runs on the app and on the
// gallery, so both behave alike.
for (const site of ['app', 'gallery'] as const) {
  test.describe(`More components on the ${site}`, () => {
    let gallery: GalleryPage
    test.beforeEach(({ designSystemPage, referenceKitPage }) => {
      gallery = site === 'app' ? designSystemPage : referenceKitPage
    })

    test('← and → move along the menubar, and ↓, ↑ or Enter opens a menu', async ({ page }) => {
      await gallery.goto('ex-menubar')
      const more = gallery.more

      await page.keyboard.press('Tab')
      await expect(more.menuButton('Tournament')).toBeFocused()
      await page.keyboard.press('ArrowLeft')
      await expect(more.menuButton('Results')).toBeFocused()
      await expect(more.menu('Results')).toBeHidden()
      await page.keyboard.press('ArrowRight')
      await expect(more.menuButton('Tournament')).toBeFocused()

      await page.keyboard.press('Enter')
      await expect(more.menu('Tournament')).toBeVisible()
      await expect(more.menuButton('Tournament')).toHaveAttribute('aria-expanded', 'true')
      await expect(more.command('Edit details')).toBeFocused()
      await page.keyboard.press('ArrowUp')
      await expect(more.command('Print entry list ⌘P')).toBeFocused()

      await page.keyboard.press('ArrowRight')
      await expect(more.menu('Tournament')).toBeHidden()
      await expect(more.command('Add a break')).toBeFocused()

      await page.keyboard.press('Escape')
      await expect(more.menu('Schedule')).toBeHidden()
      await expect(more.menuButton('Schedule')).toBeFocused()
      await expect(more.menuButton('Schedule')).toHaveAttribute('aria-expanded', 'false')

      await page.keyboard.press('ArrowUp')
      await expect(more.command('Change minimum rest')).toBeFocused()
    })

    test('the menubar is one tab stop, and it remembers the menu last on', async ({ page }) => {
      await gallery.goto('ex-menubar')
      const more = gallery.more
      await page.keyboard.press('Tab')
      await page.keyboard.press('ArrowRight')

      await page.keyboard.press('Shift+Tab')
      await expect(more.menuButton('Schedule')).not.toBeFocused()
      await page.keyboard.press('Tab')

      await expect(more.menuButton('Schedule')).toBeFocused()
    })

    test('choosing a command closes its menu and says which it was', async () => {
      await gallery.goto('ex-menubar')
      const more = gallery.more

      await more.menuButton('Results').click()
      await more.command('Publish to spectators').click()

      await expect(more.menu('Results')).toBeHidden()
      await expect(more.chosen).toHaveText(
        'Chose Results → Publish to spectators. (Demo: nothing else happens.)',
      )
    })

    test('a click outside the menubar closes its open menu', async ({ page }) => {
      await gallery.goto('ex-menubar')
      const more = gallery.more
      await more.menuButton('Results').click()
      await expect(more.menu('Results')).toBeVisible()

      await page.mouse.click(5, 300)

      await expect(more.menu('Results')).toBeHidden()
    })

    test('the carousel’s buttons step one card, and stop at each end', async () => {
      await gallery.goto('ex-carousel')
      const more = gallery.more
      const previous = more.button('Previous results')
      const next = more.button('Next results')
      await expect(previous).toBeDisabled()

      await next.click()
      await expect(more.carouselPosition).toHaveText('2–4 of 5')
      await expect(previous).toBeEnabled()
      // Three and a bit cards show, so the last step only scrolls to the
      // end, and the count still starts at the second card.
      await next.click()
      await expect(next).toBeDisabled()
      await expect(more.carouselPosition).toHaveText('2–4 of 5')

      await previous.click()
      await expect(more.carouselPosition).toHaveText('1–3 of 5')
      await expect(previous).toBeDisabled()
      await expect(next).toBeEnabled()
    })

    test('the carousel’s track scrolls with the arrow keys once it has focus', async ({ page }) => {
      await gallery.goto('ex-carousel')
      const more = gallery.more

      await more.carouselTrack.focus()
      await page.keyboard.press('ArrowRight')

      await expect(more.carouselPosition).toHaveText('2–4 of 5')
      await expect(more.button('Previous results')).toBeEnabled()
      await page.keyboard.press('ArrowLeft')
      await expect(more.carouselPosition).toHaveText('1–3 of 5')
    })

    test('an accordion item opens and closes from its summary', async () => {
      await gallery.goto('ex-accordion')
      const more = gallery.more
      const details = more.accordion.getByText('1,248 variables · 12 rules · solved in 234 ms')
      await expect(details).toBeHidden()

      await more.summary('Scheduling details').click()
      await expect(details).toBeVisible()

      await more.summary('Scheduling details').click()
      await expect(details).toBeHidden()
    })
  })
}
