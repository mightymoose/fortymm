import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NavigationMenuPanel } from './NavigationMenuPanel'

const items = [
  {
    title: 'Match recorder',
    description: 'Track scores.',
    href: '/match-recorder',
  },
  { title: 'Club tools', description: 'Member rosters.', href: '/clubs' },
]

describe('NavigationMenuPanel', () => {
  it('is a named list of links', () => {
    render(<NavigationMenuPanel label="Product" items={items} />)

    const list = screen.getByRole('list', { name: 'Product' })
    expect(list).toHaveClass('nav-menu')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('links each title and its description to its page', () => {
    render(<NavigationMenuPanel label="Product" items={items} />)

    expect(
      screen
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['Match recorderTrack scores.', '/match-recorder'],
      ['Club toolsMember rosters.', '/clubs'],
    ])
  })
})
