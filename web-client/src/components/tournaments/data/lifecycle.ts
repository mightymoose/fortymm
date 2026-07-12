// The tournament lifecycle, as the UI offers it (ADR-0017). Pure data + one
// total function: the component that renders the button (`LifecycleActions`) and
// the header that decides whether to give it a slot at all both read THIS table,
// so "which button?" and "is there a button?" cannot drift apart.

import { Radio, Rocket, Square, type LucideIcon } from 'lucide-react'

import type { Tournament, TournamentStatus } from './types'

/** The button that stands for one edge of the lifecycle. */
export interface LifecycleEdge {
  /** The status this edge moves *to* — the body of the transition request. */
  to: TournamentStatus
  label: string
  icon: LucideIcon
  variant?: 'ghost'
  className?: string
}

/**
 * The forward-only path, one entry per status:
 *
 *     draft ──Publish──▶ published ──Start──▶ live ──End──▶ archived
 *
 * `archived` is terminal — no edge out of it, so `null`: no button, rather than a
 * button whose only possible answer is a 409. The server holds the same table
 * (`LEGAL_TRANSITIONS` in `api/app/tournaments.py`) and is the authority; this one
 * exists so the UI never *offers* an edge the server would refuse. A status picker
 * would offer all four — i.e. mostly illegal jumps — which is why there isn't one.
 */
export const LIFECYCLE_EDGE: Record<TournamentStatus, LifecycleEdge | null> = {
  draft: { to: 'published', label: 'Publish', icon: Rocket },
  published: {
    to: 'live',
    label: 'Start tournament',
    icon: Radio,
    className:
      'border border-[color:rgba(0,226,154,0.35)] bg-[color:rgba(0,226,154,0.1)] text-[color:var(--serve-500)] hover:bg-[color:rgba(0,226,154,0.18)]',
  },
  live: {
    to: 'archived',
    label: 'End tournament',
    icon: Square,
    variant: 'ghost',
  },
  archived: null,
}

/** Whether this tournament offers a lifecycle action at all: an owner, standing
 * on a status that has an edge out of it. The detail header asks *before* it
 * renders its action slot, so a viewer — and an archived tournament — leaves that
 * slot genuinely empty instead of filling it with a wrapper around nothing. */
export function hasLifecycleAction(tournament: Tournament): boolean {
  return tournament.canEdit && LIFECYCLE_EDGE[tournament.status] !== null
}
