import { Link } from '@tanstack/react-router'

import { UserAvatar } from '@/components/ui/user-avatar'
import { cn } from '@/lib/utils'

import {
  NO_VALUE,
  type RecentMatchOpponentView,
  type RecentMatchRowView,
} from '../recent-matches-query'

export interface RecentMatchRowProps {
  row: RecentMatchRowView
}

/**
 * The Opponent cell: a **link to that player's profile** — the card named its
 * opponents in plain text, which left the page's most obvious next step
 * unreachable.
 *
 * A **solo** match has nobody on the other side, so there is nothing to link to
 * and it stays plain text ("No opponent", in the ghost tone). That is not a
 * defensive null-check bolted onto a link: the opponent view is a sum type, and
 * only its `player` variant carries an id, so the link cannot be built for the
 * variant that has none. A naive `to="/players/$userId"` fed a nullable id sends
 * the reader to `/players/null`.
 */
const OpponentCell = ({ opponent }: { opponent: RecentMatchOpponentView }) => {
  if (opponent.kind === 'solo') {
    return (
      <span className="player-name recent-matches__opponent--solo">
        {opponent.name}
      </span>
    )
  }

  return (
    <Link
      to="/players/$userId"
      params={{ userId: opponent.id }}
      className="player-name recent-matches__opponent-link"
    >
      {opponent.name}
    </Link>
  )
}

/**
 * One row of the Recent matches card: `Opponent | Score | Δ | When`.
 *
 * There is **no result chip** (ADR-0915). The list is all-inclusive, so a match
 * that hasn't finished carries its state in two places instead:
 *
 * - the **status dot**, whose accessible name ("Won" / "Live" / "Awaiting
 *   acceptance" / …) is now the only such signal a screen reader gets;
 * - the **score cell**, which reads "Live" / "Awaiting" / "—" where a scoreline
 *   would go rather than implying a result it doesn't have.
 *
 * The Δ cell prints an em dash for any row that moved no rating — undecided *or*
 * unrated. Never "+0".
 *
 * The opponent's name is a link to their profile (`OpponentCell` above) — except
 * on a solo match, which has no player on the other side.
 *
 * Pure view-in, DOM-out: every label was derived in `selectRecentMatches`.
 */
export const RecentMatchRow = ({ row }: RecentMatchRowProps) => (
  <tr className="recent-matches__row">
    <td>
      <div className="player">
        <span
          role="img"
          aria-label={row.status.label}
          className={cn(
            'recent-matches__dot',
            `recent-matches__dot--${row.status.tone}`,
          )}
        />
        {/* Decorative: the name is right there in the cell, so the avatar
            shouldn't announce it a second time (#99). A solo match gets the
            dashed placeholder circle rather than initials for a nobody. */}
        <UserAvatar
          name={row.opponent.kind === 'player' ? row.opponent.name : null}
          size={26}
          decorative
        />
        <OpponentCell opponent={row.opponent} />
      </div>
    </td>
    <td>
      {row.score.kind === 'games' ? (
        <div className="player-profile__games">
          {row.score.games.map((game, i) => (
            <div
              key={i}
              className={cn(
                'player-profile__game',
                game.won
                  ? 'player-profile__game--won'
                  : 'player-profile__game--lost',
              )}
            >
              <span className="player-profile__game-mine">{game.mine}</span>
              <span className="player-profile__game-theirs">{game.theirs}</span>
            </div>
          ))}
        </div>
      ) : (
        <span className="recent-matches__score-text">{row.score.text}</span>
      )}
    </td>
    <td>
      {row.delta ? (
        <span
          role="img"
          aria-label={row.delta.ariaLabel}
          className={cn(
            'player-profile__delta',
            row.delta.tone === 'win'
              ? 'player-profile__delta--win'
              : 'player-profile__delta--loss',
          )}
        >
          {row.delta.label}
        </span>
      ) : (
        <span
          role="img"
          aria-label="No rating change"
          className="recent-matches__delta-none"
        >
          {NO_VALUE}
        </span>
      )}
    </td>
    <td>
      <span className="time-cell">
        <span className="strong">{row.when}</span>
      </span>
    </td>
  </tr>
)
