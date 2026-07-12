import { useId } from 'react'
import { Link } from '@tanstack/react-router'

import { cn } from '@/lib/utils'

import type { LeagueRowView, LeaguesView } from './leagues-card-query'

export interface LeaguesCardDisplayProps {
  leagues: LeaguesView
  /** The profile the rows link back to — each row is a link to *this same page*,
   * with a different league selected. */
  playerId: string
  /** The league the **URL** named (`?league=`), or `undefined` for a clean URL,
   * which *means* the default league. It decides which row is highlighted — see
   * `selectedLeagueId` — and it is a prop rather than a field on the view because
   * it is a fact about the URL, not about the response: the bundle carries the
   * same `leagues` list whichever league was asked for. */
  leagueId?: string
}

/**
 * Which league the page is bound to.
 *
 * `leagueId` is what the URL asked for — and the fallback chain is what keeps a
 * nonsense `?league=` from producing a card with **no** row highlighted:
 *
 * 1. the league the URL named, if the player is actually in it;
 * 2. otherwise the **default** league — the one the API answers with when the
 *    caller names none, so this is the row the rest of the page is genuinely
 *    showing (`CONTEXT.md` § *Default league*);
 * 3. otherwise the first row, so a player whose leagues somehow carry no default
 *    still gets a coherent card rather than a dead one.
 *
 * Step 2 matters beyond mangled URLs: a caller can name a league that *exists*
 * but that this player does not belong to. The API answers happily (with no
 * rating), and the card must not then claim they are on a ladder it isn't
 * showing a row for.
 */
const selectedLeagueId = (
  rows: LeagueRowView[],
  leagueId: string | undefined,
): string | undefined => {
  const named = rows.find((row) => row.id === leagueId)
  if (named) return named.id
  const fallback = rows.find((row) => row.isDefault) ?? rows[0]
  return fallback?.id
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
 * The ratings arrive pre-formatted (an em dash for a ladder they hold no rating
 * on). Which row is **selected** is decided here rather than in the projection,
 * because it follows from the URL — the response says nothing about it.
 */
export const LeaguesCardDisplay = ({
  leagues,
  playerId,
  leagueId,
}: LeaguesCardDisplayProps) => {
  const id = useId()
  const selectedId = selectedLeagueId(leagues.rows, leagueId)

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
          <LeagueRow
            key={row.id}
            row={row}
            playerId={playerId}
            isSelected={row.id === selectedId}
          />
        ))}
      </ul>
    </section>
  )
}

const LeagueRow = ({
  row,
  playerId,
  isSelected,
}: {
  row: LeagueRowView
  playerId: string
  /** The ladder the rest of the page is currently bound to. Exactly one row is
   * selected, always. */
  isSelected: boolean
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
        isSelected && 'leagues-card__row--selected',
      )}
      // `page`, deliberately the same value the router stamps on an active link
      // (it appends its own `aria-current="page"` and we cannot suppress it). So
      // the two can never *disagree* — they either both fire on this row, or, in
      // the one case the router cannot see (a `?league=` naming a league this
      // player is not in, where no row's href matches the url), only this one
      // does. Either way exactly one row is current.
      aria-current={isSelected ? 'page' : undefined}
    >
      <span className="leagues-card__dot" aria-hidden="true" />
      <span className="leagues-card__name">{row.name}</span>
      {row.isDefault && <span className="leagues-card__badge">Default</span>}
      <span className="leagues-card__rating">{row.rating}</span>
    </Link>
  </li>
)
