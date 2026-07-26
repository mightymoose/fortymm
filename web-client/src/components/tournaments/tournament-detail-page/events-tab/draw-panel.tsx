import { Shuffle, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import { useCutDraw, useUncutDraw } from '../../data/api'
import { drawRefusalNotice, drawState, type DrawNotice } from '../../data/draw'
import type { TournamentEvent } from '../../data/types'
import { LeadReason } from './lead-reason'
import { Bracket } from './draw-panel/bracket'
import { PoolDraw } from './draw-panel/pool-draw'
import { ResultsPanel } from './draw-panel/results-panel'

export interface DrawPanelProps {
  tournamentId: string
  event: TournamentEvent
  /** The tournament's `can_edit` — the server's word on whether this viewer is its
   * creator. Gates the three draw verbs: a non-owner sees the draw and *no* controls
   * (ADR-0015 — hidden, never disabled). Not a security boundary: the API 403s the
   * endpoints independently, and must continue to. */
  canEdit: boolean
}

/**
 * An event's **draw**, on its card in the Events tab (ADR-0786): the pools it was cut
 * across, and — for the director — the three verbs that cut, re-cut and remove it.
 *
 * There is no "Draw" tab, and there should not be: a draw belongs to an *event*, and
 * the tab axis of this page is per-concern (details, events, tables, schedule). A draw
 * that lived in a tab of its own would have to ask which event it meant.
 *
 * ## The two data states, both designed
 *
 * `drawState` (`../../data/draw`) reduces the event to one of them, so this component
 * branches on a **sum type** rather than on `fixtures.length` — a truthiness check on a
 * list is the client-side twin of a tri-state boolean:
 *
 * - **undrawn** — `fixtures: []`, the state every event is born in. It is a *data*
 *   state, not a spinner and not an error: the panel says there is no draw yet, and (for
 *   the director) offers to cut one. Nothing here ever auto-cuts; cutting is an explicit,
 *   reviewable act, which is exactly why the ADR refused to fold it into go-live.
 * - **drawn** — the pools, their members and their fixtures, round by round
 *   (`PoolDraw`).
 *
 * ## Refusals are inline, and the server's sentence is the copy
 *
 * The panel surfaces its own failures — `useCutDraw` / `useUncutDraw` carry **no global
 * `onError` toast**, deliberately (`web-client/CLAUDE.md`, ## Forms: a mutation whose
 * errors are surfaced inline must not also toast, or the user is told twice). The two
 * refusals a director actually meets keep the **server's** wording, because it is
 * authored for them and it names the numbers they must change:
 *
 * - **409** — the draw shows evidence of play. It can no longer be cut or removed.
 * - **422** — this event cannot be planned as it stands: an unsupported draw type (only
 *   round-robin has a generator today), no pools, or a pool that would get fewer than
 *   two entrants.
 *
 * Everything else (403, an expired session, a 5xx, a dead network) has designed words of
 * its own in `drawRefusalNotice` — there is no arm that fails silently.
 *
 * The refused verb leaves the draw exactly as it was: the panel holds no optimistic
 * state, because there is no local edit to apply — only a new draw to read back. Both
 * mutations reconcile the tournament on settle, so the fixtures below rewrite themselves
 * from the refetched event.
 */
export const DrawPanel = ({ tournamentId, event, canEdit }: DrawPanelProps) => {
  const headingId = useId()
  const cut = useCutDraw(tournamentId)
  const uncut = useUncutDraw(tournamentId)
  // The last refusal, in words. Cleared when a new attempt starts — a notice about the
  // click before last is worse than none.
  const [notice, setNotice] = useState<DrawNotice | null>(null)

  const state = drawState(event)
  // One in-flight draw verb at a time. A second click on Re-cut while the first is still
  // flying would race two whole-draw replacements against each other.
  const isPending = cut.isPending || uncut.isPending

  const attempt = async (verb: string, fire: () => Promise<unknown>) => {
    setNotice(null)
    try {
      await fire()
    } catch (error) {
      // `mutateAsync` rejects; the notice IS the error surface (there is no toast).
      setNotice(drawRefusalNotice(error, verb))
    }
  }

  return (
    <section
      data-testid={`draw-panel-${event.id}`}
      aria-labelledby={headingId}
      className="border-t border-[color:var(--border-subtle)] px-[18px] py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id={headingId}
          className="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase"
        >
          Draw
        </h3>
        {/* The verbs, for the director alone. A non-owner gets no button — not a
            disabled one (ADR-0015: a disabled control is an unexplained dead end), and
            not a misleading invitation to generate a draw they cannot generate. */}
        {canEdit && (
          <div className="flex items-center gap-2">
            {state.kind === 'undrawn' ? (
              <Button
                size="sm"
                // Named per event: the tab renders one of these panels per card, and
                // "Generate draw" alone would be five identical buttons.
                aria-label={`Generate draw for ${event.name}`}
                disabled={isPending}
                onClick={() =>
                  attempt('cut the draw', () => cut.mutateAsync(event.id))
                }
              >
                <Shuffle size={14} />
                Generate draw
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Re-cut draw for ${event.name}`}
                  disabled={isPending}
                  onClick={() =>
                    attempt('cut the draw', () => cut.mutateAsync(event.id))
                  }
                >
                  <Shuffle size={14} />
                  Re-cut draw
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete draw for ${event.name}`}
                  disabled={isPending}
                  onClick={() =>
                    attempt('remove the draw', () => uncut.mutateAsync(event.id))
                  }
                >
                  <Trash2 size={14} />
                  Delete draw
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {/* The refusal, where the click was — an `Alert` (the app talking back), not a
          toast that leaves after four seconds carrying the one sentence that says what
          to change. */}
      {notice && (
        <Alert
          variant="destructive"
          data-testid={`draw-notice-${event.id}`}
          className="mt-2.5"
        >
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.description}</AlertDescription>
        </Alert>
      )}

      <DrawBody state={state} canEdit={canEdit} />

      {/* The results (ADR-0788, ADR-0785): pool **standings** for a round-robin, a
          **finishes** placement list for a single-elimination bracket — `ResultsPanel`
          switches on the results `kind`. Dropped in unconditionally — it renders NOTHING for
          an event with no results (`event.results === null`: uncut, or a draw type with no
          results strategy yet), which is the designed data state, so there is no branch to
          keep in sync here. It sits below the fixtures because a director reads the pairings
          first and the table/placements they fill in second; it is live BFF data, so it
          updates on the same refetch the rest of the card does, with no wiring of its own. */}
      <ResultsPanel event={event} />
    </section>
  )
}

const DrawBody = ({
  state,
  canEdit,
}: {
  state: ReturnType<typeof drawState>
  canEdit: boolean
}) => {
  switch (state.kind) {
    case 'undrawn':
      // Empty is a **designed data state**, never a gap and never a spinner. The copy
      // is voiced for whoever is reading it (ADR-0015, rule 5: swap organizer-voiced
      // copy): the director is told what the button beside them does; a player is told,
      // plainly, that the fixtures are not up yet — not invited to press a button that
      // is not there.
      return (
        <LeadReason
          className="mt-1.5"
          testId="draw-empty"
          lead="No draw yet."
          reason={
            canEdit
              ? 'Generate the draw to deal this event’s entrants into its pools and plan their fixtures.'
              : 'The fixtures will appear here once the director cuts the draw.'
          }
        />
      )

    case 'drawn':
      return (
        <div className="mt-2.5 flex flex-col gap-2.5">
          {state.pools.map((pool) => (
            <PoolDraw key={pool.id} pool={pool} />
          ))}
          {/* Fixtures belonging to no pool — a single-elim bracket (or the KO stage of an
              rr-then-ko). Rendered as rounds-as-columns by `Bracket` (ADR-0785), which
              replaces the flat `RoundList` here; pools above keep `RoundList`. Shown both
              pre-live (the director reviews the seeded round-1 pairings and byes) and
              live. */}
          {state.unpooled.length > 0 && (
            <section
              data-testid="draw-unpooled"
              aria-label="Bracket"
              className="rounded-[10px] border border-[color:var(--border-subtle)] p-3"
            >
              <h4 className="text-[13px] font-semibold text-[color:var(--fg-1)]">
                Bracket
              </h4>
              <Bracket rounds={state.unpooled} />
            </section>
          )}
        </div>
      )

    default: {
      // A third draw state without copy is a TYPE error here, not a blank card section.
      const exhaustive: never = state
      return exhaustive
    }
  }
}
