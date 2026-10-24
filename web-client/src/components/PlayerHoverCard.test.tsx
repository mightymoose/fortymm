import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlayerHoverCard } from './PlayerHoverCard'

const player = {
  name: 'Tien Nguyen',
  club: 'Brooklyn TT',
  joinedYear: 2024,
  rating: 1620,
  wins: 14,
  losses: 3,
}

describe('PlayerHoverCard', () => {
  it('is a group named by the player, with their avatar', () => {
    render(<PlayerHoverCard player={player} tone="blue" />)

    const card = screen.getByRole('group', { name: 'Tien Nguyen' })
    expect(card).toHaveClass('hover-card')
    expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent(
      'Tien Nguyen',
    )
    expect(screen.getByRole('img', { name: 'Tien Nguyen' })).toHaveClass(
      'avatar--lg',
      'avatar--blue',
    )
  })

  it('shows the club and the year they joined', () => {
    render(<PlayerHoverCard player={player} />)

    expect(screen.getByText('Brooklyn TT · Joined 2024')).toBeInTheDocument()
  })

  it('lists the rating and the win-loss record', () => {
    render(<PlayerHoverCard player={player} />)

    expect(
      screen.getAllByRole('term').map((term) => term.textContent),
    ).toEqual(['Rating', 'W-L'])
    expect(
      screen.getAllByRole('definition').map((value) => value.textContent),
    ).toEqual(['1620', '14–3'])
  })
})
