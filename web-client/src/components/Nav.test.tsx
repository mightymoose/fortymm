import { render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Nav } from './Nav.tsx'

test('a navigation is named by its label, a link per page, the current page marked as such', () => {
  render(
    <Nav
      label="Tournament"
      items={[
        { label: 'Overview', href: '/overview', current: true },
        { label: 'Schedule', href: '/schedule' },
      ]}
    />,
  )

  const nav = screen.getByRole('navigation', { name: 'Tournament' })
  const overview = within(nav).getByRole('link', { name: 'Overview' })
  const schedule = within(nav).getByRole('link', { name: 'Schedule' })
  expect(overview).toHaveAttribute('aria-current', 'page')
  expect(schedule).not.toHaveAttribute('aria-current')
  expect(schedule).toHaveAttribute('href', '/schedule')
})
