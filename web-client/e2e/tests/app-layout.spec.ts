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
// (no api behind vite preview, so "unknown"; the core's fixed player's
// username) nothing on it changes. One screen is enough: the layout is the
// same around every one.
//
// Baselines are made by the suite's own container: ./bin/mise run
// web-client:e2e -- --update-snapshots, then look at each changed picture.

// How far a pixel's colour may move before it counts as changed: 0.05
// (pixelmatch's YIQ distance), not Playwright's 0.2. At 0.2, the selected
// item's accent-soft swapped for bg-hover passed: the two have the same
// brightness, and only the hue differs.
const threshold = 0.05

const desktop = { width: 1280, height: 800 }
// An iPhone's width, under the layout's 768px breakpoint (AppLayout.css).
const phone = { width: 390, height: 844 }

// Opens /health and waits until it is drawn: both answers in, fonts loaded.
async function openHealth(page: Page) {
  const health = new HealthPage(page)
  const layout = new AppLayout(page)
  await health.goto()
  await expect(health.unknown).toBeVisible()
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
