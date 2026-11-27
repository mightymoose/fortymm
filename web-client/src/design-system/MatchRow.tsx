import { type ReactNode } from 'react'
import { Button as AriaButton } from 'react-aria-components'
import { Icon } from './Icon.tsx'

// The states a match row is drawn in so far: live (being scored: games and points, the server
// marked) and conflict (scheduled, needing an organizer's decision: names only).
export type MatchState = 'live' | 'conflict'

export interface MatchPlayer {
  // "Family, Given", as everywhere a player is named.
  name: string
  club?: string
  // Live matches only.
  isServing?: boolean
  games?: number
  points?: number
}

function gamesWon(games: number) {
  return `${games} ${games === 1 ? 'game' : 'games'} won`
}

function pointsInGame(points: number) {
  return `${points} ${points === 1 ? 'point' : 'points'} in this game`
}

// A match row (fm-match): the two players of a match and, while it is live, their games and the
// points of the game in play, under "Games" and "Points" column labels. Named "A vs B". size="lg"
// is the larger row of a match's detail. With onGameScoresToggle it has a "Game scores" disclosure
// button; `children` is what it shows when expanded.
export function MatchRow({
  state,
  size,
  players,
  isGameScoresExpanded = false,
  onGameScoresToggle,
  children,
}: {
  state: MatchState
  size?: 'lg'
  players: [MatchPlayer, MatchPlayer]
  isGameScoresExpanded?: boolean
  onGameScoresToggle?: () => void
  children?: ReactNode
}) {
  const isLive = state === 'live'
  return (
    <article
      className={size === 'lg' ? 'fm-match fm-match--lg' : 'fm-match'}
      data-state={state}
      aria-label={`${players[0].name} vs ${players[1].name}`}
    >
      {isLive && (
        <div className="fm-match__p fm-match__cols" aria-hidden="true">
          <span></span>
          <span></span>
          <span>Games</span>
          <span>Points</span>
        </div>
      )}
      {players.map((player) => (
        <div className="fm-match__p" key={player.name}>
          <span className="fm-match__name">
            {player.name}
            {player.club && <small>{player.club}</small>}
          </span>
          {isLive && (
            <>
              <span>
                {player.isServing && (
                  <span className="serve-marker" role="img" aria-label="Serving"></span>
                )}
              </span>
              <span className="fm-match__games" aria-label={gamesWon(player.games ?? 0)}>
                {player.games ?? 0}
              </span>
              <span className="fm-match__pts" aria-label={pointsInGame(player.points ?? 0)}>
                {player.points ?? 0}
              </span>
            </>
          )}
        </div>
      ))}
      {onGameScoresToggle && (
        <AriaButton
          className="fm-match__toggle"
          aria-expanded={isGameScoresExpanded}
          onPress={onGameScoresToggle}
        >
          Game scores
          <Icon name="chevron-down" />
        </AriaButton>
      )}
      {isGameScoresExpanded && children}
    </article>
  )
}
