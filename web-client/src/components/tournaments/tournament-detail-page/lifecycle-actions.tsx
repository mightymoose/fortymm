import { Button } from '@/components/ui/button'

import { useTransitionTournament } from '../data/api'
import { hasLifecycleAction, LIFECYCLE_EDGE } from '../data/lifecycle'
import type { Tournament } from '../data/types'

export interface LifecycleActionsProps {
  tournament: Tournament
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
 * `../data/lifecycle`, which also answers whether there is an action at all.
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

  const edge = LIFECYCLE_EDGE[tournament.status]
  if (!hasLifecycleAction(tournament) || !edge) return null
  const Icon = edge.icon

  return (
    <Button
      variant={edge.variant}
      className={edge.className}
      // One in-flight move at a time: a double-click on Publish must not send a
      // second transition, whose only possible answer is the 409 "already
      // published" — an error shown to a user who did nothing wrong.
      disabled={transition.isPending}
      onClick={() => transition.mutate(edge.to)}
    >
      <Icon size={16} />
      {edge.label}
    </Button>
  )
}
