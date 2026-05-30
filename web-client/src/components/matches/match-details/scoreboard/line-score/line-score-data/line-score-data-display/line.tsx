import { cn } from '@/lib/utils'

import type { GameScore, HeaderSide } from '../line-score-data-query'
import { Participant } from '../../../participant'
import { PlayerScore } from '../../../player-score'

export interface LineProps {
  bestOf: number
  sides: HeaderSide[]
  games: GameScore[][]
  // The side this row renders.
  side: HeaderSide
}

// The side index a game went to is the one with the most points.
const winnerOf = (game: GameScore[]) =>
  game.reduce((best, s) => (s.points > best.points ? s : best)).sideNumber

const pointsFor = (game: GameScore[], sideNumber: number) =>
  game.find((s) => s.sideNumber === sideNumber)?.points ?? 0

export const Line = ({ bestOf, sides, games, side }: LineProps) => {
  const sideNumber = sides.indexOf(side)
  // Pad to best_of so every line renders the same number of cells.
  const slots = Array.from({ length: bestOf }, (_, i) => games[i] ?? null)

  // A side wins the match once it clinches a majority of best_of games.
  const gamesToWin = Math.floor(bestOf / 2) + 1
  const gamesWon = games.filter((game) => winnerOf(game) === sideNumber).length
  const winner = gamesWon >= gamesToWin

  return (
    <>
      <Participant size="line" username={side.username} won={winner} />
      {slots.map((game, i) => {
        if (!game) {
          return (
            <div key={i} className="md-games__cell md-games__cell--empty">
              —
            </div>
          )
        }
        const cellWin = winnerOf(game) === sideNumber
        return (
          <PlayerScore
            key={i}
            className={cn('md-games__cell', !cellWin && 'md-games__cell--loss')}
            label={`${side.username}, game ${i + 1}`}
            score={pointsFor(game, sideNumber)}
            won={cellWin}
          />
        )
      })}
    </>
  )
}
