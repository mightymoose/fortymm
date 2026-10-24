import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { findMatch } from './match'
import { MatchRow } from './MatchRow'

describe('MatchRow', () => {
  it('names a live match by its players and shows each side’s games, points and server', () => {
    render(<MatchRow match={findMatch('c2')} />)

    const row = screen.getByRole('article', {
      name: 'Patel, Meera vs Wójcik-Szymańska, Agnieszka',
    })
    expect(row).toHaveTextContent('LiveTable 3 · Round of 32 · Game 5')
    expect(screen.getAllByLabelText('2 games won')).toHaveLength(2)
    expect(screen.getAllByLabelText('9 points in this game')).toHaveLength(2)
    expect(screen.getByRole('img', { name: 'Serving' })).toBeVisible()
  })

  it('hides the status line when asked', () => {
    render(<MatchRow match={findMatch('c2')} headHidden />)

    expect(screen.getByText('Live')).not.toBeVisible()
  })

  it('marks the winner and loser of a final, with no points', () => {
    const { container } = render(<MatchRow match={findMatch('a1')} />)

    expect(screen.getByLabelText('3 games won')).toBeVisible()
    expect(screen.getByLabelText('1 games won')).toBeVisible()
    expect(screen.queryByLabelText(/points in this game/)).not.toBeInTheDocument()
    expect(container.querySelector('.fm-match__p.w')).toHaveTextContent('Nguyen, Thanh')
  })

  it('says when an offline scorer last reported', () => {
    render(<MatchRow match={findMatch('d1')} />)

    expect(screen.getByText('Scorer offline')).toBeVisible()
    expect(screen.getByRole('article')).toHaveTextContent(
      'Table 4 · Quarterfinal · last update 11:42',
    )
  })

  it('shows an upcoming match’s start time and rest', () => {
    render(<MatchRow match={findMatch('c3')} />)

    expect(screen.getByRole('article')).toHaveTextContent('12:15Table 3 · Semifinal')
    expect(screen.getByText(/rests until/)).toHaveTextContent('Lindqvist rests until 12:10')
  })
})
