import { Link } from '@tanstack/react-router'

import { matchDetailRoute } from '@/api/matches'
import type { PlayerMatchRow } from '@/api/players'
import { MatchRowLink } from '@/components/matches/match-row-link/match-row-link'
import { matchRowAriaLabel } from '@/components/matches/match-row-link/match-row-naming'
import { UserAvatar } from '@/components/ui/user-avatar'

export interface MatchHistoryRowProps {
  /** One row of the player's history, straight off the wire. */
  match: PlayerMatchRow
}

/** What the Opponent cell reads when there is nobody on the other side. */
const NO_OPPONENT = 'No opponent'

/**
 * Who the match was against — and therefore whether the cell is a **link**.
 *
 * A sum type, not a nullable id: on the wire both `id` and `username` are
 * nullable, because a **solo** match has the player-less sentinel side on the
 * other end (ADR-0008) and there is nobody there to link to. Only the `player`
 * variant carries an id, so `/players/null` is unbuildable rather than merely
 * unlikely — the same shape, for the same reason, as the profile card's
 * `RecentMatchOpponentView`.
 */
type OpponentView =
  | { kind: 'player'; id: string; name: string }
  | { kind: 'solo'; name: typeof NO_OPPONENT }

const selectOpponent = (opponent: PlayerMatchRow['opponent']): OpponentView =>
  opponent.id != null && opponent.username != null
    ? { kind: 'player', id: opponent.id, name: opponent.username }
    : { kind: 'solo', name: NO_OPPONENT }

/**
 * The Opponent cell: the name, as a **link to that player's profile** (#1005).
 * The history named its opponents in plain text, and the most obvious next step
 * from a list of people you have played was unreachable.
 *
 * A solo match has nobody to link to, so it stays plain text — ghost-toned and
 * italic, to say that "No opponent" is an absence and not a person.
 *
 * The link wears `match-row-inline-link` because the *row* is a link too, to the
 * match (#989), and that link's `::after` is stretched over every cell in the row
 * — this one included. The class lifts the name above the overlay
 * (`match-row-link.css`), so a click on the name opens the profile while a click
 * anywhere else in the row opens the match.
 */
function OpponentCell({ opponent }: { opponent: OpponentView }) {
  return (
    <div className="player">
      {/* `UserAvatar` already paints the sentinel placeholder for a null name,
       * so the no-opponent case needs no branch of its own — it is the same
       * call, with `null`. */}
      <UserAvatar
        name={opponent.kind === 'player' ? opponent.name : null}
        size={26}
      />
      {opponent.kind === 'solo' ? (
        <span
          className="player-name"
          style={{ color: 'var(--fg-3)', fontStyle: 'italic' }}
        >
          {opponent.name}
        </span>
      ) : (
        <Link
          to="/players/$userId"
          params={{ userId: opponent.id }}
          className="player-name match-history__opponent-link match-row-inline-link"
        >
          {opponent.name}
        </Link>
      )}
    </div>
  )
}

/**
 * One row of the **full** match history (`/players/$userId/matches`):
 * `Date | Opponent | Score | Result`.
 *
 * The row carries **two** links, because a row is a match *and* a person:
 *
 * - the **row** opens its match (#989) — the date cell is a real `<a href>`
 *   (`MatchRowLink`) whose `::after` is stretched across the row, so the whole row
 *   clicks through, and a screen reader hears it named for the match rather than
 *   for a person;
 * - the **opponent's name** opens that player's profile (#1005), lifted above the
 *   stretched overlay so it takes its own clicks. A solo match has nobody to link
 *   to, and stays plain text.
 *
 * Naming is what keeps them apart: "Match against ada.lovelace, Mar 14" goes to
 * the match, "ada.lovelace" goes to ada. Neither promises what the other delivers,
 * which is exactly why the row's anchor is not wrapped around the name.
 *
 * Extracted from `player-match-history.tsx` so it can be tested on its own; the
 * page still owns the table, the pagination and the empty/error states.
 */
export function MatchHistoryRow({ match }: MatchHistoryRowProps) {
  // Solo matches carry a player-less sentinel side — the row renders it as an
  // italic "No opponent" rather than dropping the match (ADR-0008).
  const opponent = selectOpponent(match.opponent)
  const when = formatDate(match.created_at)
  const won = match.result === 'W'
  const lost = match.result === 'L'

  return (
    <tr>
      <td>
        <MatchRowLink
          route={matchDetailRoute(match.id)}
          ariaLabel={matchRowAriaLabel({
            opponent: opponent.name,
            isSolo: opponent.kind === 'solo',
            when,
          })}
          when={when}
        />
      </td>
      <td>
        <OpponentCell opponent={opponent} />
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
