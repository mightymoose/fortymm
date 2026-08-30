import { Suspense } from 'react'

import { BreadcrumbDisplay } from './breadcrumb/breadcrumb-fetcher/breadcrumb-display'
import { BreadcrumbFetcher } from './breadcrumb/breadcrumb-fetcher'

export interface BreadcrumbProps {
  matchId: string
}

/** The match-details header breadcrumb: "Matches › Match abc123", or
 * "Matches › {tournament} › Match abc123" for a tournament fixture (#1288).
 * Self-fetching; the Suspense fallback is the plain, tournament-less crumb —
 * pixel-identical to a casual match — so there's no loading flash before the
 * tournament name (if any) appears. */
export function Breadcrumb({ matchId }: BreadcrumbProps) {
  return (
    <Suspense
      fallback={<BreadcrumbDisplay matchId={matchId} tournament={null} />}
    >
      <BreadcrumbFetcher matchId={matchId} />
    </Suspense>
  )
}
