import type {
  DashboardRating,
  DashboardRatingState,
  DashboardRecentResult,
} from '@/api/dashboard'

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

// Per-state copy for the non-RATED arms. The server's `state` discriminator —
// not a `null` rating — decides which line the empty card shows, so the client
// says the true thing for each situation instead of the old one-string-fits-all
// "Not in a rated league yet." that lied to a glicko2-unrated player (#956,
// ADR 20260725). RATED never reaches this map (it renders the RatingCard).
const EMPTY_RATING_COPY: Record<
  Exclude<DashboardRatingState, 'RATED'>,
  string
> = {
  UNRATED: 'Unrated — finish a rated match to start your rating',
  AWAITING_IMPORT: "Ratings haven't been imported for this league yet",
  NOT_RATED_LEAGUE: 'Not in a rated league yet.',
}

function emptyRatingBody(rating: DashboardRating | null): string {
  // A missing rating is not a wire state the server emits (the block is always
  // present now); default to the "no rated league" copy for the null-prop edge
  // (e.g. data still resolving) rather than inventing a fourth string.
  if (rating === null || rating.state === 'RATED') {
    return EMPTY_RATING_COPY.NOT_RATED_LEAGUE
  }
  return EMPTY_RATING_COPY[rating.state]
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
          // The strategy label rides on the RATED arm's `strategy_key`; the
          // non-rated arms may not carry one, so fall back to the bare window.
          rating?.strategy_key
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
        ) : rating?.state === 'RATED' ? (
          <RatingCard rating={rating} />
        ) : (
          <EmptyCard
            overline="Current rating"
            body={emptyRatingBody(rating)}
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
