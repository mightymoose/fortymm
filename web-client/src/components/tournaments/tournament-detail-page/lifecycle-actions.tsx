import { useState, type ComponentProps } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import { useTransitionTournament } from '../data/api'
import {
  lifecycleEdgeFor,
  lifecycleRefusalNotice,
  type LifecycleRefusal,
  type LifecycleTone,
} from '../data/lifecycle'
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
 * ## A refused move is reported HERE, in the server's own words
 *
 * **Start tournament** has a precondition (ADR-0786), and it is the one lifecycle
 * refusal a director meets in the ordinary course of running a tournament: the
 * tournament must have at least one event, and every event must have a **draw** whose
 * fixtures still seat exactly its entrants. Registration stays open right up to the
 * moment the tournament starts, so a draw cut yesterday can be stale today — somebody
 * entered, somebody withdrew — and starting on a stale draw would seat a player who has
 * left while the one who replaced them plays nobody.
 *
 * The server refuses that with a **409 that names the offending events**, and this
 * component shows that sentence, under a title of its own, in an `Alert` **beside the
 * button that was clicked** — not in a toast:
 *
 * - a toast leaves after four seconds, and the sentence it carries is a work list
 *   ("“Open Singles” has no draw yet; and “Over 40s” has a draw that no longer matches
 *   its entrants") that a director reads *while* going to fix it;
 * - the mutation therefore carries no global `onError` toast (see `useTransitionTournament`
 *   in `../data/api`), because a mutation whose errors are surfaced inline must not also
 *   toast — the user would be told the same thing twice (`web-client/CLAUDE.md`, ## Forms).
 *
 * Every other outcome is a designed case of the same sum type (`LifecycleRefusal`): not
 * yours (403), signed out (401), our fault (5xx), never got there (network). There is no
 * arm that fails silently.
 *
 * **Nothing here is optimistic.** The status the page renders is the status the *server*
 * last told it (the mutation reconciles the tournament on settle, success or failure), so
 * a refused start leaves the badge reading **Published** — the truth — rather than a
 * hopeful `live` that has to be walked back.
 */
export const LifecycleActions = ({ tournament }: LifecycleActionsProps) => {
  const transition = useTransitionTournament(tournament.id)
  // The last refusal, in words. Cleared when a new attempt starts — a notice about the
  // click before last is worse than none.
  const [refusal, setRefusal] = useState<LifecycleRefusal | null>(null)

  const edge = lifecycleEdgeFor(tournament)
  if (!edge) return null
  const Icon = edge.icon
  const tone = TONE[edge.tone]

  const move = async () => {
    setRefusal(null)
    try {
      await transition.mutateAsync(edge)
    } catch (error) {
      // `mutateAsync` rejects; this notice IS the error surface (there is no toast).
      setRefusal(lifecycleRefusalNotice(error, edge))
    }
  }

  return (
    <div className="flex w-[380px] max-w-full flex-col items-end gap-2.5">
      <Button
        variant={tone.variant}
        className={tone.className}
        // One in-flight move at a time: a double-click on Publish must not send a
        // second transition, whose only possible answer is the 409 "already
        // published" — an error shown to a user who did nothing wrong.
        disabled={transition.isPending}
        onClick={move}
      >
        <Icon size={16} />
        {edge.label}
      </Button>

      {/* The refusal, where the click was. An `Alert` — the app talking back — and not a
          `Card`, which is a content surface (`web-client/CLAUDE.md`, ## Design system). */}
      {refusal && (
        <Alert
          variant="destructive"
          data-testid="lifecycle-notice"
          data-kind={refusal.kind}
        >
          <AlertTitle>{refusal.title}</AlertTitle>
          <AlertDescription>{refusal.description}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
