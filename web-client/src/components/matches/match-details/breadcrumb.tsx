import { Link } from '@tanstack/react-router'

export interface BreadcrumbProps {
  matchId: string
}

/** The match-details header breadcrumb: "Matches › Match abc123". */
export function Breadcrumb({ matchId }: BreadcrumbProps) {
  return (
    <div className="md-breadcrumb">
      <Link to="/matches">Matches</Link>
      <span>›</span>
      <span className="md-breadcrumb__current">Match {matchId.slice(0, 6)}</span>
    </div>
  )
}
