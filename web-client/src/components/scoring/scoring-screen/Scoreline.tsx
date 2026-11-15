import { Link, type LinkOptions } from '@tanstack/react-router'
import { isDecided, savedScore, type BestOf, type Games } from '../../../scoring/scoring.ts'
import './Scoreline.css'

// Where a scoreline cell links: the options of the router's <Link> that open
// that game's scoring screen. The screen's caller gives them, so the screen
// knows nothing of the route that shows it.
export type GameLink = (game: number) => LinkOptions

// The scoreline across the bottom of the scoring screen (fortymm-real's
// SCORELINE strip): one cell per game up to the best of, "G1" over its score
// (yours first, the winner's number marked), or "– –" for a game not saved.
//
// - Every game that opens is a link to it: every saved game, at any time, and
//   every empty game while the match is undecided, in any order. An empty
//   game of a decided match is inert: nothing is played past the decider.
// - The game on screen is marked (aria-current="step") and is no link: it is
//   already open.
// - Clearing is on the game's own page, not here.
export function Scoreline({
  bestOf,
  games,
  game,
  gameLink,
}: {
  bestOf: BestOf
  games: Games
  game: number
  gameLink: GameLink
}) {
  const decided = isDecided(games, bestOf)
  return (
    <nav className="scoreline" aria-label="Scoreline">
      <h2 className="scoreline__label">Scoreline</h2>
      <ol className="scoreline__cells">
        {Array.from({ length: bestOf }, (_, index) => index + 1).map((n) => {
          const score = savedScore(games, n)
          const current = n === game
          const linked = !current && (score !== null || !decided)
          const won = score === null ? null : score[0] > score[1]
          const label =
            score === null
              ? `Game ${n}, not yet played`
              : `Game ${n}, ${score[0]}–${score[1]}`
          const inner = (
            <>
              <span className="scoreline__n">G{n}</span>
              <span className="scoreline__score">
                <span data-won={won === true || undefined}>{score?.[0] ?? '–'}</span>
                <span className="scoreline__dash" aria-hidden="true">
                  –
                </span>
                <span data-won={won === false || undefined}>{score?.[1] ?? '–'}</span>
              </span>
            </>
          )
          return (
            <li
              key={n}
              className="scoreline__cell"
              data-saved={score !== null || undefined}
              aria-current={current ? 'step' : undefined}
            >
              {linked ? (
                <Link {...gameLink(n)} className="scoreline__body" aria-label={label}>
                  {inner}
                </Link>
              ) : (
                <div className="scoreline__body">
                  <span className="visually-hidden">{label}</span>
                  <span aria-hidden="true" className="scoreline__inner">
                    {inner}
                  </span>
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
