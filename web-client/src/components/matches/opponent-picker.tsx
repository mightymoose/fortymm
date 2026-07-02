import { useRef, useState } from 'react'

import type { Player } from '@/api/matches'

import { OpponentPickerBoundary } from './opponent-picker/opponent-picker-boundary'
import { OpponentTypeahead } from './opponent-picker/opponent-typeahead'
import { RecentOpponents } from './opponent-picker/recent-opponents'
import '@/components/matches/match-setup/match-setup.css'

export interface OpponentPickerProps {
  /** Called when the user picks a player from the recent grid or the search. */
  onPick: (player: Player) => void
  /** Open straight into the search typeahead instead of the recent-opponents
   * grid — for callers with no "recent" framing of their own (e.g. the
   * dashboard's first-match hero card). Defaults to false. */
  defaultToSearch?: boolean
}

/**
 * Opponent picker for the New Match form: a recent-opponents grid that hands
 * off to a full-roster search typeahead.
 *
 * `showSearch` and `query` live here, *above* the `OpponentPickerBoundary`, so
 * a failed search's "Try again" — which resets the boundary and remounts its
 * children — preserves the typed query and the search view instead of dropping
 * back to the recent grid (#96). The `focusOnMountRef` ref likewise survives a
 * reset remount, so error recovery doesn't yank focus back to the input (#131).
 */
export const OpponentPicker = ({
  onPick,
  defaultToSearch = false,
}: OpponentPickerProps) => {
  const [showSearch, setShowSearch] = useState(defaultToSearch)
  const [query, setQuery] = useState('')
  const focusOnMountRef = useRef(false)

  return (
    <OpponentPickerBoundary>
      {showSearch ? (
        <OpponentTypeahead
          query={query}
          onQueryChange={setQuery}
          onPick={onPick}
          focusOnMountRef={focusOnMountRef}
        />
      ) : (
        <RecentOpponents
          onPick={onPick}
          onSearchAll={() => {
            setShowSearch(true)
            focusOnMountRef.current = true
          }}
        />
      )}
    </OpponentPickerBoundary>
  )
}
