import { Link } from '@tanstack/react-router'
import { PlayerAvatar } from '../../components/PlayerAvatar'
import { RatingChange } from '../../components/RatingChange'
import { gameLine, score, shortDate, VIEWER_ID, type Player, type Result } from './fixtures'
import type { Variant } from './variant'

export function PlayerLink({ player, variant }: { player: Player; variant: Variant }) {
  return (
    <Link to="/players/$playerId" params={{ playerId: player.id }} search={{ variant }}>
      {player.name}
    </Link>
  )
}

export function YouTag({ player }: { player: Player }) {
  return player.id === VIEWER_ID ? <span className="fm-tag">You</span> : null
}

export function PlayerHeading({ player, level = 1 }: { player: Player; level?: 1 | 2 }) {
  const Heading = level === 1 ? 'h1' : 'h2'
  return (
    <header className="players-head">
      <PlayerAvatar name={player.name} />
      <div>
        <Heading className="players-head__name">{player.name}</Heading>
        <p className="meta">
          {player.club} <YouTag player={player} />
        </p>
      </div>
    </header>
  )
}

// A result as a row: opponent, games won, each game's points and the rating
// change. The winner's games are bold.
export function ResultRows({ results, variant }: { results: readonly Result[]; variant: Variant }) {
  return (
    <ul className="fm-list fm-list--divided players-results">
      {results.map((result) => (
        <li key={result.id} className="players-result">
          <span className={result.won ? 'players-result__score w' : 'players-result__score'}>
            <span className="fm-sr">{result.won ? 'Won' : 'Lost'} </span>
            {score(result.games)}
          </span>
          <span className="players-result__who">
            <span>
              vs <PlayerLink player={result.opponent} variant={variant} />
            </span>
            <span className="meta">
              {shortDate(result.date)} · {result.event}
            </span>
          </span>
          <span className="players-result__games num meta">{gameLine(result.games)}</span>
          <span className="players-result__change">
            <RatingChange change={result.change} />
          </span>
        </li>
      ))}
    </ul>
  )
}
