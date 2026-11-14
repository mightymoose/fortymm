import { render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Breadcrumbs } from './Breadcrumbs.tsx'

test('breadcrumbs are a navigation named Breadcrumb: a link per step above, then this page, current and not a link', () => {
  render(
    <Breadcrumbs
      trail={[
        { label: 'Spring Open', href: '/spring-open' },
        { label: 'Open singles', href: '/open-singles' },
      ]}
      current="Round of 16"
    />,
  )

  const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
  expect(
    within(nav)
      .getAllByRole('link')
      .map((link) => [link.textContent, link.getAttribute('href')]),
  ).toEqual([
    ['Spring Open', '/spring-open'],
    ['Open singles', '/open-singles'],
  ])
  expect(within(nav).getByText('Round of 16')).toHaveAttribute(
    'aria-current',
    'page',
  )
  expect(within(nav).queryByRole('link', { name: 'Round of 16' })).toBeNull()
})
