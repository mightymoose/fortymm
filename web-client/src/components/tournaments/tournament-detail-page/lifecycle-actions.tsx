import type { ComponentProps } from 'react'

import { Button } from '@/components/ui/button'

import { useTransitionTournament } from '../data/api'
import { lifecycleEdgeFor, type LifecycleTone } from '../data/lifecycle'
import type { Tournament } from '../data/types'

export interface LifecycleActionsProps {
  tournament: Tournament
}

/** How a tone is *dressed* — the one place lifecycle style lives, so the edge
 * table next door stays a table of lifecycle facts (where the edge goes, what the
 * button says, what a failure says) and not a place className strings leak into
 * the data layer.
 *
 * `go-live` is the accent treatment `StatusBadge` gives the `live` status, written
 * with the same tokens (`--serve-500`, `--bg-live-soft`) rather than a re-typed
 * `rgba(0, 226, 154, …)` — starting a tournament and being live are the same fact,
 * so they should not be able to drift to different greens. */
const TONE: Record<
  LifecycleTone,
  { variant?: ComponentProps<typeof Button>['variant']; className?: string }
> = {
  default: {},
  'go-live': {
    className:
      'border border-[color:var(--serve-500)]/35 bg-[color:var(--bg-live-soft)] text-[color:var(--serve-500)] hover:bg-[color:var(--serve-500)]/20',
  },
  ghost: { variant: 'ghost' },
}

/**
 * The detail header's lifecycle affordance — and the **only** way a tournament's
 * status changes in this UI (ADR-0017). It posts the edge the tournament's status
 * offers to `POST /v1/tournaments/{id}/transitions`:
 *
 *     draft ──Publish──▶ published ──Start──▶ live ──End──▶ archived
 *
 * There is no status picker anywhere, because a picker of all four statuses would
 * be a picker of mostly-409s — the illegal jumps (`draft → archived`,
 * `live → draft`) that the edge table exists to refuse. The edges live in
 * `../data/lifecycle`; `lifecycleEdgeFor` is the one accessor, asked here and by
 * the header (which needs to know whether to give this component a slot at all).
 *
 * It renders **nothing** — not a disabled button — for a non-owner (`canEdit`),
 * because every transition is owner-only server-side (403); and at most ONE
 * button, the one legal from the status the tournament is actually in.
 *
 * A refused move (409 — the stale-tab case: published in another tab, while this
 * one still shows **Publish**) surfaces as an error toast from the mutation, and
 * that same mutation re-reads the tournament, so the badge and the button correct
 * themselves to whatever is true now.
 */
export const LifecycleActions = ({ tournament }: LifecycleActionsProps) => {
  const transition = useTransitionTournament(tournament.id)

  const edge = lifecycleEdgeFor(tournament)
  if (!edge) return null
  const Icon = edge.icon
  const tone = TONE[edge.tone]

  return (
    <Button
      variant={tone.variant}
      className={tone.className}
      // One in-flight move at a time: a double-click on Publish must not send a
      // second transition, whose only possible answer is the 409 "already
      // published" — an error shown to a user who did nothing wrong.
      disabled={transition.isPending}
      // The EDGE, not just its target: the mutation names the failure with the
      // edge's own verb ("Couldn't publish the tournament"), so the toast says
      // what was clicked.
      onClick={() => transition.mutate(edge)}
    >
      <Icon size={16} />
      {edge.label}
    </Button>
  )
}
