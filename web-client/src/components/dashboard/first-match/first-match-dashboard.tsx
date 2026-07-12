import { FirstMatchCard } from './first-match-card'
import { NoMatchesCard } from './no-matches-card'
import { UnratedCard } from './unrated-card'

/**
 * The zero-match dashboard layout: the match-start hero on the left, the
 * unrated-rating slot and empty recent-matches card stacked on the right.
 * Splits via a CSS container query (`.first-match-grid` in `index.css`,
 * mirroring `.your-game-grid`) on this section's own width, not the viewport —
 * the dashboard sits beside the app-shell's sidebar, so a viewport query would
 * split too early.
 */
export const FirstMatchDashboard = () => {
  return (
    <div style={{ containerType: 'inline-size' }}>
      <div className="first-match-grid">
        <FirstMatchCard />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <UnratedCard />
          <NoMatchesCard />
        </div>
      </div>
    </div>
  )
}
