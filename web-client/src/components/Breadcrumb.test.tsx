import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Breadcrumb } from './Breadcrumb'

const items = [
  { label: 'Tournaments', href: '/tournaments' },
  { label: 'April Spring Open', href: '/tournaments/april-spring-open' },
  { label: 'Round 3' },
]

describe('Breadcrumb', () => {
  it('is a navigation landmark named Breadcrumb, holding a list', () => {
    render(<Breadcrumb items={items} />)

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(nav).toHaveClass('breadcrumb')
    expect(
      within(nav)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Tournaments/', 'April Spring Open/', 'Round 3'])
  })

  it('links every item but the last to its page', () => {
    render(<Breadcrumb items={items} />)

    expect(
      screen
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['Tournaments', '/tournaments'],
      ['April Spring Open', '/tournaments/april-spring-open'],
    ])
  })

  it('marks the last item as the current page, with no link', () => {
    render(<Breadcrumb items={items} />)

    const current = screen.getByText('Round 3')
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(current.closest('a')).toBeNull()
  })

  it('hides the separators from assistive tech', () => {
    const { container } = render(<Breadcrumb items={items} />)

    const separators = container.querySelectorAll('.breadcrumb-separator')
    expect(separators).toHaveLength(2)
    for (const separator of separators) {
      expect(separator).toHaveAttribute('aria-hidden', 'true')
    }
  })
})
