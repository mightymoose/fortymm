import type { CSSProperties, ReactNode } from 'react'

import { C, UI, MONO } from '@/components/dashboard/dashboard-tokens'

export type PillTone =
  | 'default'
  | 'soft'
  | 'accent'
  | 'live'
  | 'warn'
  | 'win'
  | 'loss'

const pillTones: Record<PillTone, { bg: string; fg: string; border: string }> =
  {
    default: { bg: 'transparent', fg: C.chalk300, border: C.ink500 },
    soft: { bg: 'rgba(255,255,255,0.04)', fg: C.chalk100, border: C.ink500 },
    accent: {
      bg: 'rgba(255,122,26,0.12)',
      fg: C.ball400,
      border: 'rgba(255,122,26,0.35)',
    },
    live: {
      bg: 'rgba(0,226,154,0.12)',
      fg: C.serve500,
      border: 'rgba(0,226,154,0.3)',
    },
    warn: {
      bg: 'rgba(255,196,61,0.12)',
      fg: C.warn,
      border: 'rgba(255,196,61,0.3)',
    },
    win: { bg: 'rgba(0,226,154,0.12)', fg: C.serve500, border: 'transparent' },
    loss: { bg: 'rgba(255,77,109,0.12)', fg: C.loss, border: 'transparent' },
  }

export interface PillProps {
  children: ReactNode
  tone?: PillTone
  mono?: boolean
  style?: CSSProperties
}

/** A rounded label chip used inside the rating card — toned (win/loss/live/…)
 * and optionally rendered in the monospace face for tabular stats. */
export const Pill = ({
  children,
  tone = 'default',
  mono = false,
  style,
}: PillProps) => {
  const t = pillTones[tone]
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 9px',
        borderRadius: 999,
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.border}`,
        font: `${mono ? 500 : 600} 11px ${mono ? MONO : UI}`,
        letterSpacing: mono ? '0.04em' : '0.08em',
        textTransform: mono ? 'none' : 'uppercase',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  )
}
