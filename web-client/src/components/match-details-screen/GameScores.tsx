import { useId } from 'react'
import type { GameScore } from '../MatchDetailsScreen.tsx'
import './GameScores.css'

// The match's saved games, after fortymm-real's per-game grid, turned into
// a table that never scrolls sideways: a row per game, in the order played,
// with your points, the opponent's and who won it. Each row's header is the
// game ("Game 1"), so a screen reader reads a row as one game. With no
// games yet, a line saying so instead.
export function GameScores({
  opponentName,
  games,
}: {
  opponentName: string
  games: GameScore[]
}) {
  const headingId = useId()
  return (
    <section className="game-scores" aria-labelledby={headingId}>
      <h2 id={headingId} className="game-scores__heading">
        Games
      </h2>
      {games.length === 0 ? (
        <p className="game-scores__none">No games yet.</p>
      ) : (
        <table className="game-scores__table" aria-labelledby={headingId}>
          <thead>
            <tr>
              <th scope="col">Game</th>
              <th scope="col">You</th>
              <th scope="col">{opponentName}</th>
              <th scope="col">Won by</th>
            </tr>
          </thead>
          <tbody>
            {games.map((game, index) => {
              const youWon = game.you > game.opponent
              return (
                <tr key={index}>
                  <th scope="row">Game {index + 1}</th>
                  <td className={youWon ? 'game-scores__won' : undefined}>
                    {game.you}
                  </td>
                  <td className={youWon ? undefined : 'game-scores__won'}>
                    {game.opponent}
                  </td>
                  <td className="game-scores__winner">
                    {youWon ? 'You' : opponentName}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
