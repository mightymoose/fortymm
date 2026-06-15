import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

import { Card as UICard } from '@/components/ui/card'
import { Overline } from '@/components/overline'

import { SkeletonCard } from './skeleton-card'
import { RatingCard } from './your-game-row/rating-card'
import { RecentResultsCard } from './your-game-row/recent-results-card'
import type { YourGameRowView } from './your-game-row/your-game-row-view'

const UI = 'var(--font-ui)'

export interface YourGameRowProps {
  view: YourGameRowView
  /** Holds the skeleton placeholders while the dashboard payload resolves. */
  isLoading: boolean
}

/**
 * The dashboard's "Your game" section: a header with a strategy-aware subtitle
 * and a "Full history" link, above a two-up grid of the rating card and recent
 * results card. Owns the section's skeleton and empty states; the cards
 * themselves are pure view-in. All shaping is done by `projectYourGameRowView`.
 */
export const YourGameRow = ({ view, isLoading }: YourGameRowProps) => {
  const { subtitle, viewAllSearch, rating, recent } = view
  return (
    // The grid stacks vs. splits off the row's *container* width via a CSS
    // container query (see `.your-game-grid` in index.css), not the viewport:
    // the dashboard sits in the app-shell's content column beside a 256px
    // sidebar, so just past the 960px sidebar breakpoint this column is only
    // ~700px — too narrow for two columns. `container-type: inline-size` makes
    // this <section> the query container.
    <section style={{ marginBottom: 36, containerType: 'inline-size' }}>
      <SectionHeader subtitle={subtitle} viewAllSearch={viewAllSearch} />
      <div className="your-game-grid">
        {isLoading ? (
          <SkeletonCard label="Loading rating" height={260} />
        ) : rating ? (
          <RatingCard view={rating} />
        ) : (
          <RatingEmptyCard />
        )}
        {isLoading ? (
          <SkeletonCard label="Loading recent matches" height={260} />
        ) : (
          <RecentResultsCard view={recent} />
        )}
      </div>
    </section>
  )
}

function SectionHeader({
  subtitle,
  viewAllSearch,
}: {
  subtitle: string
  viewAllSearch: { q: string | undefined }
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        marginBottom: 14,
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <h2
        style={{
          margin: 0,
          font: `600 18px ${UI}`,
          color: 'var(--chalk-50)',
          letterSpacing: '-0.005em',
        }}
      >
        Your game
      </h2>
      <span style={{ font: `400 13px ${UI}`, color: 'var(--chalk-500)' }}>
        {subtitle}
      </span>
      <div style={{ flex: 1 }} />
      <Link
        to="/matches"
        search={viewAllSearch}
        style={{
          font: `500 13px ${UI}`,
          color: 'var(--chalk-300)',
          textDecoration: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        Full history
        <ChevronRight size={12} strokeWidth={1.75} />
      </Link>
    </div>
  )
}

function RatingEmptyCard() {
  return (
    <UICard
      style={{ display: 'block', padding: 20, position: 'relative', minWidth: 0 }}
    >
      <Overline>Current rating</Overline>
      <div
        style={{
          marginTop: 10,
          font: `400 13px ${UI}`,
          color: 'var(--chalk-300)',
        }}
      >
        Not in a rated league yet.
      </div>
    </UICard>
  )
}
