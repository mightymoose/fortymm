import { useId } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'

import { RecentMatchRow } from './recent-matches-display/recent-match-row'
import { type RecentMatchesView } from './recent-matches-query'

export interface RecentMatchesDisplayProps {
  recent: RecentMatchesView
}

/**
 * The profile's **Recent matches** card: the six matches the bundle already
 * carries, and a link to the full history.
 *
 * The profile is an overview (ADR-0915) — this is a window onto the
 * all-inclusive list, not the list. There is **no result-chip column**: the grid
 * is `Opponent | Score | Δ | When`, and a match that hasn't finished carries its
 * state on the row's status dot and in its score cell.
 *
 * The footer names `match_total` — the *all-inclusive* count, which is
 * deliberately larger than the career's decided count whenever a match is in
 * play. Anyone who "reconciles" the two numbers has reintroduced the bug.
 *
 * The table lives inside a **scroll container** (`.recent-matches__table-wrap`),
 * and it is not decoration: the cells are `white-space: nowrap` and four columns
 * of them are wider than a phone, so without it the table pushes the *page* wide
 * and the whole profile scrolls sideways under the thumb. Wide content scrolls
 * inside its own box; the body never does. The full-history route makes the same
 * move with `.player-profile__table-wrap`.
 *
 * Pure view-in, DOM-out.
 */
export const RecentMatchesDisplay = ({ recent }: RecentMatchesDisplayProps) => {
  const id = useId()

  return (
    <section className="player-profile__section recent-matches" aria-labelledby={id}>
      <div className="player-profile__section-header">
        <h2 className="player-profile__section-title" id={id}>
          Recent matches
        </h2>
      </div>

      {recent.rows.length === 0 ? (
        <p className="recent-matches__empty">No matches yet</p>
      ) : (
        <div className="recent-matches__table-wrap">
          <table className="recent-matches__table">
            <thead>
              <tr>
                <th scope="col">Opponent</th>
                <th scope="col">Score</th>
                <th scope="col">
                  {/* The column is headed with the glyph; a reader hears the
                      words. */}
                  <span aria-hidden="true">Δ</span>
                  <span className="sr-only">Rating change</span>
                </th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {recent.rows.map((row) => (
                <RecentMatchRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {recent.total > 0 && (
        <Link
          to="/players/$userId/matches"
          params={{ userId: recent.playerId }}
          className="recent-matches__view-all"
        >
          {recent.viewAllLabel}
          <ArrowRight size={14} strokeWidth={2.4} aria-hidden="true" />
        </Link>
      )}
    </section>
  )
}
