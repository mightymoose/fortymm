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
// screenshotStep() does, for a raised toast: it sits bottom centre, outside
// the example that raised it, and its shadow reaches past its edges.
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
