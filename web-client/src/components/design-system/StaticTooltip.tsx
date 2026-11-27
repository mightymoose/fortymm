import { type ReactNode } from 'react'

// A tooltip drawn in place, for the showcase boards: the tooltip's look without its trigger,
// positioning or timing. Not for app screens.
export function StaticTooltip({ children }: { children: ReactNode }) {
  return <span className="fm-tooltip fm-tooltip--static">{children}</span>
}
