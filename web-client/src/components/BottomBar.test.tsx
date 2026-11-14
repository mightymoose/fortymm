import { expect, test } from 'vitest'
import { AppLayoutPage } from './AppLayout.page.tsx'

// The bottom bar alone. That it shows on phones only, at the bottom of the
// screen, is the browser suite's (e2e/tests/app-layout.spec.ts).
test('the bottom bar is a navigation named apart from the sidebar’s, with one link, to the dashboard', async () => {
  const page = new AppLayoutPage()
  page.renderBottomBar()

  const links = await page.bottomBarLinks()

  expect(
    links.map((link) => [link.textContent, link.getAttribute('href')]),
  ).toEqual([['Dashboard', '/dashboard']])
  expect(links[0]).not.toHaveAttribute('aria-current')
})

test('on the dashboard, the bottom bar’s link is the current page', async () => {
  const page = new AppLayoutPage()
  page.renderBottomBar({ path: '/dashboard' })

  const [dashboard] = await page.bottomBarLinks()

  expect(dashboard).toHaveAttribute('aria-current', 'page')
})
