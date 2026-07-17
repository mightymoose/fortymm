// The boards' **tier grammar** — its own module (not `timeline-bar.tsx`) only
// because a component file may export nothing but components
// (`react-refresh/only-export-components`).

import type { TimelineTier } from '../../data/timeline'

/** One visual grammar per tier (ADR "the schedule is solved; the call is
 * pinned"): an **estimate** is tentative on its face (dashed), a **call** is a
 * promise (solid, pinned), a **started** match is fact (filled, quiet). The
 * `label` is the legend's words for the same style — ONE map, so a new or
 * restyled tier updates every bar (`./timeline-bar.tsx`) and the legend
 * (`./tier-legend.tsx`) together, and neither can drift from the other. */
export const TIER_GRAMMAR: Record<
  TimelineTier,
  { className: string; label: string }
> = {
  estimate: {
    className:
      'border border-dashed border-[color:var(--ball-500)] bg-[color:var(--bg-raised)] text-[color:var(--fg-2)]',
    label: 'Estimate — may move',
  },
  called: {
    className:
      'border border-[color:var(--ball-500)] bg-[color:var(--ball-500)]/20 text-[color:var(--fg-1)]',
    label: 'Called / pinned — a fixed time',
  },
  started: {
    className:
      'border border-[color:var(--serve-500)]/70 bg-[color:var(--serve-500)]/15 text-[color:var(--fg-2)]',
    // NOT "in play": an `in_progress` match is materialized (scoreable), not
    // necessarily being played — go-live makes every round-robin fixture one.
    label: 'Underway, up next, or finished',
  },
}
