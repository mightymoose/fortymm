import type { Page } from '@playwright/test'
import { expect, test } from '../pages/test.ts'
import { App, AppLayout, NewVersion, DashboardPage } from '../pages/app.ts'
import { deploy, failDownload, holdBack } from '../pages/deployment.ts'

// A new deployment reaching a page that is open (src/new-version.ts): the
// app downloads it in the background, says a new version is ready only once
// every file of it is on the device, and switches to it when the person
// presses Reload, from the kept files, with or without a connection. Each
// test starts with the current build deployed and opens the dashboard on
// it; then the next build is deployed mid-test.

// A value the test leaves in the page's window: still there means the page
// was not reloaded.
async function leaveMark(page: Page) {
  await page.evaluate(() => {
    ;(window as { leftByTheTest?: boolean }).leftByTheTest = true
  })
}
function markLeft(page: Page) {
  return page.evaluate(
    () => (window as { leftByTheTest?: boolean }).leftByTheTest ?? false,
  )
}

test('a new version shows only once its files are on the device, the page is not reloaded by it, and Reload with no connection opens it', async ({
  context,
  page,
}) => {
  const app = new App(page)
  const start = new DashboardPage(page)
  const newVersion = new NewVersion(page)
  await start.goto()
  await app.waitUntilKept()
  await leaveMark(page)

  // The next build is deployed, and one of its files held back while the
  // browser downloads it.
  const held = await holdBack(context, '/index.html')
  await deploy('next')
  await newVersion.connectionComesBack()
  await held.requested

  expect(await newVersion.newWorker()).toBe('installing')
  await expect(newVersion.notice).toBeHidden()

  held.release()
  await expect(newVersion.notice).toBeVisible()
  expect(await newVersion.newWorker()).toBe('installed')
  expect(await markLeft(page)).toBe(true)
  await expect(page).toHaveTitle('fortymm')

  await context.setOffline(true)
  await newVersion.reload.click()

  await expect(page).toHaveTitle('fortymm (next deployment)')
  await expect(start.heading).toBeVisible()
  expect(await markLeft(page)).toBe(false)
  await expect(newVersion.notice).toBeHidden()

  // On the newest version, a further look finds nothing new.
  await context.setOffline(false)
  await newVersion.lookNow()
  expect(await newVersion.newWorker()).toBeNull()
  await expect(newVersion.notice).toBeHidden()
})

test('a download of a new version that fails shows nothing, and the next look tries again', async ({
  context,
  page,
}) => {
  const app = new App(page)
  const newVersion = new NewVersion(page)
  await new DashboardPage(page).goto()
  await app.waitUntilKept()

  const failing = await failDownload(context, '/index.html')
  await deploy('next')
  await newVersion.connectionComesBack()
  await failing.failed
  // The failed install leaves no new worker.
  await expect.poll(() => newVersion.newWorker()).toBeNull()
  await expect(newVersion.notice).toBeHidden()

  failing.stop()
  await newVersion.connectionComesBack()

  await expect(newVersion.notice).toBeVisible()
})

test('a page opened while a new version is already waiting shows it at once', async ({
  context,
  page,
}) => {
  const app = new App(page)
  const newVersion = new NewVersion(page)
  await new DashboardPage(page).goto()
  await app.waitUntilKept()
  await deploy('next')
  await newVersion.connectionComesBack()
  await expect(newVersion.notice).toBeVisible()

  const another = await context.newPage()
  await new DashboardPage(another).goto()

  await expect(another).toHaveTitle('fortymm')
  await expect(new NewVersion(another).notice).toBeVisible()
})

test('dismissed, the notice stays hidden on that page', async ({ page }) => {
  const app = new App(page)
  const newVersion = new NewVersion(page)
  await new DashboardPage(page).goto()
  await app.waitUntilKept()
  await deploy('next')
  await newVersion.connectionComesBack()
  await expect(newVersion.notice).toBeVisible()

  await newVersion.dismiss.click()

  await expect(newVersion.notice).toBeHidden()
  await newVersion.connectionComesBack()
  await newVersion.lookNow()
  await expect(newVersion.notice).toBeHidden()
})

// The notice is fixed over the screen by the layout (AppLayout.css), whose
// breakpoint jsdom doesn't apply: at a desktop's width and a phone's, it and
// both its buttons are wholly on screen. How it looks there is pinned by no
// test: screenshots are only for the design system pages, where its picture
// is (design-system-feedback.spec.ts).
const widths = {
  desktop: { width: 1280, height: 800 },
  // An iPhone's, under the layout's 768px breakpoint.
  phone: { width: 390, height: 844 },
}

for (const [name, viewport] of Object.entries(widths)) {
  test.describe(`at a ${name} width`, () => {
    test.use({ viewport })

    test('the notice and its Reload and Dismiss buttons are wholly on screen', async ({
      page,
    }) => {
      const newVersion = new NewVersion(page)
      await new DashboardPage(page).goto()
      await new App(page).waitUntilKept()
      await deploy('next')
      await newVersion.connectionComesBack()

      await expect(newVersion.notice).toBeInViewport({ ratio: 1 })
      await expect(newVersion.reload).toBeInViewport({ ratio: 1 })
      await expect(newVersion.dismiss).toBeInViewport({ ratio: 1 })
    })
  })
}

// On phones the bottom bar is fixed to the bottom of the screen too
// (BottomBar), and the notice sits above it: their boxes don't meet, and a
// press on Reload reaches Reload (Playwright's click fails if anything
// covers the button). At a desktop's width there is no bottom bar, and the
// notice is where it always was, 16px above the bottom.
test.describe('at a phone width, with the bottom bar', () => {
  test.use({ viewport: widths.phone })

  test('the notice and its buttons are clear of the bottom bar, and Reload takes the press and opens the new version', async ({
    page,
  }) => {
    const newVersion = new NewVersion(page)
    const bottomBar = new AppLayout(page).bottomBar
    await new DashboardPage(page).goto()
    await new App(page).waitUntilKept()
    await deploy('next')
    await newVersion.connectionComesBack()
    await expect(newVersion.notice).toBeVisible()
    await expect(bottomBar).toBeInViewport({ ratio: 1 })

    const barTop = (await bottomBar.boundingBox())!.y
    for (const part of [newVersion.notice, newVersion.reload, newVersion.dismiss]) {
      const box = (await part.boundingBox())!
      expect(box.y + box.height).toBeLessThanOrEqual(barTop)
    }

    await newVersion.reload.click()
    await expect(page).toHaveTitle('fortymm (next deployment)')
  })
})

test.describe('at a desktop width, with no bottom bar', () => {
  test.use({ viewport: widths.desktop })

  test('the notice is 16px above the bottom of the screen, as before the bottom bar', async ({
    page,
  }) => {
    const newVersion = new NewVersion(page)
    await new DashboardPage(page).goto()
    await new App(page).waitUntilKept()
    await deploy('next')
    await newVersion.connectionComesBack()
    await expect(newVersion.notice).toBeVisible()
    await expect(new AppLayout(page).bottomBar).toHaveCount(0)

    const box = (await newVersion.notice.boundingBox())!
    expect(widths.desktop.height - (box.y + box.height)).toBeCloseTo(16, 0)
  })
})
