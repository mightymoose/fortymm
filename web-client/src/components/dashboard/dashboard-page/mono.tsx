import type { CSSProperties, ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface MonoProps {
  children: ReactNode
  /** px font-size. Default 14. */
  size?: number
  /** font-weight. Default 500. */
  weight?: number
  /** Text color — any CSS color, defaults to the brightest chalk. */
  color?: string
  className?: string
  style?: CSSProperties
}

/**
 * A tabular monospace numeric run — ratings, scores, deltas. Leans on the
 * shared `font-mono` utility (which carries `font-variant-numeric: tabular-nums`
 * so digits don't jitter) and only parameterizes size/weight/color inline. No
 * design-system component renders inline tabular numerals, so this stays a
 * bespoke atom floated to the dashboard-page subtree.
 */
export const Mono = ({
  children,
  size = 14,
  weight = 500,
  color = 'var(--chalk-50)',
  className,
  style,
}: MonoProps) => {
  return (
    <span
      className={cn('font-mono', className)}
      style={{
        fontSize: size,
        fontWeight: weight,
        color,
        letterSpacing: '-0.01em',
        ...style,
      }}
    >
      {children}
    </span>
  )
}
