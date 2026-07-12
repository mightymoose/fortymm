import { MatchRowLink } from '@/components/matches/match-row-link/match-row-link'
import { UserAvatar } from '@/components/ui/user-avatar'
import { cn } from '@/lib/utils'

import { NO_VALUE, type RecentMatchRowView } from '../recent-matches-query'

export interface RecentMatchRowProps {
  row: RecentMatchRowView
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
 * The row **opens its match**: the "When" cell is a real `<a href>`
 * (`MatchRowLink`) stretched across the whole row, so the row clicks through
 * end-to-end while a screen reader hears one link, named for the match (#989).
 *
 * Pure view-in, DOM-out: every label — including the link's target and its
 * accessible name — was derived in `selectRecentMatches`.
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
            shouldn't announce it a second time (#99). */}
        <UserAvatar
          name={row.isSolo ? null : row.opponent}
          size={26}
          decorative
        />
        <span
          className={cn(
            'player-name',
            row.isSolo && 'recent-matches__opponent--solo',
          )}
        >
          {row.opponent}
        </span>
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
      <MatchRowLink
        route={row.detailRoute}
        ariaLabel={row.ariaLabel}
        when={row.when}
      />
    </td>
  </tr>
)
