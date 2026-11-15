import { Link } from '@tanstack/react-router'
import type { MatchSummary } from '../../stores/matches.ts'
import { ButtonLink } from '../ButtonLink.tsx'
import { EmptyState } from '../EmptyState.tsx'
import { Icon } from '../Icon.tsx'
import { opponentLabel } from '../opponent.ts'
import './MatchListScreen.css'

export type MatchListScreenProps = {
  // This device's matches, newest first, as the match list store gives them
  // (src/stores/matches.ts): the screen keeps their order.
  matches: readonly MatchSummary[]
}

// The matches list, at /matches: this device's matches, newest first. Its
// heading with, at non-phone widths, the "New match" button beside it (as on
// the dashboard; on a phone the bottom bar's is the way there). Each match is
// a row of a table: the opponent ("Anonymous" for a match with no name), a link to the match's page
// (/matches/<matchId>), and the format (best of n, rated or not). On phones
// each row is drawn as a card (AppLayout.css's breakpoint, read in
// MatchListScreen.css); it is the same table. With no matches, the design
// system's empty state, with its own New match. It renders in the layout's
// <main> (AppLayout).
export function MatchListScreen({ matches }: MatchListScreenProps) {
  return (
    <>
      <MatchListHead newMatch={matches.length > 0} />
      {matches.length === 0 ? (
        <EmptyState
          title="No matches yet."
          action={
            <ButtonLink to="/matches/new" variant="primary">
              <Icon name="plus" />
              New match
            </ButtonLink>
          }
        >
          Start a match and it shows here.
        </EmptyState>
      ) : (
        <table className="match-list-screen__table" aria-label="Matches">
          <thead>
            <tr>
              <th scope="col">Opponent</th>
              <th scope="col">Format</th>
            </tr>
          </thead>
          <tbody>
            {matches.map((match) => (
              <tr key={match.matchId}>
                <td className="match-list-screen__opponent">
                  {/* Its box covers the whole row (MatchListScreen.css). */}
                  <Link
                    to="/matches/$matchId"
                    params={{ matchId: match.matchId }}
                    className="match-list-screen__link"
                  >
                    You vs {opponentLabel(match.opponentName)}
                  </Link>
                </td>
                <td className="match-list-screen__format">
                  Best of {match.bestOf} · {match.rated ? 'Rated' : 'Unrated'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// The list before the store has read it (MatchList): its heading alone.
export function MatchListScreenPending() {
  return <MatchListHead newMatch={false} />
}

function MatchListHead({ newMatch }: { newMatch: boolean }) {
  return (
    <div className="match-list-screen__head">
      <h1>Matches</h1>
      {newMatch && (
        <ButtonLink
          to="/matches/new"
          variant="primary"
          className="match-list-screen__new-match"
        >
          <Icon name="plus" />
          New match
        </ButtonLink>
      )}
    </div>
  )
}
