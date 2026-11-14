import { expect, test } from 'vitest'
import { AppLayoutPage } from './AppLayout.page.tsx'

test('the sidebar links to the health, settings and design system pages, in that order', async () => {
  const page = new AppLayoutPage()
  page.renderSidebar()

  const links = await page.links()

  expect(
    links.map((link) => [link.textContent, link.getAttribute('href')]),
  ).toEqual([
    ['Health', '/health'],
    ['Settings', '/settings'],
    ['Design system', '/design-system'],
  ])
})

test('collapsed, each of the sidebar’s links keeps its name', async () => {
  const page = new AppLayoutPage()
  page.renderSidebar({ expanded: false })

  for (const name of ['Health', 'Settings', 'Design system']) {
    expect(await page.link(name)).toBeInTheDocument()
  }
})

test('the link to the current page is marked as the current page, and no other', async () => {
  const page = new AppLayoutPage()
  page.renderSidebar({ path: '/settings' })

  expect(await page.link('Settings')).toHaveAttribute('aria-current', 'page')
  expect(await page.link('Health')).not.toHaveAttribute('aria-current')
  expect(await page.link('Design system')).not.toHaveAttribute('aria-current')
})
