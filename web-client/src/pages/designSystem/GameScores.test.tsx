import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GameScores } from './GameScores'
import { findMatch } from './match'

describe('GameScores', () => {
  it('lists every game, with the game in play marked now', () => {
    render(<GameScores match={findMatch('c2')} />)

    const table = screen.getByRole('table', {
      name: 'Game scores, Patel, Meera vs Wójcik-Szymańska, Agnieszka',
    })
    const headers = within(table).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual([
      'Player',
      'Game 1',
      'Game 2',
      'Game 3',
      'Game 4',
      'Game 5 · now',
    ])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => row.textContent)).toEqual([
      'Patel1161199',
      'Wójcik-Szymańska8119119',
    ])
  })

  it('says when no games have been played', () => {
    render(<GameScores match={findMatch('a3')} />)

    expect(screen.getByText('No games played yet.')).toBeVisible()
  })
})
