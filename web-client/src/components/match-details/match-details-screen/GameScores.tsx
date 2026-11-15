import { useId } from 'react'
import type { Games } from '../../../scoring/scoring.ts'
import { opponentLabel } from '../../opponent.ts'
import './GameScores.css'

// The match's games, after fortymm-real's per-game grid, turned into a table
// that never scrolls sideways: a row per game from game 1 to the last saved
// one, with your points, the opponent's and who won it. Games may be saved in
// any order, so a game before the last saved one can be empty: its row says
// "Not played". Each row's header is the game ("Game 1"), so a screen reader
// reads a row as one game. With no game saved, a line saying so instead.
// The opponent is named "Anonymous" for a match with no opponent's name.
export function GameScores({
  opponentName: given,
  games,
}: {
  opponentName: string | null
  games: Games
}) {
  const headingId = useId()
  const opponentName = opponentLabel(given)
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
            {games.map((score, index) => {
              const game = index + 1
              if (score === null)
                return (
                  <tr key={game} className="game-scores__gap">
                    <th scope="row">Game {game}</th>
                    <td>–</td>
                    <td>–</td>
                    <td className="game-scores__winner">Not played</td>
                  </tr>
                )
              const [yours, theirs] = score
              const youWon = yours > theirs
              return (
                <tr key={game}>
                  <th scope="row">Game {game}</th>
                  <td className={youWon ? 'game-scores__won' : undefined}>
                    {yours}
                  </td>
                  <td className={youWon ? undefined : 'game-scores__won'}>
                    {theirs}
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
