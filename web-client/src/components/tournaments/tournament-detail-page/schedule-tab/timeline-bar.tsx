import { Check, Pin, Play } from 'lucide-react'

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { fmtDateShort } from '../../data/helpers'
import {
  PX_PER_MIN,
  tierSentence,
  type TimelineBarData,
  type TimelineTier,
} from '../../data/timeline'

export interface TimelineBarProps {
  bar: TimelineBarData
  /** The bar's first line — the whole pairing on a table row, `vs opponent` on
   * a player row (the row already names its player). */
  title: string
  /** The board window's start: the minute at the track's left edge. */
  originMin: number
}

/** One visual grammar per tier (ADR "the schedule is solved; the call is
 * pinned"): an **estimate** is tentative on its face (dashed), a **call** is a
 * promise (solid, pinned), a **started** match is fact (filled, quiet). */
const TIER_CLASS: Record<TimelineTier, string> = {
  estimate:
    'border border-dashed border-[color:var(--ball-500)] bg-[color:var(--bg-raised)] text-[color:var(--fg-2)]',
  called:
    'border border-[color:var(--ball-500)] bg-[color:var(--ball-500)]/20 text-[color:var(--fg-1)]',
  started:
    'border border-[color:var(--serve-500)]/70 bg-[color:var(--serve-500)]/15 text-[color:var(--fg-2)]',
}

const TierIcon = ({ bar }: { bar: TimelineBarData }) => {
  switch (bar.tier) {
    case 'called':
      return <Pin size={10} aria-hidden className="shrink-0" />
    case 'started':
      return bar.status === 'in_progress' ? (
        <Play size={10} aria-hidden className="shrink-0" />
      ) : (
        <Check size={10} aria-hidden className="shrink-0" />
      )
    case 'estimate':
      return null
    default: {
      const exhaustive: never = bar.tier
      return exhaustive
    }
  }
}

/**
 * One placed fixture as a **bar** on a schedule board track — a focusable button
 * (keyboard is a first-class reader here) that reveals the match's details in a
 * tooltip on hover/focus, and carries the same details in its accessible name so
 * nothing depends on the tooltip opening.
 *
 * The tier is encoded three ways on purpose: the visual grammar (`TIER_CLASS`),
 * a `data-tier` attribute (what tests and styling hooks read), and the words of
 * `tierSentence` (what a screen reader hears) — so "estimate vs promise" never
 * rides on color alone.
 */
export const TimelineBar = ({ bar, title, originMin }: TimelineBarProps) => {
  const where = `${bar.eventName}${bar.poolName ? ` · ${bar.poolName}` : ''}`
  const when = `${bar.startClock}–${bar.endClock}`
  const sentence = tierSentence(bar.tier, bar.status)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={`timeline-bar-${bar.fixtureId}`}
          data-tier={bar.tier}
          aria-label={`${bar.label}, ${where}, ${bar.tableLabel}, ${when}. ${sentence}.`}
          className={cn(
            'absolute top-1 bottom-1 flex flex-col justify-center overflow-hidden rounded-[4px] px-1.5 text-left leading-tight focus-visible:ring-2 focus-visible:ring-[color:var(--ball-500)] focus-visible:outline-none',
            TIER_CLASS[bar.tier],
          )}
          style={{
            left: (bar.startMin - originMin) * PX_PER_MIN,
            width: Math.max(12, bar.durationMin * PX_PER_MIN - 2),
          }}
        >
          <span className="flex items-center gap-1 truncate text-[11px] font-medium">
            <TierIcon bar={bar} />
            <span className="truncate">{title}</span>
          </span>
          <span className="block truncate font-mono text-[10px] tabular-nums opacity-75">
            {when}
            {bar.tier === 'estimate' && ' · est'}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="items-start">
        <div className="flex flex-col gap-0.5 py-0.5">
          <span className="font-semibold">{bar.label}</span>
          <span>{where}</span>
          <span className="font-mono tabular-nums">
            {bar.tableLabel} · {fmtDateShort(bar.date)} · {when}
          </span>
          <span>{sentence}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
