import { useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'

import type { Player } from '@/api/matches'

import { OpponentPickerBoundary } from './opponent-picker/opponent-picker-boundary'
import { OpponentTypeahead } from './opponent-picker/opponent-typeahead'
import { RecentOpponents } from './opponent-picker/recent-opponents'
import '@/components/matches/match-setup/match-setup.css'

export interface OpponentPickerProps {
  /** Called when the user picks a player from the recent grid or the search. */
  onPick: (player: Player) => void
  /**
   * Called with the search text on every keystroke — the picker's *second*
   * channel out, alongside `onPick` (#893).
   *
   * `onPick` alone only ever tells a parent about a **committed** choice, which
   * left the match-setup card unable to distinguish "typed a name, matched
   * nobody" from "deliberately wants a solo match" — both were simply the
   * absence of a pick. This reports the uncommitted query so the card can model
   * that middle state (`OpponentSelection`'s `seeking`) and say so, instead of
   * quietly promising a solo match. Optional: a caller that doesn't model it
   * (the dashboard hero, which gates its submit on a picked opponent anyway)
   * can ignore it.
   */
  onQueryChange?: (query: string) => void
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
 * back to the recent grid (#96). The focus refs likewise survive a reset
 * remount, so error recovery doesn't yank focus around (#131).
 *
 * `focusSearchInputRef` starts `true` on the `defaultToSearch` entry (the
 * dashboard hero opens straight into search), so the input is focused on first
 * mount without a click; on the recent-grid entry it's flipped `true` by
 * `onSearchAll` instead.
 *
 * **Search mode has a visible exit (#895).** The transition into search was
 * one-way: with the recent grid gone and nothing but the search box on screen,
 * neither clearing the query nor Escape brought the fastest path to a rematch
 * back, and there was no control that said it would. So there is one now, and
 * it is an explicit control — *not* an Escape binding (Escape deliberately
 * hides the listbox and keeps the query, #97) and *not* an auto-restore when
 * the box empties (backspacing mid-correction must not yank the grid out from
 * under the user, and "clear" means clear). Leaving search reports an empty
 * query upward, so a card modelling the picker's `seeking` state (#893) reads
 * as `none` again rather than promising a solo match nobody is hunting for.
 *
 * A caller that opened *straight into* search has no recent grid behind it —
 * "back" would land the user somewhere they've never been — so it gets no back
 * control at all.
 */
export const OpponentPicker = ({
  onPick,
  onQueryChange,
  defaultToSearch = false,
}: OpponentPickerProps) => {
  const [showSearch, setShowSearch] = useState(defaultToSearch)
  const [query, setQuery] = useState('')
  const focusSearchInputRef = useRef(defaultToSearch)
  const focusSearchAllRef = useRef(false)

  // Only the recent-grid entry has somewhere to go back to.
  const canReturnToRecent = !defaultToSearch

  // The query stays owned here (it must survive a boundary reset, #96) and is
  // *mirrored* out to the parent — hence set-then-notify rather than a lift.
  function changeQuery(next: string) {
    setQuery(next)
    onQueryChange?.(next)
  }

  function openSearch() {
    setShowSearch(true)
    focusSearchInputRef.current = true
  }

  function returnToRecent() {
    setShowSearch(false)
    // Abandoning the search abandons the query with it — both the box the user
    // comes back to and the parent's mirror of it (#893).
    changeQuery('')
    // The back control unmounts itself, so hand focus to the control that took
    // the user into search rather than dropping it on the body.
    focusSearchAllRef.current = true
  }

  return (
    // Purely structural: the back control has to sit outside the boundary (see
    // below), so the two need a common parent. No class — it carries no style,
    // and a named one would imply it did.
    <div>
      {showSearch && canReturnToRecent && (
        <div className="nm-search-head">
          <button
            type="button"
            className="nm-back-btn"
            onClick={returnToRecent}
          >
            <ArrowLeft size={14} strokeWidth={2.5} aria-hidden="true" />
            Back to recent opponents
          </button>
        </div>
      )}
      {/* Outside the boundary on purpose: a search that failed into the error
          fallback is exactly when the user most needs a way out, and "Try
          again" shouldn't be the only one. `resetKeys` clears that error as the
          view switches, so the fallback doesn't outlive the view that threw. */}
      <OpponentPickerBoundary resetKeys={[showSearch]}>
        {showSearch ? (
          <OpponentTypeahead
            query={query}
            onQueryChange={changeQuery}
            onPick={onPick}
            focusOnMountRef={focusSearchInputRef}
          />
        ) : (
          <RecentOpponents
            onPick={onPick}
            onSearchAll={openSearch}
            focusOnMountRef={focusSearchAllRef}
          />
        )}
      </OpponentPickerBoundary>
    </div>
  )
}
