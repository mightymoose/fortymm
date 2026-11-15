import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { AppLayoutPage } from '../AppLayout.page.tsx'

const sidebar = {
  sidebarExpanded: true,
  sidebarId: 'sidebar',
  onToggleSidebar: () => {},
}

test('the top bar’s FortyMM brand links to the dashboard, at /', async () => {
  const page = new AppLayoutPage()
  page.renderTopBar(sidebar)

  expect(await page.brand()).toHaveAttribute('href', '/')
})

test('the top bar’s brand is not a heading: each screen has its own', async () => {
  const page = new AppLayoutPage()
  page.renderTopBar(sidebar)

  expect(await page.brand()).toBeVisible()
  expect(screen.queryAllByRole('heading')).toHaveLength(0)
})

test('the top bar’s sidebar toggle says whether the sidebar is expanded, controls it, and comes before the brand', async () => {
  const page = new AppLayoutPage()
  page.renderTopBar({ ...sidebar, sidebarExpanded: false })

  const toggle = await page.sidebarToggle()
  expect(await page.banner()).toContainElement(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(toggle).toHaveAttribute('aria-controls', 'sidebar')
  expect(
    toggle.compareDocumentPosition(await page.brand()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
})

test('pressing the top bar’s sidebar toggle asks the layout to toggle the sidebar', async () => {
  const user = userEvent.setup()
  const onToggleSidebar = vi.fn()
  const page = new AppLayoutPage()
  page.renderTopBar({ ...sidebar, onToggleSidebar })

  await user.click(await page.sidebarToggle())

  expect(onToggleSidebar).toHaveBeenCalledOnce()
})
