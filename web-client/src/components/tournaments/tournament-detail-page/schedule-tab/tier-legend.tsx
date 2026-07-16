import { Check, Pin } from 'lucide-react'

import { cn } from '@/lib/utils'

import { TIMELINE_TIERS, type TimelineTier } from '../../data/timeline'
import { TIER_GRAMMAR } from './tier-grammar'

/** The tier's marker glyph on the swatch — the same icon its bars wear. An
 * estimate carries none: its dashes are the mark. */
const SWATCH_ICON: Record<TimelineTier, React.ReactNode> = {
  estimate: null,
  called: <Pin size={8} className="text-[color:var(--fg-2)]" />,
  started: <Check size={8} className="text-[color:var(--fg-2)]" />,
}

/**
 * The boards' key to the three tiers (ADR "the schedule is solved; the call is
 * pinned"): an **estimate** the solver may move, a **call** the players were
 * told, a **started** match that is fact. Words, not colors alone — the same
 * distinction every bar also carries in its own accessible name.
 *
 * Rendered by mapping `TIMELINE_TIERS` over the bars' own `TIER_GRAMMAR`
 * (one source for both the swatch style and the words), so a new or restyled
 * tier appears here without this file changing.
 */
export const TierLegend = () => (
  <ul
    data-testid="schedule-tier-legend"
    aria-label="Bar styles"
    className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--fg-3)]"
  >
    {TIMELINE_TIERS.map((tier) => (
      <li key={tier} className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            'flex h-3 w-5 items-center justify-center rounded-[3px]',
            TIER_GRAMMAR[tier].className,
          )}
        >
          {SWATCH_ICON[tier]}
        </span>
        {TIER_GRAMMAR[tier].label}
      </li>
    ))}
  </ul>
)
