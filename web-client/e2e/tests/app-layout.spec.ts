import { expect, test } from '../pages/test.ts'
import { AppLayout, StartPage } from '../pages/app.ts'

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
