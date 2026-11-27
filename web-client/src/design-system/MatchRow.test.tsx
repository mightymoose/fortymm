import { render, screen } from '@testing-library/react'
import { describe, expect, vi } from 'vitest'
import { it } from '../setupTests.ts'
import { type MatchPlayer, MatchRow } from './MatchRow.tsx'

const players: [MatchPlayer, MatchPlayer] = [
  { name: 'Patel, Meera', games: 1, points: 9 },
  { name: 'Park, Ji-ho', games: 2, points: 1, isServing: true },
]

describe('MatchRow', () => {
  it('is an article named after both players', () => {
    render(<MatchRow state="live" players={players} />)
    expect(screen.getByRole('article', { name: 'Patel, Meera vs Park, Ji-ho' })).toBeInTheDocument()
  })

  it('names the games a player has won', () => {
    render(<MatchRow state="live" players={players} />)
    expect(screen.getByLabelText('1 game won')).toHaveTextContent('1')
  })

  it("names the points in the game in play", () => {
    render(<MatchRow state="live" players={players} />)
    expect(screen.getByLabelText('1 point in this game')).toHaveTextContent('1')
  })

  it('marks the server', () => {
    render(<MatchRow state="live" players={players} />)
    expect(screen.getByRole('img', { name: 'Serving' })).toBeInTheDocument()
  })

  it('shows no score for a match in conflict', () => {
    render(<MatchRow state="conflict" players={players} />)
    expect(screen.queryByLabelText('1 game won')).not.toBeInTheDocument()
  })

  it('has no Game scores button without onGameScoresToggle', () => {
    render(<MatchRow state="live" players={players} />)
    expect(screen.queryByRole('button', { name: 'Game scores' })).not.toBeInTheDocument()
  })

  it('calls onGameScoresToggle when Game scores is pressed', async ({ user }) => {
    const onGameScoresToggle = vi.fn()
    render(<MatchRow state="live" players={players} onGameScoresToggle={onGameScoresToggle} />)
    await user.click(screen.getByRole('button', { name: 'Game scores' }))
    expect(onGameScoresToggle).toHaveBeenCalledOnce()
  })

  it('says whether the game scores are expanded', () => {
    render(
      <MatchRow state="live" players={players} isGameScoresExpanded onGameScoresToggle={() => {}}>
        11–7, 9–11
      </MatchRow>,
    )
    expect(screen.getByRole('button', { name: 'Game scores' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('shows the game scores when expanded', () => {
    render(
      <MatchRow state="live" players={players} isGameScoresExpanded onGameScoresToggle={() => {}}>
        11–7, 9–11
      </MatchRow>,
    )
    expect(screen.getByText('11–7, 9–11')).toBeInTheDocument()
  })

  it('hides the game scores when collapsed', () => {
    render(
      <MatchRow state="live" players={players} onGameScoresToggle={() => {}}>
        11–7, 9–11
      </MatchRow>,
    )
    expect(screen.queryByText('11–7, 9–11')).not.toBeInTheDocument()
  })
})
