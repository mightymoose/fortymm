import { Link } from '@tanstack/react-router'

import { matchDetailRoute } from '@/api/matches'

import './match-row-link.css'

/** The typed nav target for a match's detail page — always built by
 * `matchDetailRoute(matchId)`, never hand-written. */
export type MatchDetailRoute = ReturnType<typeof matchDetailRoute>

export interface MatchRowLinkProps {
  /** Where the row goes. Built with `matchDetailRoute(match.id)`. */
  route: MatchDetailRoute
  /** The accessible name — from `matchRowAriaLabel` (`match-row-naming.ts`). */
  ariaLabel: string
  /** The visible text: the match's date, e.g. "Mar 14". */
  when: string
}

/**
 * The date cell of a match-history row, as a **link to that match** (#989).
 *
 * One genuine `<a href>` per row, stretched across the row by its `::after` (see
 * `match-row-link.css`): the whole row is clickable, cmd-click / middle-click /
 * "open in new tab" all work, TanStack preloads the detail route on intent — and a
 * screen reader hears a *single* link, named for the match rather than for the
 * opponent whose profile it does not open.
 *
 * The overlay paints over the row's cells: an interactive control added inside a
 * row later has to lift itself out of the way (stop propagation and/or
 * `position` + `z-index`), the way the matches list's action cell does.
 *
 * Shared by the profile's "Recent matches" card and the full history page, which
 * otherwise have no row component in common: the contract (one anchor, on the
 * date, named for the match, stretched over the row) is identical on both, and it
 * is exactly the kind of contract that rots the moment it is written twice.
 */
export const MatchRowLink = ({ route, ariaLabel, when }: MatchRowLinkProps) => (
  <Link {...route} aria-label={ariaLabel} className="match-row-link">
    {when}
  </Link>
)
