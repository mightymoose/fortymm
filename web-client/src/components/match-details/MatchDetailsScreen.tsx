import { Link, type LinkOptions } from '@tanstack/react-router'
import { useId } from 'react'
import { gamesWon, isDecided, nextGame } from '../../scoring/scoring.ts'
import type { MatchState } from '../../stores/match.ts'
import { Avatar } from '../Avatar.tsx'
import { buttonClassName } from '../button-class.ts'
import { opponentInitials } from '../opponent.ts'
import { GameScores } from './match-details-screen/GameScores.tsx'
import '../Button.css'
import './MatchDetailsScreen.css'

// Where the Score button links: the options of the router's <Link> that open
// game `game`'s scoring screen. The caller gives them, so the screen knows
// nothing of the route that shows it (as the scoring screen's GameLink).
export type ScoreLink = (game: number) => LinkOptions

// The match details screen, at /matches/<id>, after fortymm-real's match
// page: a link back to the matches, the title ("You vs Ana") with, while the
// match is undecided, a Score button to the next game's scoring screen; then
// the scoreboard: the match's state (in progress, with the next game, or the
// winner), its format, both players and the tally in games; then each game
// up to the last saved one, its score and who won it, or "Not played" for a
// gap.
//
// Who has won what, and which game is next, are the scoring rules'
// (src/scoring/scoring.ts): games won wherever they sit, the match decided
// once a side has won more than half of best of, the next game the lowest
// empty one. Every score is `[yours, theirs]`.
// It renders in the layout's <main> (AppLayout).
export function MatchDetailsScreen({
  match,
  scoreLink,
}: {
  match: MatchState
  scoreLink: ScoreLink
}) {
  const stateId = useId()
  const { opponentName: name, bestOf, rated, games } = match
  const [you, opponent] = gamesWon(games)
  const finished = isDecided(games, bestOf)
  const winner = finished ? (you > opponent ? 'you' : 'opponent') : undefined
  const next = nextGame(games, bestOf)
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
        {next !== null && (
          <Link
            {...scoreLink(next)}
            className={`${buttonClassName({ variant: 'primary', size: 'lg' })} match-details__score`}
          >
            Score
          </Link>
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
            {bestOf === 1 ? 'Single game' : `Best of ${bestOf}`}
            {' · '}
            {rated ? (
              <span className="match-details__rated">Rated</span>
            ) : (
              'Unrated'
            )}
            {next !== null && ` · Game ${next} next`}
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
            <Avatar initials={opponentInitials(name)} />
            <span className="match-details__name">{name}</span>
          </p>
        </div>
      </section>

      <GameScores opponentName={name} games={games} />
    </div>
  )
}
