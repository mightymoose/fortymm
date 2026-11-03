import { Link } from '@tanstack/react-router'
import { reviewBoard, winnerOf, type GamePoints, type Side, type Slots } from '../../scoring/board'
import type { Match } from '../../scoring/demoMatches'
import { PATH, type Sides } from './sides'

// A cell per game. Each game up to `reachable` links to it, keeping the
// scores in `hash`. Games after the decider step back.
export function GameStrip({
  match,
  slots,
  current,
  reachable,
  hash,
  sides,
  canSubmit,
}: {
  match: Match
  slots: Slots
  current: number
  reachable: number
  hash: string
  sides: Sides
  canSubmit: boolean
}) {
  const review = reviewBoard(slots, match.bestOf)
  const decider = review.kind === 'undecided' ? null : review.decidedAtGame
  return (
    <nav className="score-strip-wrap" aria-label="Games">
      {/* A line that keeps its height, so a note never moves the page. */}
      <div className="score-strip__head">
        <p className="score-strip__label">Games</p>
        {decider !== null && decider < match.bestOf && (
          <p className="score-strip__note">
            Match decided after game {decider}
            {canSubmit &&
              review.kind === 'overrun' &&
              `. Clear ${[...review.extraGames].reverse().map((game) => `game ${game}`).join(' and ')} to submit.`}
          </p>
        )}
      </div>
      <ol className="score-strip">
        {slots.map((points, index) => {
          const game = index + 1
          const classes = ['score-slot']
          if (decider !== null && game > decider) classes.push('score-slot--after')
          const content = (
            <>
              <span className="score-slot__label">Game {game}</span>{' '}
              <span className="score-slot__pts">{points ? <SlotScore points={points} sides={sides} /> : '–'}</span>
            </>
          )
          return (
            <li key={game}>
              {game <= reachable ? (
                <Link
                  to={PATH}
                  params={{ matchId: match.id, gameNumber: String(game) }}
                  search={true}
                  hash={hash}
                  className={classes.join(' ')}
                  aria-current={game === current ? 'page' : undefined}
                >
                  {content}
                </Link>
              ) : (
                <span className={classes.join(' ')}>{content}</span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

// A game's score, left side first, with the winner's points in bold.
function SlotScore({ points, sides }: { points: GamePoints; sides: Sides }) {
  const winner = winnerOf(points)
  const part = (side: Side) => (side === winner ? <b>{points[side]}</b> : <span>{points[side]}</span>)
  return (
    <>
      {part(sides[0])}–{part(sides[1])}
    </>
  )
}
