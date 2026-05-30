import type { ReactNode } from 'react'

// The md-games grid shell: the GAMES kicker + per-game column labels, with the
// trailing SETS/total column dropped for the line-score layout. Shared by
// <LineScoreDataDisplay /> and <LineScoreSkeleton /> so both reserve the same
// columns. Callers supply the rows (<Line /> or <LineSkeleton />) as children.
//
// While loading we don't yet know the real game count, so `showGameLabels` is
// false: the column-label cells still render (filling the first grid row so the
// player rows don't reflow into it, and keeping its height via the GAMES
// kicker) but without the "G1/G2/…" text we can't know is correct yet.
export const LineScoreGrid = ({
  bestOf,
  showGameLabels = true,
  children,
}: {
  bestOf: number
  showGameLabels?: boolean
  children: ReactNode
}) => (
  <div className="md-games">
    <div
      className="md-games__grid"
      role="group"
      aria-label="Game scores"
      style={
        {
          '--md-games-count': bestOf,
          gridTemplateColumns: `var(--md-games-kicker, 130px) repeat(${bestOf}, 1fr)`,
        } as React.CSSProperties
      }
    >
      <div className="md-games__kicker">GAMES</div>
      {Array.from({ length: bestOf }, (_, i) => (
        <div key={`h-${i}`} className="md-games__col-label">
          {showGameLabels ? `G${i + 1}` : ''}
        </div>
      ))}
      {children}
    </div>
  </div>
)
