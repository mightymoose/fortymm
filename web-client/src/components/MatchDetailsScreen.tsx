import { Link } from '@tanstack/react-router'
import { useId } from 'react'
import { Avatar } from './Avatar.tsx'
import { buttonClassName } from './button-class.ts'
import { GameScores } from './match-details-screen/GameScores.tsx'
import './Button.css'
import './MatchDetailsScreen.css'

// One saved game's score: this device's player's points first, then the
// opponent's.
export type GameScore = { you: number; opponent: number }

// What the match details screen shows: one match between this device's
// player ("You") and one opponent, its format, whether it is rated, and its
// saved games in the order they were played.
export type MatchDetails = {
  opponentName: string
  format: { bestOf: number; points: number }
  rated: boolean
  games: GameScore[]
}

// Who won what, from the games alone: a game goes to whoever has more
// points, and the match is over once one side has won more than half of
// best of N. This is the screen's own reading of the props, not the scoring
// rules (no deuce, no validation): the games it is given are taken as saved.
function tally({ format, games }: MatchDetails) {
  const you = games.filter((game) => game.you > game.opponent).length
  const opponent = games.filter((game) => game.opponent > game.you).length
  const toWin = Math.ceil(format.bestOf / 2)
  const winner =
    you >= toWin ? 'you' : opponent >= toWin ? 'opponent' : undefined
  return { you, opponent, winner, nextGame: games.length + 1 } as const
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('')
}

// The match details screen, at /matches/<id>, after fortymm-real's match
// page: a link back to the matches, the title ("You vs Ana") with, while
// the match goes on and the scoring screen's address is given, a Score
// button to it; then the scoreboard: the match's state (in progress, with
// the next game, or the winner), its format, both players and the tally in
// games; then each saved game's score and who won it.
//
// `scoreLink` is the address of the scoring screen for the next game. With
// none, or once the match is finished, there is no Score button.
// It renders in the layout's <main> (AppLayout).
export function MatchDetailsScreen({
  match,
  scoreLink,
}: {
  match: MatchDetails
  scoreLink?: string
}) {
  const stateId = useId()
  const { you, opponent, winner, nextGame } = tally(match)
  const name = match.opponentName
  const finished = winner !== undefined
  const state = finished
    ? `${winner === 'you' ? 'You' : name} won`
    : 'In progress'

  return (
    <div className="match-details">
      <Link to="/matches" className="match-details__back">
        <span aria-hidden="true">←</span>
        Matches
      </Link>

      <div className="match-details__head">
        <h1 className="match-details__title">
          You <span className="match-details__vs">vs</span> {name}
        </h1>
        {scoreLink !== undefined && !finished && (
          <a
            href={scoreLink}
            className={`${buttonClassName({ variant: 'primary', size: 'lg' })} match-details__score`}
          >
            Score
          </a>
        )}
      </div>

      <section className="match-details__board" aria-labelledby={stateId}>
        <div className="match-details__strip">
          <h2 id={stateId} className="match-details__state">
            {finished ? (
              <>
                <span className="match-details__final">Final ·</span>{' '}
                {state}
              </>
            ) : (
              state
            )}
          </h2>
          <p className="match-details__format">
            {match.format.bestOf === 1
              ? 'Single game'
              : `Best of ${match.format.bestOf}`}
            {' · '}
            {match.rated ? (
              <span className="match-details__rated">Rated</span>
            ) : (
              'Unrated'
            )}
            {!finished && ` · Game ${nextGame} next`}
          </p>
        </div>

        <div className="match-details__players">
          <p
            className={`match-details__player${winner === 'you' ? ' match-details__player--won' : ''}`}
          >
            <Avatar initials="Y" />
            <span className="match-details__name">You</span>
          </p>
          <p className="match-details__tally">
            {you} – {opponent}
          </p>
          <p
            className={`match-details__player match-details__player--opponent${winner === 'opponent' ? ' match-details__player--won' : ''}`}
          >
            <Avatar initials={initials(name)} />
            <span className="match-details__name">{name}</span>
          </p>
        </div>
      </section>

      <GameScores opponentName={name} games={match.games} />
    </div>
  )
}
