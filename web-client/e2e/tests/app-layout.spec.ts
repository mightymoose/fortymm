import { expect, test } from '../pages/test.ts'
import type { Page } from '@playwright/test'
import { App, AppLayout, DashboardPage, NewMatchPage } from '../pages/app.ts'
import { StorageHarness } from '../pages/storage.ts'

// What only a real browser can show about the layout around every screen
// (src/components/AppLayout.tsx): which parts its breakpoint shows, a media
// query in AppLayout.css that jsdom doesn't apply. Everything else it does
// (the links, the toggle, aria-expanded, the current page, the one <main>)
// is a component test. How it looks is pinned by no test: screenshots are
// only for the design system page (web-client/CLAUDE.md).
//
// On the dashboard and the new match screen, which ask nothing of the
// network. Which way to the new match screen shows at which width (the
// dashboard's button wider than a phone, the bottom bar's on a phone) is
// the breakpoint's too.

const desktop = { width: 1280, height: 800 }
// An iPhone's width, under the layout's 768px breakpoint (AppLayout.css).
const phone = { width: 390, height: 844 }

test.describe('at a desktop width', () => {
  test.use({ viewport: desktop })

  test('the top bar shows the sidebar’s toggle and the brand, and the sidebar shows its links', async ({
    page,
  }) => {
    const layout = new AppLayout(page)
    await new DashboardPage(page).goto()

    await expect(layout.brand).toBeVisible()
    await expect(layout.sidebarToggle).toBeVisible()
    await expect(layout.navigation).toBeVisible()
    for (const name of ['Dashboard', 'Health', 'Settings', 'Design system']) {
      await expect(layout.link(name)).toBeVisible()
    }
  })

  test('there is no bottom bar', async ({ page }) => {
    const layout = new AppLayout(page)
    await new DashboardPage(page).goto()
    await expect(layout.navigation).toBeVisible()

    await expect(layout.bottomBar).toHaveCount(0)
  })

  test('the dashboard shows New match beside its heading, which opens the new match screen', async ({
    page,
  }) => {
    const layout = new AppLayout(page)
    const dashboard = new DashboardPage(page)
    await dashboard.goto()

    await expect(dashboard.newMatch).toBeInViewport({ ratio: 1 })
    await expect(layout.bottomBarNewMatch).toHaveCount(0)
    await dashboard.newMatch.click()

    await expect(new NewMatchPage(page).heading).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/matches/new')
  })
})

// From the narrowest phone to a desktop, neither the dashboard nor the new
// match screen is wider than the screen: nothing to scroll sideways to. At
// 768px, the breakpoint itself, the layout is the desktop's.
for (const width of [320, 768, 1280]) {
  test.describe(`at ${width}px wide`, () => {
    test.use({ viewport: { width, height: 800 } })

    for (const [name, open] of [
      ['the dashboard', (page: Page) => new DashboardPage(page).goto()],
      ['the new match screen', (page: Page) => new NewMatchPage(page).goto()],
    ] as const) {
      test(`${name} has no horizontal scroll`, async ({ page }) => {
        await open(page)
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        )
        expect(overflow).toBe(0)
      })
    }
  })
}

test.describe('at a phone width', () => {
  test.use({ viewport: phone })

  test('there is no sidebar and no toggle, only the brand', async ({
    page,
  }) => {
    const layout = new AppLayout(page)
    await new DashboardPage(page).goto()

    await expect(layout.brand).toBeVisible()
    await expect(layout.navigation).toHaveCount(0)
    await expect(layout.sidebarToggle).toBeHidden()
  })

  test('the bottom bar holds two links, the dashboard then New match at its right end, wholly on screen at the bottom, each at least 44px to tap', async ({
    page,
  }) => {
    const layout = new AppLayout(page)
    await new DashboardPage(page).goto()

    await expect(layout.bottomBar).toBeInViewport({ ratio: 1 })
    const links = layout.bottomBar.getByRole('link')
    await expect(links).toHaveCount(2)
    const dashboard = layout.bottomBar.getByRole('link', { name: 'Dashboard' })
    await expect(dashboard).toHaveAttribute('href', '/')
    await expect(layout.bottomBarNewMatch).toHaveAttribute(
      'href',
      '/matches/new',
    )
    const bar = (await layout.bottomBar.boundingBox())!
    expect(bar.y + bar.height).toBeCloseTo(phone.height, 0)
    for (const link of [dashboard, layout.bottomBarNewMatch]) {
      await expect(link).toBeInViewport({ ratio: 1 })
      const box = (await link.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    // New match at the right end: its right edge within the bar's 16px.
    const newMatch = (await layout.bottomBarNewMatch.boundingBox())!
    const dashboardBox = (await dashboard.boundingBox())!
    expect(newMatch.x).toBeGreaterThanOrEqual(
      dashboardBox.x + dashboardBox.width,
    )
    expect(phone.width - (newMatch.x + newMatch.width)).toBeLessThanOrEqual(16)
  })

  test('the dashboard’s own New match is not displayed; the bottom bar’s opens the new match screen', async ({
    page,
  }) => {
    const layout = new AppLayout(page)
    const dashboard = new DashboardPage(page)
    await dashboard.goto()
    await expect(dashboard.heading).toBeVisible()

    await expect(dashboard.newMatch).toHaveCount(0)
    await layout.bottomBarNewMatch.click()

    await expect(new NewMatchPage(page).heading).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/matches/new')
  })

  test('on the new match screen, scrolled to its end, the form’s last part is above the bottom bar, and Start match is at least 44px to tap', async ({
    page,
  }) => {
    const layout = new AppLayout(page)
    const newMatch = new NewMatchPage(page)
    await newMatch.goto()
    await expect(newMatch.form).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))

    await expect(layout.bottomBar).toBeInViewport({ ratio: 1 })
    const last = newMatch.form.locator('*').last()
    const box = (await last.boundingBox())!
    const bar = (await layout.bottomBar.boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y)
    const start = (await newMatch.startMatch.boundingBox())!
    expect(start.height).toBeGreaterThanOrEqual(44)
    expect(start.y + start.height).toBeLessThanOrEqual(bar.y)
  })

  test('scrolled to the end of a long page, its last content is above the bottom bar, not under it', async ({
    page,
  }) => {
    const layout = new AppLayout(page)
    // The design system page's colour tab: long, and asks nothing of the
    // network.
    await page.goto('/design-system/colour')
    const last = page.getByRole('main').locator('*').last()
    await expect(last).toBeAttached()
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))

    await expect(layout.bottomBar).toBeInViewport({ ratio: 1 })
    const box = (await last.boundingBox())!
    const bar = (await layout.bottomBar.boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y)
  })
})

// This device's user's mark, at the top bar's right end: the initials on
// phones, the initials and the username wider (src/components/app-layout/UserMark.tsx). The app's own first launch stores the user;
// the "harness" build's storage page gives the username the core makes for
// this device's key. Where the mark and the brand are is measured from their
// boxes, never from a style.
test.describe('this device’s user’s mark', () => {
  test.use({ build: 'harness' })

  // The brand's centre is the viewport's, to within a pixel.
  async function expectBrandCentred(layout: AppLayout, width: number) {
    const box = (await layout.brand.boundingBox())!
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(1)
  }

  test.describe('at a phone width', () => {
    test.use({ viewport: phone })

    test('after the first launch, the top bar shows the user’s mark, its initials only, wholly on screen, clear of the brand, with the brand still centred', async ({
      context,
      page,
    }) => {
      const layout = new AppLayout(page)
      await new DashboardPage(page).goto()
      expect(await new App(page).firstLaunch()).toEqual({
        ok: true,
        outcome: 'made',
      })
      const storage = new StorageHarness(await context.newPage())
      await storage.open()
      const { username } = await storage.expectedUser()

      const mark = layout.userMark(username)
      await expect(mark).toBeInViewport({ ratio: 1 })
      await expect(layout.userMarkName(username)).toBeHidden()
      const markBox = (await mark.boundingBox())!
      const brandBox = (await layout.brand.boundingBox())!
      expect(markBox.x).toBeGreaterThanOrEqual(brandBox.x + brandBox.width)
      await expectBrandCentred(layout, phone.width)
    })

    test.describe('with this tab’s launch failing', () => {
      // So the page fetches the core itself, where the route below refuses
      // it, rather than from the service worker's kept copy.
      test.use({ serviceWorkers: 'block' })

      test('with no user, the top bar shows only the brand, centred as with the mark', async ({
        page,
      }) => {
        await page.route('**/*.wasm', (route) => route.abort())
        const layout = new AppLayout(page)
        await new DashboardPage(page).goto()
        expect(await new App(page).firstLaunch()).toEqual({
          ok: false,
          reason: 'core-unavailable',
        })

        await expect(layout.banner.getByRole('link')).toHaveCount(1)
        await expect(layout.brand).toBeVisible()
        await expectBrandCentred(layout, phone.width)
      })
    })

    test.describe('with the shared core held back', () => {
      // So the page fetches the core itself, where the route below holds
      // it, rather than from the service worker's kept copy.
      test.use({ serviceWorkers: 'block' })

      test('on a device with a user, the dashboard shows the user’s mark without waiting for the core', async ({
        context,
        page,
      }) => {
        await new DashboardPage(page).goto()
        expect(await new App(page).firstLaunch()).toEqual({
          ok: true,
          outcome: 'made',
        })
        const storage = new StorageHarness(await context.newPage())
        await storage.open()
        const { username } = await storage.expectedUser()
        // From now on, the core's module arrives 10 seconds late.
        await context.route('**/*.wasm', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 10_000))
          await route.continue().catch(() => {})
        })

        const later = await context.newPage()
        await new DashboardPage(later).goto()

        await expect(new AppLayout(later).userMark(username)).toBeVisible({
          timeout: 3_000,
        })
      })
    })
  })

  test.describe('at a desktop width', () => {
    test.use({ viewport: desktop })

    test('after the first launch, the top bar shows the user’s mark with the full username, wholly on screen, at the bar’s right end, clear of the toggle and the brand', async ({
      context,
      page,
    }) => {
      const layout = new AppLayout(page)
      await new DashboardPage(page).goto()
      expect(await new App(page).firstLaunch()).toEqual({
        ok: true,
        outcome: 'made',
      })
      const storage = new StorageHarness(await context.newPage())
      await storage.open()
      const { username } = await storage.expectedUser()

      const mark = layout.userMark(username)
      await expect(mark).toBeInViewport({ ratio: 1 })
      await expect(layout.userMarkName(username)).toBeInViewport({ ratio: 1 })
      const markBox = (await mark.boundingBox())!
      const brandBox = (await layout.brand.boundingBox())!
      const toggleBox = (await layout.sidebarToggle.boundingBox())!
      expect(markBox.x).toBeGreaterThanOrEqual(brandBox.x + brandBox.width)
      expect(markBox.x).toBeGreaterThanOrEqual(toggleBox.x + toggleBox.width)
      // At the right end: its right edge within the screen's 16px margin.
      expect(desktop.width - (markBox.x + markBox.width)).toBeLessThanOrEqual(16)
    })
  })
})
