import { matchDetailRoute } from '@/api/matches'
import type { PlayerMatchRow } from '@/api/players'
import { MatchRowLink } from '@/components/matches/match-row-link/match-row-link'
import { matchRowAriaLabel } from '@/components/matches/match-row-link/match-row-naming'
import { UserAvatar } from '@/components/ui/user-avatar'

export interface MatchHistoryRowProps {
  /** One row of the player's history, straight off the wire. */
  match: PlayerMatchRow
}

/**
 * One row of the **full** match history (`/players/$userId/matches`):
 * `Date | Opponent | Score | Result`.
 *
 * The row **opens its match** (#989): the date cell is a real `<a href>`
 * (`MatchRowLink`), stretched across the row, so the whole row clicks through
 * while a screen reader hears exactly one link — named for the match, not for the
 * opponent whose profile it does *not* open.
 *
 * Extracted from `player-match-history.tsx` so it can be tested on its own; the
 * page still owns the table, the pagination and the empty/error states.
 */
export function MatchHistoryRow({ match }: MatchHistoryRowProps) {
  // Solo matches carry a player-less sentinel side — the row renders it as an
  // italic "No opponent" rather than dropping the match (ADR-0008).
  const opponent = match.opponent.username ?? 'No opponent'
  const isSolo = match.opponent.username === null
  const when = formatDate(match.created_at)
  const won = match.result === 'W'
  const lost = match.result === 'L'

  return (
    <tr>
      <td>
        <MatchRowLink
          route={matchDetailRoute(match.id)}
          ariaLabel={matchRowAriaLabel({ opponent, isSolo, when })}
          when={when}
        />
      </td>
      <td>
        <div className="player">
          <UserAvatar name={isSolo ? null : opponent} size={26} />
          <span
            className="player-name"
            style={
              isSolo ? { color: 'var(--fg-3)', fontStyle: 'italic' } : undefined
            }
          >
            {opponent}
          </span>
        </div>
      </td>
      <td>
        {match.games.length === 0 ? (
          <span
            style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}
          >
            —
          </span>
        ) : (
          <div className="player-profile__games">
            {match.games.map((g, i) => {
              const gameWon = g.mine > g.theirs
              return (
                <div
                  key={i}
                  className={
                    'player-profile__game ' +
                    (gameWon
                      ? 'player-profile__game--won'
                      : 'player-profile__game--lost')
                  }
                >
                  <span className="player-profile__game-mine">{g.mine}</span>
                  <span className="player-profile__game-theirs">{g.theirs}</span>
                </div>
              )
            })}
          </div>
        )}
      </td>
      <td>
        <ResultChip
          status={match.status}
          awaitingAcceptance={match.awaiting_acceptance}
          won={won}
          lost={lost}
        />
      </td>
    </tr>
  )
}

function ResultChip({
  status,
  awaitingAcceptance,
  won,
  lost,
}: {
  status: PlayerMatchRow['status']
  awaitingAcceptance: boolean
  won: boolean
  lost: boolean
}) {
  // A posted-but-unaccepted result and a genuinely-live match both sit at
  // `in_progress`; check the awaiting flag first so the former gets its own
  // "AWAITING" chip instead of the green "LIVE" one (#364). Mirrors the
  // matches list's "Awaiting" bucket.
  if (awaitingAcceptance) {
    return (
      <span className="player-profile__result-chip player-profile__result-chip--awaiting">
        AWAITING
      </span>
    )
  }
  if (status === 'in_progress') {
    return (
      <span className="player-profile__result-chip player-profile__result-chip--live">
        LIVE
      </span>
    )
  }
  if (status === 'pending') {
    return (
      <span className="player-profile__result-chip player-profile__result-chip--pending">
        UP NEXT
      </span>
    )
  }
  if (won) {
    return (
      <span className="player-profile__result-chip player-profile__result-chip--win">
        WIN
      </span>
    )
  }
  if (lost) {
    return (
      <span className="player-profile__result-chip player-profile__result-chip--loss">
        LOSS
      </span>
    )
  }
  // Completed but undecided (voided/no-side-won). Neutral pill.
  return (
    <span className="player-profile__result-chip player-profile__result-chip--pending">
      {status.toUpperCase()}
    </span>
  )
}

function formatDate(iso: string): string {
  // The server emits ISO timestamps with TZ; rendering in local time is
  // fine here since the column shows just month + day. (No bare YYYY-MM-DD
  // strings — that's the pattern that bit us before.)
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })
}
