import { Link, useParams } from '@tanstack/react-router'
import { MatchSignOff } from './browse/SignOff'
import './browse/browse.css'

// One match's page.
export function MatchPage() {
  const { matchId } = useParams({ from: '/_authenticated/_shell/matches/$matchId' })
  return (
    <>
      <nav className="fm-crumbs" aria-label="Breadcrumb">
        <Link to="/matches">Matches</Link>
      </nav>
      <MatchSignOff id={matchId} />
    </>
  )
}
