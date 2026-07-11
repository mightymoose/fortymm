import { useId } from 'react'
import { Link } from '@tanstack/react-router'

import { cn } from '@/lib/utils'

import type { LeagueRowView, LeaguesView } from './leagues-card-query'

export interface LeaguesCardDisplayProps {
  leagues: LeaguesView
  /** The profile the rows link back to — each row is a link to *this same page*,
   * with a different league selected. */
  playerId: string
}

/**
 * The profile's **Leagues** card: every ladder this player is on, the rating they
 * carry on each — and the page's **league switcher** (ADR-0915).
 *
 * It is not a passive list. Clicking a row selects that league: it goes into the
 * URL, and the entire *rating* half of the page rebinds to it — the hero's
 * rating, rank, peak and Δ, the rating panel's form, and the confidence card. The
 * **Career** card does not move, and that is the point: a career counts every
 * league a player plays in, so a W–L that changed when you clicked a ladder would
 * be a bug, not a feature (`CONTEXT.md` § *Career*).
 *
 * Each row is a real `<Link>`, not a button, because the selection *is* the URL:
 * it must survive a reload, be shareable, and work with the back button. Two
 * details follow from that:
 *
 * - the **default** league's row links to a URL with **no `?league=` at all**,
 *   not `?league=<default-id>`. The default league is what the page falls back to
 *   when the URL names none, so the clean URL and the explicit one mean the same
 *   thing — and the clean one is what the overwhelming majority of visits should
 *   carry (`CONTEXT.md` § *Default league*);
 * - `aria-current="true"` marks the selected row, so the active ladder is
 *   announced and not merely tinted.
 *
 * Today every player is in exactly one league, so this renders a single row. That
 * is correct, not a bug to optimise away by hiding the card: hiding it would
 * delete the only affordance that will make the page legible the day a second
 * league lands.
 *
 * Pure view-in, DOM-out: the ratings arrive pre-formatted (an em dash for a
 * ladder they hold no rating on), and which row is selected was decided by the
 * projection.
 */
export const LeaguesCardDisplay = ({
  leagues,
  playerId,
}: LeaguesCardDisplayProps) => {
  const id = useId()

  return (
    <section
      className="player-profile__section leagues-card"
      aria-labelledby={id}
    >
      <div className="player-profile__section-header">
        <h2 className="player-profile__section-title" id={id}>
          Leagues
        </h2>
      </div>

      <ul className="leagues-card__rows">
        {leagues.rows.map((row) => (
          <LeagueRow key={row.id} row={row} playerId={playerId} />
        ))}
      </ul>
    </section>
  )
}

const LeagueRow = ({
  row,
  playerId,
}: {
  row: LeagueRowView
  playerId: string
}) => (
  <li className="leagues-card__row-item">
    <Link
      to="/players/$userId"
      params={{ userId: playerId }}
      // Merge, don't replace: switching league must not silently drop the other
      // params the profile's URL carries (the chart's `?range=` is coming). The
      // updater form is what keeps them.
      //
      // The default league is the *absence* of a param, not a value of it —
      // `undefined` is how TanStack Router drops a key from the query string, so
      // the default row's href is a clean `/players/x`.
      search={(prev) => ({ ...prev, league: row.isDefault ? undefined : row.id })}
      // `exact` is not a nicety — without it the router compares search params
      // *partially*, and the default league's row (whose search is `{}`) matches
      // EVERY url, so it would light up as active even while you are looking at
      // USATT. Two "current" ladders, which is worse than none. With `exact`, the
      // router's own active state agrees with `isSelected` on every row.
      activeOptions={{ exact: true }}
      className={cn(
        'leagues-card__row',
        row.isSelected && 'leagues-card__row--selected',
      )}
      // `page`, deliberately the same value the router stamps on an active link
      // (it appends its own `aria-current="page"` and we cannot suppress it). So
      // the two can never *disagree* — they either both fire on this row, or, in
      // the one case the router cannot see (a `?league=` naming a league this
      // player is not in, where no row's href matches the url), only this one
      // does. Either way exactly one row is current.
      aria-current={row.isSelected ? 'page' : undefined}
    >
      <span className="leagues-card__dot" aria-hidden="true" />
      <span className="leagues-card__name">{row.name}</span>
      {row.isDefault && <span className="leagues-card__badge">Default</span>}
      <span className="leagues-card__rating">{row.rating}</span>
    </Link>
  </li>
)
