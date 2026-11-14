import { expect, test } from '../pages/test.ts'
import { App, AppLayout, StartPage } from '../pages/app.ts'
import { StorageHarness } from '../pages/storage.ts'

// What only a real browser can show about the layout around every screen
// (src/components/AppLayout.tsx): which parts its breakpoint shows, a media
// query in AppLayout.css that jsdom doesn't apply. Everything else it does
// (the links, the toggle, aria-expanded, the current page, the one <main>)
// is a component test. How it looks is pinned by no test: screenshots are
// only for the design system page (web-client/CLAUDE.md).
//
// On the start page, which is blank and asks nothing of the network.

const desktop = { width: 1280, height: 800 }
// An iPhone's width, under the layout's 768px breakpoint (AppLayout.css).
const phone = { width: 390, height: 844 }

test.describe('at a desktop width', () => {
  test.use({ viewport: desktop })

  test('the top bar shows the sidebar’s toggle and the brand, and the sidebar shows its links', async ({
    page,
  }) => {
    const layout = new AppLayout(page)
    await new StartPage(page).goto()

    await expect(layout.brand).toBeVisible()
    await expect(layout.sidebarToggle).toBeVisible()
    await expect(layout.navigation).toBeVisible()
    for (const name of ['Health', 'Settings', 'Design system']) {
      await expect(layout.link(name)).toBeVisible()
    }
  })
})

test.describe('at a phone width', () => {
  test.use({ viewport: phone })

  test('there is no sidebar and no toggle, only the brand', async ({
    page,
  }) => {
    const layout = new AppLayout(page)
    await new StartPage(page).goto()

    await expect(layout.brand).toBeVisible()
    await expect(layout.navigation).toBeHidden()
    await expect(layout.sidebarToggle).toBeHidden()
  })
})

// This device's user's mark, at the top bar's right end: the initials on
// phones, the initials and the username wider (src/components/UserMark.tsx). The app's own first launch stores the user;
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
      await new StartPage(page).goto()
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
        await new StartPage(page).goto()
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

      test('on a device with a user, the start page shows the user’s mark without waiting for the core', async ({
        context,
        page,
      }) => {
        await new StartPage(page).goto()
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
        await new StartPage(later).goto()

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
      await new StartPage(page).goto()
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
