import userEvent from '@testing-library/user-event'
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

test('the sidebar starts expanded, and its toggle collapses it and expands it again', async () => {
  const user = userEvent.setup()
  const page = new AppLayoutPage()
  page.renderSidebar()
  const toggle = await page.sidebarToggle()

  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(toggle).toHaveAttribute('aria-controls', (await page.navigation()).id)

  await user.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')

  await user.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
})

test('collapsed, each of the sidebar’s links keeps its name', async () => {
  const user = userEvent.setup()
  const page = new AppLayoutPage()
  page.renderSidebar()

  await user.click(await page.sidebarToggle())

  expect(await page.sidebarToggle()).toHaveAttribute('aria-expanded', 'false')
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
