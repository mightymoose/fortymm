import type { ReactNode } from 'react'

export const MatchScoreSlot = ({ children }: { children: ReactNode }) => (
  <div className="md-hero__score-block">
    <div className="md-hero__score-sizer" aria-hidden>
      <span className="md-hero__score">0</span>
    </div>
    <div className="md-hero__score-content">{children}</div>
  </div>
)
