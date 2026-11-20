import { Link, type LinkOptions } from '@tanstack/react-router'
import { useState } from 'react'
import { pastDecider, savedScore, type BestOf, type Games } from '../../../scoring/scoring.ts'
import './Scoreline.css'

// Where a scoreline cell links: the options of the router's <Link> that open
// that game's scoring screen. The screen's caller gives them, so the screen
// knows nothing of the route that shows it.
export type GameLink = (game: number) => LinkOptions

// The games that changed elsewhere (another tab, later a sync pull) in the
// latest change, and which change it is: each new `change` shows the mark
// again, from the start, on its own games.
export type Updates = { games: number[]; change: number }

// The scoreline across the bottom of the scoring screen (fortymm-real's
// SCORELINE strip): one cell per game up to the best of, "G1" over its score
// (yours first, the winner's number marked), or "– –" for a game not saved.
//
// - Every game that opens is a link to it: every saved game, at any time, and
//   every empty game, in any order, but one after the game that decided the
//   match (`pastDecider`), which is inert: nothing is played past it.
// - The game on screen is marked (aria-current="step") and is no link: it is
//   already open.
// - Clearing is on the game's own page, not here.
// - Games that changed elsewhere (`updates`) are tinted in the rest colour,
//   fill and edge, on every change, fading by themselves (gone at 4s; with
//   reduced motion, shown about 3s without animating): the user's pick,
//   2026-11-17. The tint is taken off the page once its animation ends.
//   "Game N updated." is read out politely on every change (a status there
//   before the first, its words new for each). The cells' names don't
//   change: the mark is gone a few seconds later.
// - The heading row keeps its right end free for a "syncing" indicator,
//   once sync pulls data (not built).
export function Scoreline({
  bestOf,
  games,
  game,
  gameLink,
  updates,
}: {
  bestOf: BestOf
  games: Games
  game: number
  gameLink: GameLink
  updates: Updates
}) {
  // The change whose tint has faded: its marks are gone from the page.
  const [faded, setFaded] = useState<number | null>(null)
  const changed = new Set(updates.change === faded ? [] : updates.games)
  return (
    <nav className="scoreline" aria-label="Scoreline">
      <div className="scoreline__head">
        <h2 className="scoreline__label">Scoreline</h2>
      </div>
      {/* There before the first change, so a screen reader hears it. */}
      <p className="visually-hidden" role="status">
        {updates.games.length > 0 && (
          <span key={updates.change}>{updatedWords(updates.games)}</span>
        )}
      </p>
      <ol className="scoreline__cells">
        {Array.from({ length: bestOf }, (_, index) => index + 1).map((n) => {
          const score = savedScore(games, n)
          const current = n === game
          // Every game but one after the decider, which can't be played.
          const linked = !current && (score !== null || !pastDecider(games, bestOf, n))
          const won = score === null ? null : score[0] > score[1]
          const label =
            score === null
              ? `Game ${n}, not yet played`
              : `Game ${n}, ${score[0]}–${score[1]}`
          const mark = changed.has(n) ? (
            <span
              key={updates.change}
              className="scoreline__mark"
              aria-hidden="true"
              onAnimationEnd={() => setFaded(updates.change)}
            />
          ) : null
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
              {mark}
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

// "Game 2 updated.", "Games 1 and 3 updated.", "Games 1, 2 and 4 updated."
function updatedWords(numbers: number[]): string {
  if (numbers.length === 1) return `Game ${numbers[0]} updated.`
  return `Games ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)} updated.`
}
