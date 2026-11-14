import type { Page } from '@playwright/test'
import { expect, test } from '../pages/test.ts'
import { AppLayout, HealthPage } from '../pages/app.ts'

// How the layout around every screen looks (src/components/AppLayout.tsx),
// proven by pictures of the whole viewport, against baselines in
// __screenshots__/app-layout.spec.ts/: at a desktop width with the sidebar
// expanded and collapsed, and at a phone width.
//
// The pictures are of /health: its sidebar link is the current page, so the
// selected item is in the picture, and once both its answers have arrived
// ("unknown" from the api, which the spec answers itself, below; the core's
// fixed player's username) nothing on it changes. One screen is enough: the
// layout is the same around every one.
//
// Baselines are made by the suite's own container: ./bin/mise run
// web-client:e2e -- --update-snapshots, then look at each changed picture.

// How far a pixel's colour may move before it counts as changed: 0.02, not
// Playwright's 0.2. pixelmatch counts a pixel as changed when its YIQ
// distance from the baseline's is over 35215 × threshold², 1409 at 0.2 and
// 14 at 0.02. The top bar and the sidebar are on bg-panel over the page's
// bg-app: those two are 25 apart, so at 0.2 (and at 0.05, 88) losing the
// panels passed. So did the selected item's accent-soft swapped for bg-hover
// (the same brightness, only the hue differs) at 0.2.
const threshold = 0.02

const desktop = { width: 1280, height: 800 }
// An iPhone's width, under the layout's 768px breakpoint (AppLayout.css).
const phone = { width: 390, height: 844 }

// Opens /health and waits until it is drawn: both answers in, fonts loaded.
//
// The page's request to the api fails here, at once, in the browser, so the
// page says the api's health is unknown whatever the network does. Left to
// vite preview, the answer waited on its proxy looking up the host `api`,
// which isn't on the suite's network: 3ms on a laptop, but about 5s on CI's
// runners (a resolver that never answers), so the page was still checking
// when the test stopped waiting, and every picture failed. And were an api
// reachable as `api` (the dev stack up in the same checkout), the page would
// say "healthy". The route is the browser context's, not the page's: only
// the context's sees requests that go through the app's service worker. The
// test fails if it answered nothing, so it can't silently stop applying.
async function openHealth(page: Page) {
  const health = new HealthPage(page)
  const layout = new AppLayout(page)
  let apiRequests = 0
  await page.context().route('**/api/**', (route) => {
    apiRequests += 1
    return route.abort()
  })
  await health.goto()
  await expect(health.unknown).toBeVisible()
  expect(apiRequests, 'api requests the spec answered').toBeGreaterThan(0)
  await expect(health.coreLoaded).toBeVisible()
  await layout.waitForFonts()
  return layout
}

test.describe('at a desktop width', () => {
  test.use({ viewport: desktop })

  test('the sidebar shows, expanded, with the current page selected, and the brand on the left', async ({
    page,
  }) => {
    const layout = await openHealth(page)

    await expect(layout.navigation).toBeVisible()
    await expect(layout.sidebarToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(layout.link('Health')).toHaveAttribute('aria-current', 'page')
    await expect(page).toHaveScreenshot('desktop-expanded.png', { threshold })
  })

  test('collapsed, the sidebar shows only the icons', async ({ page }) => {
    const layout = await openHealth(page)

    await layout.sidebarToggle.click()
    // Off the toggle, so the picture has no hover on it.
    await page.mouse.move(desktop.width - 1, desktop.height - 1)

    await expect(layout.sidebarToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page).toHaveScreenshot('desktop-collapsed.png', { threshold })
  })
})

test.describe('at a phone width', () => {
  test.use({ viewport: phone })

  test('there is no sidebar, and the brand is centred', async ({ page }) => {
    const layout = await openHealth(page)

    await expect(layout.brand).toBeVisible()
    await expect(layout.navigation).toBeHidden()
    await expect(layout.sidebarToggle).toBeHidden()
    await expect(page).toHaveScreenshot('phone.png', { threshold })
  })
})
