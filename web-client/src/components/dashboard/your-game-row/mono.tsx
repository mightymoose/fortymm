import type { CSSProperties, ReactNode } from 'react'

import { C, MONO } from '@/components/dashboard/dashboard-tokens'

export interface MonoProps {
  children: ReactNode
  size?: number
  weight?: number
  color?: string
  style?: CSSProperties
  /** Optional spoken label — e.g. spelling out a "+8"/"Δ" delta chip so a
   * screen reader doesn't voice the glyph as literal punctuation. */
  ariaLabel?: string
}

/** Tabular-nums monospace text — ratings, scores, and deltas across the
 * dashboard render in this face so digits stay column-aligned. */
export const Mono = ({
  children,
  size = 14,
  weight = 500,
  color = C.chalk50,
  style,
  ariaLabel,
}: MonoProps) => {
  return (
    <span
      aria-label={ariaLabel}
      style={{
        font: `${weight} ${size}px ${MONO}`,
        fontVariantNumeric: 'tabular-nums',
        color,
        letterSpacing: '-0.01em',
        ...style,
      }}
    >
      {children}
    </span>
  )
}
