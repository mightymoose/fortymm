import { Link, type LinkOptions } from '@tanstack/react-router'
import { Icon } from '../../Icon.tsx'
import { mayClear, type BestOf, type Score } from '../../../scoring/scoring.ts'
import './Scoreline.css'

// Where a scoreline cell links: the options of the router's <Link> that open
// that game's scoring screen. The screen's caller gives them, so the screen
// knows nothing of the route that shows it.
export type GameLink = (game: number) => LinkOptions

// The scoreline across the bottom of the scoring screen (fortymm-real's
// SCORELINE strip): one cell per game up to the best of, "G1" over its score
// (yours first, the winner's number marked), or "– –" for a game not saved.
//
// - Every saved game's cell is a link to it, at any time, so any saved game
//   can be corrected.
// - The next game to score (the one after the last saved) is a link too;
//   every other blank cell is inert: a game can only be saved after the ones
//   before it.
// - The game on screen is marked (aria-current="step") and is no link: it is
//   already open.
// - The highest saved game, the only one that may be cleared, has a ✕,
//   "Clear game N", which asks the screen to confirm (`onClear`).
export function Scoreline({
  bestOf,
  games,
  game,
  gameLink,
  onClear,
}: {
  bestOf: BestOf
  games: readonly Score[]
  game: number
  gameLink: GameLink
  onClear: (game: number) => void
}) {
  const nextUnsaved = games.length + 1
  return (
    <nav className="scoreline" aria-label="Scoreline">
      <h2 className="scoreline__label">Scoreline</h2>
      <ol className="scoreline__cells">
        {Array.from({ length: bestOf }, (_, index) => index + 1).map((n) => {
          const score = games[n - 1]
          const current = n === game
          const linked = !current && (score !== undefined || n === nextUnsaved)
          const won = score === undefined ? null : score[0] > score[1]
          const label =
            score === undefined
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
              data-saved={score !== undefined || undefined}
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
              {mayClear(games, n) && (
                <button
                  type="button"
                  className="scoreline__clear"
                  aria-label={`Clear game ${n}`}
                  onClick={() => onClear(n)}
                >
                  <Icon name="x" />
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
