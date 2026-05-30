import { MetaSkeleton } from './header-data/header-data-display/meta-skeleton'
import { MatchScoreSkeleton } from './header-data/header-data-display/match-score-skeleton'

// Loading placeholder for <HeaderData />. Mirrors the `MatchHeaderDataDisplay`
// layout — the `Meta` strip on top, the `MatchScore` hero row beneath —
// composed from the per-part skeletons that live beside their components.
export function HeaderSkeleton() {
  return (
    <div>
      <MetaSkeleton />
      <MatchScoreSkeleton />
    </div>
  )
}
