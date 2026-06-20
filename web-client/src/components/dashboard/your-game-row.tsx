import type { DashboardRating, DashboardRecentResult } from '@/api/dashboard'

import { EmptyCard } from './your-game-row/empty-card'
import { RatingCard } from './your-game-row/rating-card'
import { RatingCardSkeleton } from './your-game-row/rating-card-skeleton'
import { RecentResultsCard } from './your-game-row/recent-results-card'
import { RecentResultsCardSkeleton } from './your-game-row/recent-results-card-skeleton'
import { SectionHeader } from './your-game-row/section-header'

function ratingStrategyLabel(key: string): string {
  if (key === 'glicko2') return 'Glicko-2'
  if (key === 'manual') return 'Manual'
  return key
}

export interface YourGameRowProps {
  rating: DashboardRating | null
  recent: DashboardRecentResult[]
  isLoading: boolean
  username?: string
}

export const YourGameRow = ({
  rating,
  recent,
  isLoading,
  username,
}: YourGameRowProps) => {
  // The grid stacks vs. splits off the row's *container* width via a CSS
  // container query (see `.your-game-grid` in index.css), not the viewport: the
  // dashboard sits in the app-shell's content column beside a 256px sidebar, so
  // just past the 960px sidebar breakpoint this column is only ~700px — too
  // narrow for two columns. `container-type: inline-size` makes this <section>
  // the query container.
  return (
    <section style={{ marginBottom: 36, containerType: 'inline-size' }}>
      <SectionHeader
        title="Your game"
        subtitle={
          rating
            ? `${ratingStrategyLabel(rating.strategy_key)} · last 30 days`
            : 'Last 30 days'
        }
        action="Full history"
        actionTo="/matches"
        actionSearch={{ q: username }}
      />
      <div className="your-game-grid">
        {isLoading ? (
          <RatingCardSkeleton />
        ) : rating ? (
          <RatingCard rating={rating} />
        ) : (
          <EmptyCard
            overline="Current rating"
            body="Not in a rated league yet."
          />
        )}
        {isLoading ? (
          <RecentResultsCardSkeleton />
        ) : (
          <RecentResultsCard rows={recent} />
        )}
      </div>
    </section>
  )
}
