import { useRecentOpponents, type Player } from '@/api/matches'
import { useSession } from '@/api/session'
import { UserAvatar } from '@/components/ui/user-avatar'

import {
  REGISTERED_PLAYER_LABEL,
  displayPlayerName,
} from './player-identity'

export interface RecentOpponentsProps {
  /** Select a player from the recent grid. */
  onPick: (player: Player) => void
  /** Switch to the full player search. */
  onSearchAll: () => void
}

function RecentSkeleton() {
  return (
    <div className="nm-recent-grid" role="status" aria-label="Loading players">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="nm-chip-skel" aria-hidden="true">
          <div className="av" />
          <div className="lines">
            <div className="line" />
            <div className="line short" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The default opponent-picker view: a grid of recently-played opponents
 * (backfilled with other registered players by the API), plus a "Search all
 * players" affordance that hands off to the typeahead. Errors throw to the
 * surrounding `OpponentPickerBoundary`.
 */
export const RecentOpponents = ({
  onPick,
  onSearchAll,
}: RecentOpponentsProps) => {
  // Wait for the session before fetching players — otherwise a first-visit
  // direct-load races the session cookie and 401s into the error boundary
  // (#98). A disabled query stays `isPending`, so the skeleton holds until the
  // session resolves rather than flashing the empty state.
  const session = useSession()
  const recent = useRecentOpponents({ enabled: session.isSuccess })
  const players = recent.data ?? []
  const isLoading = recent.isPending

  return (
    <div>
      <div className="nm-recent-label">
        <span>Recent opponents</span>
        {!isLoading && players.length > 0 && (
          <button
            type="button"
            className="search-btn"
            onClick={onSearchAll}
          >
            Search all players
          </button>
        )}
      </div>
      {isLoading ? (
        <RecentSkeleton />
      ) : players.length === 0 ? (
        <div className="nm-no-match">
          No other players yet. Start the match without picking one for a
          casual solo session.
        </div>
      ) : (
        <div className="nm-recent-grid">
          {players.map((p) => (
            <button
              type="button"
              key={p.id}
              className="nm-chip"
              // Explicit accessible name so the decorative avatar initials
              // aren't read as part of the player's name (#99).
              aria-label={`${displayPlayerName(p.username)}, ${REGISTERED_PLAYER_LABEL}`}
              onClick={() => onPick(p)}
            >
              <UserAvatar name={p.username} size={32} decorative />
              <div className="body">
                <div className="n">{displayPlayerName(p.username)}</div>
                <div className="m">{REGISTERED_PLAYER_LABEL}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
