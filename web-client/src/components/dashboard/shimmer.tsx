import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'

export interface ShimmerProps {
  /** Width — number (px) or any CSS length. Omit to fill the container. */
  width?: number | string
  /** Height — number (px) or any CSS length. */
  height: number | string
  /** Corner radius in px. Defaults to 6, matching the match-details `.md-sk`. */
  radius?: number
  className?: string
  style?: CSSProperties
}

/**
 * A single pulsing placeholder bar — the dashboard's loading primitive,
 * mirroring the match-details `.md-sk` look (a faint block on the dark
 * scoreboard surface). Purely decorative: it carries a stable
 * `data-testid` for its skeletons to count but is `aria-hidden`, so the
 * enclosing card skeleton's `role="status"` region owns the announcement.
 * Composed by the dashboard card skeletons to stand in for leaf
 * text/avatars without shifting layout.
 */
export const Shimmer = ({
  width,
  height,
  radius = 6,
  className,
  style,
}: ShimmerProps) => (
  <span
    aria-hidden="true"
    data-testid="dashboard-shimmer"
    className={cn('animate-pulse', className)}
    style={{
      display: 'block',
      width: width ?? '100%',
      height,
      borderRadius: radius,
      background: 'rgba(255, 255, 255, 0.06)',
      ...style,
    }}
  />
)
