import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { Unavailable } from '../../stores/match-source.ts'
import { DeviceAlert, type NewVersionOffer } from '../DeviceAlert.tsx'
import './MatchUnavailableScreen.css'

// A match the device wouldn't read, at any page of it (its details, its
// scoring): an error alert whose title is the page's heading, "Couldn't
// load this match", read out at once (DeviceAlert, words the user approved
// on 2026-11-17), and a link to all matches. Not a match that isn't on this device: that is the
// not-found page.
//
// Try again reads the match again (`onRetry`); while that runs, the alert
// stays as it is. Read, the caller shows the match's page in its place;
// refused again, the alert is shown anew, and read out again. It renders in
// the layout's <main> (AppLayout).
export function MatchUnavailableScreen({
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
    <div className="match-unavailable">
      <DeviceAlert
        key={tries}
        focusRetry={tries > 0}
        title="Couldn’t load this match"
        heading
        refusal={{ action: 'read', reason }}
        newVersion={newVersion}
        onRetry={() => {
          void onRetry().then(() => setTries((n) => n + 1))
        }}
      />
      <Link to="/matches" className="match-unavailable__back">
        <span aria-hidden="true">←</span>
        All matches
      </Link>
    </div>
  )
}
