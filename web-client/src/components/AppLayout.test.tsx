import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { showNewVersionOf } from '../new-version.ts'
import { AppLayoutPage } from './AppLayout.page.tsx'

test('the layout shows the top bar and the sidebar, and its content in the page’s one main landmark', async () => {
  const page = new AppLayoutPage()
  page.render(<h1>A screen</h1>)

  expect(await page.brand()).toBeVisible()
  expect(await page.navigation()).toBeVisible()
  const main = await page.main()
  expect(screen.getAllByRole('main')).toEqual([main])
  expect(
    within(main).getByRole('heading', { level: 1, name: 'A screen' }),
  ).toBeVisible()
})

test('the sidebar starts expanded, and the toggle in the top bar collapses it and expands it again', async () => {
  const user = userEvent.setup()
  const page = new AppLayoutPage()
  page.render(<h1>A screen</h1>)
  const toggle = await page.sidebarToggle()

  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(toggle).toHaveAttribute('aria-controls', (await page.navigation()).id)

  await user.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  for (const name of ['Dashboard', 'Health', 'Settings', 'Design system']) {
    expect(await page.link(name)).toBeInTheDocument()
  }

  await user.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
})

test('when a new version is ready, the layout shows the notice over the screen, and its Reload asks for the new version', async () => {
  const user = userEvent.setup()
  const reload = vi.fn()
  showNewVersionOf({
    ready: () => true,
    subscribe: () => () => {},
    reload,
    dismiss: () => {},
  })
  const page = new AppLayoutPage()
  page.render(<h1>A screen</h1>)

  expect(await page.newVersionNotice()).toBeVisible()
  expect(
    within(await page.main()).getByRole('heading', { name: 'A screen' }),
  ).toBeVisible()

  await user.click(await page.reload())
  expect(reload).toHaveBeenCalledOnce()
})
