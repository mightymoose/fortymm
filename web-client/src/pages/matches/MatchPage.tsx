import { Link, useParams, useSearch } from '@tanstack/react-router'
import { EmptyState } from '../../components/EmptyState'
import { MatchDetails } from './browse/MatchDetails'
import { PrototypeBar } from './browse/parts'
import { DETAIL_LABELS } from './browse/variants'
import { findMatch } from './browse/sampleMatches'
import './browse/browse.css'

// One match's page: three prototype layouts, picked with `?variant=a|b|c`.
export function MatchPage() {
  const { matchId } = useParams({ from: '/_authenticated/_shell/matches/$matchId' })
  const { variant = 'a' } = useSearch({ from: '/_authenticated/_shell/matches/$matchId' })
  const match = findMatch(matchId)
  return (
    <>
      <nav className="fm-crumbs" aria-label="Breadcrumb">
        <Link to="/matches" search={{ variant }}>
          Matches
        </Link>
      </nav>
      <PrototypeBar variant={variant} labels={DETAIL_LABELS} />
      {match ? (
        <MatchDetails match={match} variant={variant} />
      ) : (
        <>
          <h1>No such match</h1>
          <EmptyState title="This match isn’t here">The prototype only has its sample matches.</EmptyState>
        </>
      )}
    </>
  )
}
