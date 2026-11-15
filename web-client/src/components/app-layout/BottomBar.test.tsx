import { expect, test } from 'vitest'
import { AppLayoutPage } from '../AppLayout.page.tsx'

// The bottom bar alone. That it shows on phones only, at the bottom of the
// screen, is the browser suite's (e2e/tests/app-layout.spec.ts).
test('the bottom bar is a navigation named apart from the sidebar’s, with the links to the dashboard at / and the matches list at /matches, neither current on another page, then New match, to /matches/new', async () => {
  const page = new AppLayoutPage()
  page.renderBottomBar({ path: '/settings' })

  const links = await page.bottomBarLinks()

  expect(
    links.map((link) => [link.textContent, link.getAttribute('href')]),
  ).toEqual([
    ['Dashboard', '/'],
    ['Matches', '/matches'],
    ['New match', '/matches/new'],
  ])
  expect(links[0]).not.toHaveAttribute('aria-current')
  expect(links[1]).not.toHaveAttribute('aria-current')
})

test('on the dashboard, at /, the bottom bar’s link is the current page', async () => {
  const page = new AppLayoutPage()
  page.renderBottomBar({ path: '/' })

  const [dashboard] = await page.bottomBarLinks()

  expect(dashboard).toHaveAttribute('aria-current', 'page')
})

test('on the matches list, at /matches, the bottom bar’s Matches link is the current page, and the dashboard’s is not', async () => {
  const page = new AppLayoutPage()
  page.renderBottomBar({ path: '/matches' })

  const [dashboard, matches] = await page.bottomBarLinks()

  expect(matches).toHaveAttribute('aria-current', 'page')
  expect(dashboard).not.toHaveAttribute('aria-current')
})