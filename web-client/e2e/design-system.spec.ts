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
}

test('the Buttons section matches its screenshots and the gallery', async ({
  designSystemPage,
  referenceKitPage,
}) => {
  await test.step('app', () => buttonsScreenshots(designSystemPage))
  await test.step('gallery', () => buttonsScreenshots(referenceKitPage))
})
