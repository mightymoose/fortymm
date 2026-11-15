import { within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AppLayoutPage } from './AppLayout.page.tsx'
import { UserMarkLink } from './UserMarkLink.tsx'

// The user's mark in the top bar, given a username. Which username it gets
// from the store is UserMark.test.tsx; that phones show only the initials
// and wider screens the username too is the browser suite's
// (e2e/tests/app-layout.spec.ts).
const sidebar = {
  sidebarExpanded: true,
  sidebarId: 'sidebar',
  onToggleSidebar: () => {},
}

test('with a username, the top bar has one link to /settings showing the initials and the full username, named with the username alone', async () => {
  const page = new AppLayoutPage()
  page.renderTopBar({
    ...sidebar,
    user: <UserMarkLink username="agile-meerkat-4b8z" />,
  })

  const mark = await page.userMark('agile-meerkat-4b8z')
  expect(mark).toHaveAttribute('href', '/settings')
  expect(mark).toHaveAccessibleName('agile-meerkat-4b8z')
  expect(within(mark).getByText('AM')).toBeInTheDocument()
  expect(within(mark).getByText('agile-meerkat-4b8z')).toBeInTheDocument()
  expect(mark).not.toHaveAttribute('aria-current')
})

test('on /settings, the user’s mark is the current page', async () => {
  const page = new AppLayoutPage()
  page.renderTopBar(
    { ...sidebar, user: <UserMarkLink username="agile-meerkat-4b8z" /> },
    { path: '/settings' },
  )

  expect(await page.userMark('agile-meerkat-4b8z')).toHaveAttribute(
    'aria-current',
    'page',
  )
})

test('with no username, or one with no initials, the top bar has no user’s mark, only the brand', async () => {
  for (const username of [null, '']) {
    const page = new AppLayoutPage()
    const { unmount } = page.renderTopBar({
      ...sidebar,
      user: <UserMarkLink username={username} />,
    })

    expect(await page.bannerLinks()).toEqual([await page.brand()])
    unmount()
  }
})
