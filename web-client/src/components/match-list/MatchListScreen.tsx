import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { Unavailable } from '../../stores/match-source.ts'
import type { MatchSummary } from '../../stores/matches.ts'
import { ButtonLink } from '../ButtonLink.tsx'
import { DeviceAlert, type NewVersionOffer } from '../DeviceAlert.tsx'
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
// a row of a table: the opponent ("Anonymous": components/opponent.ts), a
// link to the match's page
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
                    You vs {opponentLabel}
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

// The list when the device wouldn't read it: the heading (no New match, as
// for an empty list), then an error alert, read out at once, in place of the
// table (DeviceAlert). Its Try again reads the list again (`onRetry`); while
// that runs, the alert stays as it is. Read, the caller shows the list in
// its place; refused again, the alert is shown anew, and read out again.
export function MatchListScreenUnavailable({
  reason,
  newVersion,
  onRetry,
}: {
  reason: Unavailable['reason']
  newVersion: NewVersionOffer
  onRetry: () => Promise<void>
}) {
  // Counts the reads Try again asked for: each new one remounts the alert.
  const [tries, setTries] = useState(0)
  return (
    <>
      <MatchListHead newMatch={false} />
      <DeviceAlert
        key={tries}
        focusRetry={tries > 0}
        title="Couldn’t load your matches"
        refusal={{ action: 'read', reason }}
        newVersion={newVersion}
        onRetry={() => {
          void onRetry().then(() => setTries((n) => n + 1))
        }}
      />
    </>
  )
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
