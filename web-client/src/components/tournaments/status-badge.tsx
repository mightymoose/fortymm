import { cn } from '@/lib/utils'

import type { TournamentStatus } from './data/types'

export interface StatusBadgeProps {
  status: TournamentStatus
}

interface StatusMeta {
  label: string
  /** Tailwind classes for the pill's surface + text. */
  pill: string
  /** Inline dot colour (a CSS token). */
  dot: string
  pulse?: boolean
}

const STATUS_META: Record<TournamentStatus, StatusMeta> = {
  draft: {
    label: 'Draft',
    pill: 'border-[color:var(--border-subtle)] bg-transparent text-[color:var(--fg-2)]',
    dot: 'var(--fg-muted)',
  },
  published: {
    label: 'Published',
    pill: 'border-[color:var(--border-subtle)] bg-[color:var(--bg-raised)] text-[color:var(--fg-2)]',
    dot: 'var(--info)',
  },
  live: {
    label: 'Live',
    pill: 'border-[color:rgba(0,226,154,0.3)] bg-[color:var(--bg-live-soft)] text-[color:var(--serve-500)]',
    dot: 'var(--serve-500)',
    pulse: true,
  },
  archived: {
    label: 'Archived',
    pill: 'border-[color:var(--border-subtle)] bg-transparent text-[color:var(--fg-2)]',
    dot: 'var(--ink-500)',
  },
}

/** The status pill shown on tournament cards and the detail hero. A coloured
 * leading dot encodes status; the `live` dot pulses. */
export const StatusBadge = ({ status }: StatusBadgeProps) => {
  const meta = STATUS_META[status]
  return (
    <span
      data-testid="tournament-status-badge"
      data-status={status}
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-[11px] font-semibold tracking-[0.06em] uppercase',
        meta.pill,
      )}
    >
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', meta.pulse && 'ball-dot--live')}
        style={{ background: meta.dot }}
      />
      {meta.label}
    </span>
  )
}
