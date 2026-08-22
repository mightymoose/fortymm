import { Lock, Shuffle, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import { useCutDraw, useUncutDraw } from '../../data/api'
import {
  drawRefusalNotice,
  drawRefusalScope,
  drawState,
  drawVerbFreeze,
  undrawnLead,
  type DrawNotice,
  type DrawRound,
  type EditFreeze,
  type SwissByes,
  type UngroupedShape,
} from '../../data/draw'
import type { DrawType, TournamentEvent } from '../../data/types'
import { useScopedNotice } from '../../data/use-scoped-notice'
import {
  ConfirmIrreversibleActDialog,
  type DrawActConsequence,
} from '../confirm-irreversible-act-dialog'
import { LeadReason } from './lead-reason'
import { Bracket } from './draw-panel/bracket'
import { GroupDraw } from './draw-panel/group-draw'
import { ResultsPanel } from './draw-panel/results-panel'
import { RoundList } from './draw-panel/round-list'
import { SwissRounds } from './draw-panel/swiss-rounds'

// `DrawActConsequence` — the two acts THIS panel can price — is imported above rather
// than re-derived here. It is narrower than `IrreversibleActConsequence` because the
// panel's `switch` below has to be exhaustive over exactly what it can hold: the three
// lifecycle edges live in the header (`../lifecycle-actions`) and there is no draw verb
// that could fire one. Widening it would turn the `never` default into a dead arm that
// has to invent an answer for an act the panel cannot perform.

/**
 * The classes a frozen verb wears — what `disabled:` would have given for free, re-hung on
 * `aria-disabled`. `cursor-not-allowed` and `opacity-50` are that pair; the four after
 * them are what make a dead verb *look* dead:
 *
 * - **`text-…`** mutes the label at rest. `outline`'s Re-cut is `text-foreground` and
 *   `ghost`'s Delete is already `--fg-2`, so without it the two frozen verbs would sit
 *   side by side in different weights of dead.
 * - **`hover:bg-transparent`** and **`hover:text-…`** take back the variant's hover tint
 *   (`outline` lifts its background, `ghost` lifts its background *and* its text). Both
 *   land on the resting colour above, so the verb does not change at all under the cursor:
 *   a control that lights up while the cursor beside it reads `not-allowed` is telling the
 *   director two different things.
 * - **`active:…translate-y-0`** takes back the depress. A button that sinks under the
 *   click is saying the click was taken. The `not-aria-[haspopup]` qualifier is carried
 *   over from the base rule this overrides, so that this one is strictly *more* specific —
 *   the two would otherwise tie at three selectors and be settled by stylesheet order.
 *
 * `pointer-events-none` is pointedly NOT among them: the click must still land and be
 * refused *by the handler*, or "a frozen verb opens no confirm" becomes untestable — a
 * dialog that never appeared cannot tell a working guard from a click that was swallowed
 * by CSS.
 */
const FROZEN_VERB_CLASSES =
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ' +
  'aria-disabled:text-[color:var(--fg-2)] aria-disabled:hover:bg-transparent ' +
  'aria-disabled:hover:text-[color:var(--fg-2)] ' +
  'aria-disabled:active:not-aria-[haspopup]:translate-y-0'

/**
 * How a **frozen** draw verb is dressed: unavailable, focusable, and pointing at the
 * sentence that says why.
 *
 * `aria-disabled` rather than the `disabled` attribute, deliberately — see the component
 * doc. The three parts are one decision and travel together, which is why they are a
 * function and not three props repeated on two buttons:
 *
 * - **`aria-disabled`** announces the state without removing the verb from the tab order.
 * - **`aria-describedby`** is the only channel the reason has. It is what makes this a
 *   frozen control rather than #1223's grey box with a sentence painted beside it.
 * - **the classes** (`FROZEN_VERB_CLASSES`) make the dead state look dead.
 *
 * It takes the **`EditFreeze` itself**, never a boolean and an id. The boolean and the
 * reason are one decision, and the sum type exists precisely so the pair cannot be
 * reconstructed by hand: `frozenVerb(true, someUnrelatedId)` type-checked, and dressing a
 * verb as frozen while the freeze was open was a two-argument slip away.
 *
 * Open, it contributes nothing at all — not `aria-disabled="false"`, which is a claim of
 * its own that a screen reader will read out.
 */
const frozenVerb = (freeze: EditFreeze, reasonId: string) =>
  freeze.kind === 'frozen'
    ? {
        'aria-disabled': true,
        'aria-describedby': reasonId,
        className: FROZEN_VERB_CLASSES,
      }
    : {}

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
 * An event's **draw**, on its card in the Events tab (ADR-0786): the groups it was cut
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
 * - **drawn** — the groups, their members and their fixtures, round by round
 *   (`GroupDraw`).
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
 * ## Once the draw is under way, both verbs freeze — disabled with the reason, not hidden
 *
 * `drawVerbFreeze` (`../../data/draw`) restates the server's play guard, so a draw with a
 * recorded winner or a linked match renders Re-cut and Delete **dead, present, and
 * explained** — instead of offering a click that can only 409 (#1060). A frozen verb opens
 * no confirm: a dialog pricing an act that cannot happen is pure ceremony.
 *
 * **Hiding them would be the wrong rule.** ADR-0015's "hide, never disable" answers a
 * *permission* boundary — a person who can never do this, for whom the button's absence
 * asks no question. This is a *state* boundary, and the director in front of it could
 * re-cut a minute ago. A button that vanishes from under someone entitled to it asks a
 * very loud question and answers none of it; the fix for an unexplained dead end is the
 * explanation, not a deeper silence.
 *
 * **`aria-disabled`, not `disabled`** — and that is not a detail. A `disabled` button is
 * out of the tab order, so a director driving this page by keyboard never reaches it and
 * many screen readers skip it entirely: its `aria-describedby` reason is a sentence
 * nobody will ever hear. That is exactly the omission #1223 is open against on the frozen
 * draw-type control, and copying the pattern would copy the defect. `aria-disabled` keeps
 * the verb focusable and announced *as* unavailable, with the reason attached, and the
 * click it still receives is refused in the handler. `disabled` is kept for `isPending`,
 * which is a momentary lock nobody needs read to them.
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
 *   round-robin with no groups, a group that would get fewer than two entrants, and a
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
  // The one place the freeze's reason is written, and the one thing both frozen verbs
  // point at with `aria-describedby`: one explanation, said once.
  const freezeNoticeId = useId()
  const cut = useCutDraw(tournamentId)
  const uncut = useUncutDraw(tournamentId)
  // The last refusal, in words — held only while the state it describes still stands
  // (`useScopedNotice`). Cleared when a new attempt starts, and again the moment the
  // director *fixes* what it named: "A single-elim draw cannot be cut yet. Change the
  // event's draw type to one that can" must not survive the draw type being changed to one
  // that can (#1123), and "0 entrants across 2 groups" must not survive somebody entering
  // (#1049). The panel does not remount on either — the card is keyed by event id — so
  // without the scope the sentence sat there until the next Generate.
  //
  // An opened (or cancelled) dialog is NOT an attempt and changes none of those facts, so
  // it leaves the standing notice alone; neither does a poll tick
  // (`drawRefusalScope` is narrow for exactly that reason).
  const [notice, setNotice] = useScopedNotice<DrawNotice>(drawRefusalScope(event))
  // The act awaiting its confirm, held as the CONSEQUENCE the dialog will price rather
  // than as a queued closure: the dialog needs it anyway, and a stored callback would
  // capture whatever `event` was when the button was clicked.
  const [pending, setPending] = useState<DrawActConsequence | null>(null)

  const state = drawState(event)
  // One in-flight draw verb at a time. A second click on Re-cut while the first is still
  // flying would race two whole-draw replacements against each other.
  const isPending = cut.isPending || uncut.isPending
  // Evidence of play seals the draw (ADR-0786). Asked of the EVENT, not of `state`: the
  // renderer's `FixtureLine` drops a match that arrived without a status, and a freeze
  // read off it would be laxer than the guard it restates (`drawVerbFreeze`).
  const freeze = drawVerbFreeze(event)
  const frozen = freeze.kind === 'frozen'

  /** Everything the two destructive verbs share: the in-flight lock, the frozen dress, and
   * the click that names an act **without performing it** — the confirm's button is what
   * fires it. One helper rather than two copies, because the guard and the dress are the
   * same decision on both buttons and a verb that kept one without the other would be
   * either a dead-looking button that still fires or a live-looking one that cannot. All
   * that differs between them is the act. */
  const destructiveVerb = (variant: DrawActConsequence['variant']) => ({
    disabled: isPending,
    ...frozenVerb(freeze, freezeNoticeId),
    onClick: () => {
      // The refusal is HERE, not in CSS: the click lands on a frozen verb (see
      // `FROZEN_VERB_CLASSES`) and is turned away, so no confirm opens and nothing is sent.
      if (frozen) return
      setPending({ variant, eventName: event.name })
    },
  })

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
                    fires — unless the draw is under way, in which case neither the
                    confirm nor the request happens at all and the notice below says
                    why (`frozenVerb`). */}
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Re-cut draw for ${event.name}`}
                  {...destructiveVerb('recut-draw')}
                >
                  <Shuffle size={14} />
                  Re-cut draw
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete draw for ${event.name}`}
                  {...destructiveVerb('delete-draw')}
                >
                  <Trash2 size={14} />
                  Delete draw
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Why the two verbs above are dead — the whole content of the freeze, in one place,
          and the sentence both of them `aria-describedby`. Not `destructive`: nothing has
          gone wrong, a draw under way is the *correct* state of an event being played.

          The director's alone. A reader has no verbs to explain and no draw to delete, so
          this is organizer-voiced copy they could do nothing with (ADR-0015, rule 5) — and
          gating it with the buttons keeps the description from ever pointing at an element
          that is not on the page.

          Addressed by testid rather than by role, exactly as the reservations section learned to
          be: this and the refusal below are both `Alert`s, so "the alert" was never a name
          for one of them. It is not one now either — this notice is a `status` and that one
          is an `alert` — but a testid says which notice a test means, where a role only
          says which kind of announcement it is. */}
      {canEdit && freeze.kind === 'frozen' && (
        <Alert
          // `role="status"` — polite — over the `Alert`'s own hardcoded `role="alert"`,
          // which is assertive and interrupts whatever a screen reader is saying. This is
          // a **standing condition**, true on load and true for as long as the page is
          // open: nothing just happened. (The `Alert` spreads `{...props}` after its own
          // role, so this wins.) The refusal below keeps `alert` — that one *is* an event,
          // and it lands in answer to a click.
          role="status"
          data-testid={`draw-frozen-notice-${event.id}`}
          className="mt-2.5"
        >
          <Lock size={16} />
          {/* The title names what it means for the two controls; the description names the
              cause. Between them they say it once each — the title is not a shorter copy
              of the sentence beneath it. */}
          <AlertTitle>Re-cut and Delete are unavailable</AlertTitle>
          {/* The id sits on the DESCRIPTION, not on the `Alert`, so a verb's accessible
              description is the reason and only the reason — not the reason with the title
              read out in front of it. */}
          <AlertDescription id={freezeNoticeId}>{freeze.reason}</AlertDescription>
        </Alert>
      )}

      {/* The refusal, where the click was — an `Alert` (the app talking back), not a
          toast that leaves after four seconds carrying the one sentence that says what
          to change.

          **The freeze supersedes it.** A refusal is a standing notice about the last
          *attempt*, and it is cleared when the next one starts (`attempt`) — but once the
          verbs are frozen there is no next attempt: both short-circuit before `attempt`
          runs, and Generate is not rendered on a drawn event. So a refusal caught on the
          way into the freeze — the director clicks Re-cut on an unplayed draw, a score
          lands first, the 409 comes back, the refetch brings the evidence — would sit
          there for good, a red alert saying almost what the freeze above it says, with
          nothing in the panel able to clear it. The freeze is the same fact, current and
          complete, so it does the talking alone. */}
      {!frozen && notice && (
        <Alert
          variant="destructive"
          data-testid={`draw-notice-${event.id}`}
          className="mt-2.5"
        >
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.description}</AlertDescription>
        </Alert>
      )}

      <DrawBody state={state} drawType={event.drawType} canEdit={canEdit} />

      {/* The results (ADR-0788, ADR-0785): group **standings** for a round-robin, a
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
  drawType,
  canEdit,
}: {
  state: ReturnType<typeof drawState>
  /** Read by the `undrawn` arm alone, to say what a cut would actually produce. The
   * event's own, not a shape inferred from fixtures — an un-cut event has none. */
  drawType: DrawType
  canEdit: boolean
}) => {
  switch (state.kind) {
    case 'undrawn':
      // Empty is a **designed data state**, never a gap and never a spinner. The copy
      // is voiced for whoever is reading it (ADR-0015, rule 5: swap organizer-voiced
      // copy): the director is told what the button beside them does; a player is told,
      // plainly, that the fixtures are not up yet — not invited to press a button that
      // is not there.
      //
      // The director's half is the DRAW TYPE's answer (`undrawnLead`), not one sentence
      // for all four: a bracket event was being told to deal its entrants "into its
      // groups" (#1220). The reader's half needs no such split — "the fixtures will
      // appear here" is true of every draw type, and naming the format would only tell a
      // player something they cannot act on.
      return (
        <LeadReason
          className="mt-1.5"
          testId="draw-empty"
          lead="No draw yet."
          reason={
            canEdit
              ? undrawnLead(drawType)
              : 'The fixtures will appear here once the director cuts the draw.'
          }
        />
      )

    case 'drawn':
      return (
        <div className="mt-2.5 flex flex-col gap-2.5">
          {state.groups.map((group) => (
            <GroupDraw key={group.id} group={group} />
          ))}
          {/* Fixtures belonging to no group. **Which view they get is their own STAGE's
              answer, not this list's** (`shapeForStage`/`ungroupedShapeOf`,
              `../../data/draw`, ADR 20260815): `stageId` names the stage outright, so
              `group_id IS NULL` no longer has to double as a discriminator between an
              `rr-then-ko` knockout stage and a groupless swiss draw that happens to share
              the null. Routing on the null alone is what rendered a swiss draw through
              single-elimination's successor arithmetic. Shown both pre-live (the director
              reviews the seeded round-1 pairings and byes) and live. */}
          {state.ungrouped.length > 0 && (
            <UngroupedDraw
              shape={state.ungroupedShape}
              rounds={state.ungrouped}
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
 * The ungrouped block, in the view its **own stage's draw type** calls for — the second
 * half of the routing decision `ungroupedShapeOf`/`shapeForStage` (`../../data/draw`)
 * makes.
 *
 * A `switch` with a `never` default, so the two halves are checked at both ends: adding a
 * (single-stage) draw type is a compile error in `shapeForStage` until it names a shape,
 * and adding a shape is a compile error *here* until it has a view. Neither is something a
 * value check on `group_id` could ever have given us — which is precisely how a swiss draw
 * came to render as a knockout bracket with nothing red.
 *
 * The block keeps its `draw-ungrouped` test hook in the bracket arm: it is the same block
 * the existing bracket tests address, and renaming it would churn them for nothing. The
 * other two arms get hooks of their own, so "this event got the rounds view and NOT the
 * bracket" is one assertion rather than an inference.
 *
 * The third arm is the one for fixtures **no format view can place** (`'orphaned'`). It
 * exists because "show it anyway" and "show it as a bracket" are different promises: the
 * first is what `drawState` guarantees (a fixture is never dropped), the second is a claim
 * about the event's shape that a round-robin cannot make.
 */
const UngroupedDraw = ({
  shape,
  rounds,
  byes,
}: {
  shape: UngroupedShape
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
          data-testid="draw-ungrouped"
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
      // Fixtures this event's format cannot place — a round-robin fixture naming a group the
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
