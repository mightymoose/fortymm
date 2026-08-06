import { Shuffle, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import { useCutDraw, useUncutDraw } from '../../data/api'
import {
  drawRefusalNotice,
  drawState,
  type DrawNotice,
  type DrawRound,
  type SwissByes,
  type UnpooledShape,
} from '../../data/draw'
import type { TournamentEvent } from '../../data/types'
import {
  ConfirmIrreversibleActDialog,
  type DrawActConsequence,
} from '../confirm-irreversible-act-dialog'
import { LeadReason } from './lead-reason'
import { Bracket } from './draw-panel/bracket'
import { PoolDraw } from './draw-panel/pool-draw'
import { ResultsPanel } from './draw-panel/results-panel'
import { RoundList } from './draw-panel/round-list'
import { SwissRounds } from './draw-panel/swiss-rounds'

/**
 * The two acts THIS panel can price — the draw half of `IrreversibleActConsequence`.
 *
 * Narrowed rather than carrying the whole union, because the panel's `switch` below has
 * to be exhaustive over exactly what it can hold: the three lifecycle edges live in the
 * header (`../lifecycle-actions`) and there is no draw verb that could fire one. Widening
 * this would turn the `never` default into a dead arm that has to invent an answer for an
 * act the panel cannot perform.
 */
type DrawActConsequence = Extract<
  IrreversibleActConsequence,
  { variant: 'recut-draw' | 'delete-draw' }
>

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
 * ## The two destructive verbs are priced, the first cut is not
 *
 * Re-cut and Delete each open `ConfirmIrreversibleActDialog` first, and the mutation fires
 * on the confirm alone — Go back and Escape leave the draw exactly as it stands and send
 * nothing, and an overlay click does not even close the dialog (`AlertDialog`
 * `preventDefault`s outside interaction, so a mis-click beside a destructive confirm is
 * inert) (ADR "a confirm prices an irreversible act, a freeze explains an
 * illegal one"). **Generate is deliberately exempt**: the first cut is constructive and
 * re-cuttable, and a confirm there would only train the director to click through the two
 * that matter.
 *
 * The `isPending` lock stays alongside the confirm rather than being replaced by it. A
 * confirm is not a debounce: it asks a question once, while the lock is what keeps two
 * whole-draw replacements from racing.
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
 * - **422** — this event cannot be planned **as it stands**. Always about the event's
 *   configuration, never about its type: every member of `DrawType` has a strategy behind
 *   it (ADR 20260726 shrank the enum to exactly what runs), so the refusals left are a
 *   round-robin with no pools, a pool that would get fewer than two entrants, and a
 *   bracket with fewer than two entrants.
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
  // click before last is worse than none. An opened (or cancelled) dialog is NOT an
  // attempt, so it leaves the standing notice alone.
  const [notice, setNotice] = useState<DrawNotice | null>(null)
  // The act awaiting its confirm, held as the CONSEQUENCE the dialog will price rather
  // than as a queued closure: the dialog needs it anyway, and a stored callback would
  // capture whatever `event` was when the button was clicked.
  const [pending, setPending] = useState<DrawActConsequence | null>(null)

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

  /** The confirmed act, fired. The switch is exhaustive on `DrawActConsequence` — the
   * acts this panel OWNS — so a third destructive draw verb is a TYPE error here rather
   * than a dialog that prices one act and performs another. Deliberately not the whole
   * `IrreversibleActConsequence`: the lifecycle edges are in that union too, and a panel
   * checked against them would red for acts it has no part in. */
  const runConfirmed = (consequence: DrawActConsequence) => {
    setPending(null)
    switch (consequence.variant) {
      case 'recut-draw':
        return attempt('cut the draw', () => cut.mutateAsync(event.id))
      case 'delete-draw':
        return attempt('remove the draw', () => uncut.mutateAsync(event.id))
      default: {
        const exhaustive: never = consequence
        return exhaustive
      }
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
                {/* The two destructive verbs. Neither one mutates on this click: it
                    opens the confirm, and the act is what the confirm's own button
                    fires. */}
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Re-cut draw for ${event.name}`}
                  disabled={isPending}
                  onClick={() =>
                    setPending({ variant: 'recut-draw', eventName: event.name })
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
                    setPending({ variant: 'delete-draw', eventName: event.name })
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

      {/* The price of a destructive verb, asked before it is paid. Mounted only while an
          act is awaiting its answer, so the dialog cannot be on screen with nothing
          behind it. Confirm runs the act it named; cancel — and Escape — drops it, and the
          draw below is untouched because nothing was ever sent. */}
      {pending && (
        <ConfirmIrreversibleActDialog
          open
          consequence={pending}
          onConfirm={() => void runConfirmed(pending)}
          onCancel={() => setPending(null)}
        />
      )}
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
          {/* Fixtures belonging to no pool. **Which view they get is the DRAW TYPE's
              answer, not this list's** (`unpooledShape`, `../../data/draw`): `pool_id IS
              NULL` is the *stage* discriminator for an `rr-then-ko` knockout stage and
              will keep meaning that, while swiss is a pool-less draw *type* that happens
              to share the null. Routing on the null alone is what rendered a swiss draw
              through single-elimination's successor arithmetic. Shown both pre-live (the
              director reviews the seeded round-1 pairings and byes) and live. */}
          {state.unpooled.length > 0 && (
            <UnpooledDraw
              shape={state.unpooledShape}
              rounds={state.unpooled}
              byes={state.swissByes}
            />
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

/**
 * The un-pooled block, in the view its **draw type** calls for — the second half of the
 * routing decision `unpooledShape` (`../../data/draw`) makes.
 *
 * A `switch` with a `never` default, so the two halves are checked at both ends: adding a
 * draw type is a compile error in `unpooledShape` until it names a shape, and adding a
 * shape is a compile error *here* until it has a view. Neither is something a value check
 * on `pool_id` could ever have given us — which is precisely how a swiss draw came to
 * render as a knockout bracket with nothing red.
 *
 * The block keeps its `draw-unpooled` test hook in the bracket arm: it is the same block
 * the existing bracket tests address, and renaming it would churn them for nothing. The
 * other two arms get hooks of their own, so "this event got the rounds view and NOT the
 * bracket" is one assertion rather than an inference.
 *
 * The third arm is the one for fixtures **no format view can place** (`'orphaned'`). It
 * exists because "show it anyway" and "show it as a bracket" are different promises: the
 * first is what `drawState` guarantees (a fixture is never dropped), the second is a claim
 * about the event's shape that a round-robin cannot make.
 */
const UnpooledDraw = ({
  shape,
  rounds,
  byes,
}: {
  shape: UnpooledShape
  rounds: DrawRound[]
  /** Read by the swiss arm alone. `drawState` computes it for that draw type only, so the
   * other two arms are handed an empty map rather than a claim about their format: an
   * entrant in none of a bracket round's fixtures has been **eliminated**, not byed. */
  byes: SwissByes
}) => {
  switch (shape) {
    case 'bracket':
      return (
        <section
          data-testid="draw-unpooled"
          aria-label="Bracket"
          className="rounded-[10px] border border-[color:var(--border-subtle)] p-3"
        >
          <h4 className="text-[13px] font-semibold text-[color:var(--fg-1)]">
            Bracket
          </h4>
          <Bracket rounds={rounds} />
        </section>
      )

    case 'swiss-rounds':
      // Titled "Rounds", not "Bracket": swiss eliminates nobody and has no final, so the
      // bracket's own vocabulary would be a lie in the heading before it was one in the
      // layout.
      return (
        <section
          data-testid="draw-swiss-rounds"
          aria-label="Rounds"
          className="rounded-[10px] border border-[color:var(--border-subtle)] p-3"
        >
          <h4 className="text-[13px] font-semibold text-[color:var(--fg-1)]">
            Rounds
          </h4>
          <SwissRounds rounds={rounds} byes={byes} />
        </section>
      )

    case 'orphaned':
      // Fixtures this event's format cannot place — a round-robin fixture naming a pool the
      // event does not list. **Never dropped** (`drawState`), and never dressed up: a plain
      // numbered list under a neutral heading, because every other view here would say
      // something untrue about it. The bracket said the most: it names its rounds backwards
      // from the last one present, so one stray fixture read as a "Final".
      return (
        <section
          data-testid="draw-orphaned"
          aria-label="Other fixtures"
          className="rounded-[10px] border border-[color:var(--border-subtle)] p-3"
        >
          <h4 className="text-[13px] font-semibold text-[color:var(--fg-1)]">
            Other fixtures
          </h4>
          <RoundList rounds={rounds} groupName="other fixtures" />
        </section>
      )

    default: {
      // A shape without a view is a TYPE error here, not a dropped draw.
      const exhaustive: never = shape
      return exhaustive
    }
  }
}
