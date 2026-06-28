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
 * The default opponent-picker view: a grid of the caller's actual recent
 * opponents, plus a "Search all players" affordance that hands off to the
 * typeahead. A caller with no match history sees an empty state pointing at
 * search rather than a roster of strangers (#167). Errors throw to the
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
        {/* Search is always reachable once loaded — a caller with no history
            now sees an empty grid, and search is their way forward (#167). */}
        {!isLoading && (
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
          No opponents yet — use Search to find a player, or start the match
          without one for a casual solo session.
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
