import { Check, Pin } from 'lucide-react'

/**
 * The boards' key to the three tiers (ADR "the schedule is solved; the call is
 * pinned"): an **estimate** the solver may move, a **call** the players were
 * told, a **started** match that is fact. Words, not colors alone — the same
 * distinction every bar also carries in its own accessible name.
 */
export const TierLegend = () => (
  <ul
    data-testid="schedule-tier-legend"
    aria-label="Bar styles"
    className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--fg-3)]"
  >
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden
        className="h-3 w-5 rounded-[3px] border border-dashed border-[color:var(--ball-500)] bg-[color:var(--bg-raised)]"
      />
      Estimate — may move
    </li>
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden
        className="flex h-3 w-5 items-center justify-center rounded-[3px] border border-[color:var(--ball-500)] bg-[color:var(--ball-500)]/20"
      >
        <Pin size={8} className="text-[color:var(--fg-2)]" />
      </span>
      Called / pinned — a fixed time
    </li>
    <li className="flex items-center gap-1.5">
      <span
        aria-hidden
        className="flex h-3 w-5 items-center justify-center rounded-[3px] border border-[color:var(--serve-500)]/70 bg-[color:var(--serve-500)]/15"
      >
        <Check size={8} className="text-[color:var(--fg-2)]" />
      </span>
      In play or finished
    </li>
  </ul>
)
