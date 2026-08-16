import { useEffect, useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, useWatch } from 'react-hook-form'
import { Check, Trash2, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { drawTypeFreeze, groupSetFreeze, type EditFreeze } from '../data/draw'
import { reservationNameIssues } from '../data/event-validation'
import { eligibilityIssues } from '../data/predicate-validation'
import {
  EVENT_SAVE_TARGET,
  saveFailure as classifySaveFailure,
  saveFailureMessage,
  type SaveFailure,
} from '../data/save-failure'
import type {
  DrawTypeOption,
  EditedEvent,
  TournamentEvent,
  TournamentTable,
} from '../data/types'
import { BasicsSection } from './event-editor/basics-section'
import { DrawStructureSection } from './event-editor/draw-structure-section'
import { EligibilitySection } from './event-editor/eligibility-section'
import { MatchSection } from './event-editor/match-section'
import { ReservationsSection } from './event-editor/reservations-section'
import {
  eventSchema,
  eventToFormValues,
  firstInvalidSection,
  type EventFormValues,
} from './event-form'

export interface EventEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The event to edit. A new event has an id beginning `new-`. */
  event: TournamentEvent | null
  /** The tables available to this tournament (for the reservations tab). */
  tables: TournamentTable[]
  /** The draw formats the server offers, off the tournament payload (ADR 20260726) —
   * handed to the Basics tab's picker, and to `drawTypeFreeze`, whose frozen reason
   * quotes the same option the director is looking at. A catalogue, like `tables`: the
   * editor holds no vocabulary of its own. */
  drawTypes: DrawTypeOption[]
  /** When false (a non-creator), the Save and Delete actions are hidden and the
   * editor becomes a read-only view of the event. */
  canEdit: boolean
  /** Persist the edited event — an `EditedEvent`, whose reservations are the organizer's
   * **diff** (`ReservationEntry`) rather than rows read back: each one either cites the id
   * the server minted or carries none at all, and a stored reservation no entry cites is a
   * removal (ADR 20260801). **May be async — and the editor awaits it**: it
   * closes itself only when the promise RESOLVES, and a rejection keeps the sheet
   * open, with the work intact and the failure on screen. A caller that fires the
   * mutation and closes regardless turns every server refusal into a silently
   * discarded event (the #614 rule, learned again in #933 / #934, and once more here
   * from a `between` rule with no bounds: a 422 came back, the sheet shut, and
   * everything the organizer had typed went with it). */
  onSave: (event: EditedEvent) => void | Promise<void>
  onDelete: (id: string) => void
  /**
   * Whether the save MUTATION is still in flight — the repo's pending-mutation gate
   * (`mutation.isPending` → `disabled`, as `EnterEventControl` and `LifecycleActions`
   * do it), threaded down because the mutations live at the route and the editor is
   * handed an `onSave`.
   *
   * ⚠️ It is **not** the same fact as React-Hook-Form's `isSubmitting`, and that is the
   * whole reason it exists (#1231 QA: five rapid clicks on Create event made five
   * identical events). `isSubmitting` is true only while the `onSave` promise is
   * unsettled. `isPending` stays true until the mutation has SETTLED — including
   * `onSuccess`, which awaits `invalidateTournament`'s refetch — and that is the window
   * the duplicates came through: the sheet is still on screen (Radix keeps the content
   * mounted through its close animation) with a button that had already re-enabled
   * itself. Two windows, one button: it is disabled for the union of them.
   */
  saving?: boolean
}

/** The four tabs every event has, whatever its format. */
const SECTIONS = [
  { value: 'basics', label: 'Basics' },
  { value: 'eligibility', label: 'Eligibility' },
  { value: 'match', label: 'Match settings' },
  { value: 'reservations', label: 'Reservations' },
]

/** The fifth tab, and the only **conditional** one: a draw structure is the shape of a
 * group stage feeding a knockout, and only `rr-then-ko` has both (ADR 20260808 — "the
 * Draw structure tab is conditional"). A round-robin has no bracket to aim at, a
 * single-elimination has no groups to split, and swiss has neither, so for those three
 * the tab is *absent* rather than empty: a tab that opened onto settings the format
 * cannot hold would invite a director to configure a draw their event will never cut. */
const DRAW_STRUCTURE_SECTION = { value: 'draw-structure', label: 'Draw structure' }

/** The slide-in event editor — a side sheet with four sections (Basics,
 * Eligibility, Match settings, Reservations) over ONE React-Hook-Form draft. The form
 * is the single source of truth: the scalar Basics/Match fields write back through
 * `applyChange`, the nested-array sections drive the same form through
 * `useFieldArray`, and every field of it is resolved against `eventSchema`.
 *
 * **A save is a request, and a request can be refused.** The two ways this editor
 * takes that seriously:
 *
 * - It *checks the draft first* (`eventSchema`, `./event-form`) and refuses to send
 *   one the server would 422 — a blank or 256-character name, a cap of `0` or of ten
 *   billion, a missing entry fee, a rule with no value, a `between` with one bound or
 *   an inverted pair, **a reservation whose name has been cleared** — pointing the organizer
 *   at the tab holding the offending field instead. That is a Zod schema mirroring the
 *   server's constraints, which is the house rule for a form (`CLAUDE.md`, `## Forms`).
 *
 *   What it does **not** refuse is a *blank player limit*: that is an uncapped event
 *   (ADR-0935), it is a real answer, and it saves as `null`.
 * - And when a request is refused *anyway* — an unknown 422, a 5xx, an outage — it
 *   **keeps the sheet open**, keeps the work, and says what happened **in our own
 *   words** (`data/save-failure`). Client-side validation only ever prevents the
 *   refusals we already know about; this is what stops the next unknown one from
 *   eating somebody's work — without reading Pydantic's prose out to them.
 *
 * Neither the Save button nor the tabs are gated on validity: a disabled Save with no
 * explanation is the dead end ADR-0015 is about (and the repo's Forms convention says
 * the same of `disabled={!isValid}`). Save is live, and pressing it is what produces
 * the red. */
export const EventEditor = ({
  open,
  onOpenChange,
  event,
  tables,
  drawTypes,
  canEdit,
  onSave,
  onDelete,
  saving = false,
}: EventEditorProps) => {
  const [section, setSection] = useState('basics')
  const [seenEvent, setSeenEvent] = useState(event)
  /** How the last save was refused, or `null`. A classified failure — never a raw
   * server string (see `data/save-failure`). Never a reason to close. */
  const [failure, setFailure] = useState<SaveFailure | null>(null)

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventSchema),
    defaultValues: eventToFormValues(event),
  })

  // Jump back to the first section whenever the editor is (re)opened on a
  // different event — adjusting state during render rather than in an effect
  // (https://react.dev/learn/you-might-not-need-an-effect).
  if (event !== seenEvent) {
    setSeenEvent(event)
    setSection('basics')
    // A fresh event starts clean: last time's red belongs to last time's draft.
    setFailure(null)
  }

  // Re-seed the form to the new event's values (and clear any prior errors). The
  // sheet stays mounted, so without this a second open would show the last
  // attempt. `form.reset` writes RHF's own store, so it belongs in an effect.
  useEffect(() => {
    form.reset(eventToFormValues(event))
  }, [event, form])

  const isNew = !event || event.id.startsWith('new')

  // The bridged draft the scalar sections read from: the non-editable fields off
  // the event, with every editable field taken from live form state. Editing a
  // scalar section writes back through `applyChange`, so the form stays
  // authoritative. `useWatch` (not `form.watch()`) subscribes reactively and is
  // memoizable. The nested-array sections (Eligibility, Reservations) instead drive
  // the same form directly via `useFieldArray` off `form.control` — their
  // add/edit/remove is form state, not a bridged draft (chore 1e).
  const values = useWatch({ control: form.control })
  const draft: TournamentEvent | null = event
    ? { ...event, ...(values as Partial<TournamentEvent>) }
    : null

  const {
    formState: { errors, isSubmitting, isSubmitted },
  } = form

  // What is wrong with the RULES, row by row. The resolver's own verdict on
  // `predicates` is deliberately a single "this list is not sendable" issue
  // (`eventSchema`), because a zod path cannot address `between`'s two bounds inside
  // one `value` tuple — so the row-level red comes from the very validator the
  // resolver calls (`eligibilityIssues`), keyed by predicate id. One rule, two readers
  // of it; never two rules.
  //
  // Computed every render, so a fixed rule stops complaining the moment it is fixed —
  // and shown only once the organizer has *tried* to save: a value box they have not
  // filled in yet is not yet wrong.
  const watchedPredicates = useWatch({ control: form.control, name: 'predicates' })
  const ruleIssues = eligibilityIssues(watchedPredicates ?? [])

  // …and the same arrangement for the RESERVATIONS, for the same two reasons and one
  // more of its own. The resolver refuses the save (`reservationNameSchema` inside
  // `eventSchema`); this is what puts the red under the box that is empty. It is
  // computed from live form values rather than read off `errors.reservations` because a
  // reservation card writes its edits back through `useFieldArray`'s `update()`, which —
  // unlike append/remove — does NOT re-run the resolver (RHF 7.81). Read off the errors,
  // the red would outlive the fix: it would sit under a name the organizer had already
  // re-typed, until they pressed Save again to find out they were done.
  const watchedReservations = useWatch({ control: form.control, name: 'reservations' })
  const reservationIssues = reservationNameIssues(watchedReservations ?? [])

  const applyChange = (next: TournamentEvent) => {
    // Don't validate until the user has tried to save once — otherwise a new
    // event (whose name starts empty) would flash "required" on the first
    // keystroke in any field. After a rejected submit, re-validate live so the
    // inline errors clear as they're fixed.
    const opts = { shouldDirty: true, shouldValidate: isSubmitted }
    form.setValue('name', next.name, opts)
    form.setValue('format', next.format, opts)
    form.setValue('drawType', next.drawType, opts)
    // Written back beside the draw type, because the resolver judges the two as one pair
    // (ADR 20260727): a draw type set without its count would be validated against a
    // stale K, and a count without its type against a stale arm.
    form.setValue('qualifiersPerGroup', next.qualifiersPerGroup, opts)
    // …and the round count with them, for the identical reason (the swiss ADR): the
    // resolver judges `(drawType, rounds)` as one pair too, so a draw type set without its
    // round count would be validated against a stale R.
    form.setValue('rounds', next.rounds, opts)
    form.setValue('maxPlayers', next.maxPlayers, opts)
    form.setValue('entryFee', next.entryFee, opts)
    form.setValue('timezone', next.timezone, opts)
    form.setValue('slot', next.slot, opts)
    form.setValue('match', next.match, opts)
  }

  const submit = form.handleSubmit(
    async (formValues) => {
      if (!event) return
      // The event that was opened, with every editable field taken from the form —
      // `reservations` included, which is why this is an `EditedEvent` and not a
      // `TournamentEvent`: the form holds entries, and an entry is not a reservation.
      // Handing the read model's reservations back instead would re-send the ids on a
      // create (a 422) and lose the added/kept distinction on a patch.
      const saved: EditedEvent = { ...event, ...formValues }
      setFailure(null)
      try {
        await onSave(saved)
        // The editor closes itself, and this is the ONLY thing that closes it: a
        // rejection lands in the catch below, with the sheet — and the work in it —
        // untouched.
        onOpenChange(false)
      } catch (error) {
        setFailure(classifySaveFailure(error))
      }
    },
    // Refused HERE, so nothing was sent and nothing can be lost. Take them to the tab
    // holding the offending field: a save that failed on a tab you cannot see is
    // indistinguishable from a button that does nothing.
    (formErrors) => setSection(firstInvalidSection(formErrors) ?? 'basics'),
  )

  // "Edit event" is an imperative addressed to the person in control. A viewer
  // is not one — the panel is a rendering of the event, so it says so
  // (ADR 0015, rule 5).
  const overline = !canEdit ? 'Event' : isNew ? 'New event' : 'Edit event'

  const basicsErrors = {
    name: errors.name?.message,
    qualifiersPerGroup: errors.qualifiersPerGroup?.message,
    rounds: errors.rounds?.message,
    maxPlayers: errors.maxPlayers?.message,
    entryFee: errors.entryFee?.message,
    timezone: errors.timezone?.message,
  }

  // **What a cut draw freezes** (ADR-0786), derived from the SAVED event and never from
  // the draft: `fixtures` is not a form field — nothing on this sheet can cut a draw or
  // remove one — so the draft's copy of it is the server's answer, unedited. An event
  // still being created (`event === null`) has no draw, and cannot: there is nobody
  // entered to deal.
  //
  // Two freezes, two controls, two different tabs — so they are two values, not one
  // `frozen: boolean` handed to both. The reservations section may not add or remove a
  // reservation (which would add or remove the group it mints, 1:1); the Basics tab may
  // not re-label the draw type. Everything else on both tabs stays live, including —
  // pointedly — a reservation's tables, window and name.
  const OPEN: EditFreeze = { kind: 'open' }
  const reservationsFreeze = event ? groupSetFreeze(event) : OPEN
  const drawTypeLock = event ? drawTypeFreeze(event, drawTypes) : OPEN

  // ⚠️ Keyed off the **draft's** draw type, not the saved event's. The Basics picker
  // writes the draft, so the tab appears the moment a director picks the two-stage
  // format and disappears the moment they pick something else — before anything is
  // saved, which is when they are deciding.
  const hasDrawStructure = draft?.drawType === 'rr-then-ko'
  const sections = hasDrawStructure
    ? [...SECTIONS, DRAW_STRUCTURE_SECTION]
    : SECTIONS
  // …and that disappearance is why the active tab is DERIVED rather than read straight
  // out of state. A `Tabs` whose `value` matches no trigger renders no panel at all —
  // a blank sheet with nothing selected. Today nothing reaches that: the draw-type
  // picker is on Basics, so a director necessarily leaves this tab before they can
  // remove it. It is three lines of insurance against the next thing that sets the
  // section (chore 3e moves a field onto this tab, and a refused save jumps to the tab
  // holding it). Adjusted at render, never in an effect — the render already knows
  // (https://react.dev/learn/you-might-not-need-an-effect).
  const activeSection = sections.some((s) => s.value === section)
    ? section
    : 'basics'

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:w-[820px] sm:max-w-[820px]"
      >
        <SheetHeader className="mb-0 border-b border-[color:var(--border-subtle)] px-6 pt-6 pb-5">
          <SheetDescription
            data-testid="event-editor-overline"
            className="text-[11px] font-semibold tracking-[0.14em] uppercase"
          >
            {overline}
          </SheetDescription>
          <SheetTitle className="truncate text-[20px]">
            {draft?.name || 'Untitled event'}
          </SheetTitle>
        </SheetHeader>

        {draft && (
          // The editor's scroll container. It scrolls VERTICALLY — that is the design,
          // and a long form on a short phone has to. What it must never do is scroll
          // *sideways*: `overflow-y: auto` computes `overflow-x: auto` too, so a field
          // laid out past the right-hand edge does not clip, it hides behind a
          // horizontal scrollbar nothing advertises. The testid is how the phone spec
          // measures that (`expectNoHorizontalScroll`) rather than taking a screenshot's
          // word for it.
          <div
            data-testid="event-editor-body"
            className="flex-1 overflow-y-auto px-6 py-5"
          >
            <Tabs value={activeSection} onValueChange={setSection}>
              {/* The scroll wrapper is the FIFTH tab's doing. Every trigger is
                  `whitespace-nowrap`, so the list cannot shrink below its own min-content
                  width — and "Basics · Eligibility · Match settings · Reservations · Draw
                  structure" is wider than a 375px phone. Left to overflow it would widen
                  the sheet's scroll container instead, which is the sideways-hiding bug
                  this editor has already shipped twice (`expectNoHorizontalScroll`, the
                  phone spec). Scrolling the LIST keeps every tab reachable and keeps the
                  overflow out of the body. */}
              <div className="mb-6 overflow-x-auto">
                <TabsList className="w-full min-w-max">
                  {sections.map((s) => (
                    <TabsTrigger
                      key={s.value}
                      value={s.value}
                      className="flex-1"
                    >
                      {s.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <TabsContent value="basics">
                <BasicsSection
                  event={draft}
                  canEdit={canEdit}
                  errors={basicsErrors}
                  drawTypeFreeze={drawTypeLock}
                  drawTypes={drawTypes}
                  onChange={applyChange}
                />
              </TabsContent>
              <TabsContent value="eligibility">
                <EligibilitySection
                  control={form.control}
                  canEdit={canEdit}
                  issues={isSubmitted ? ruleIssues : undefined}
                />
              </TabsContent>
              <TabsContent value="match">
                <MatchSection
                  event={draft}
                  canEdit={canEdit}
                  onChange={applyChange}
                />
              </TabsContent>
              <TabsContent value="reservations">
                <ReservationsSection
                  control={form.control}
                  tables={tables}
                  canEdit={canEdit}
                  freeze={reservationsFreeze}
                  nameIssues={isSubmitted ? reservationIssues : undefined}
                />
              </TabsContent>
              {/* Rendered only alongside its trigger, so the panel and the tab appear
                  and vanish together — Radix keeps no content for a tab that is not on
                  the list. Fed the DRAFT, so the structure recomputes as the director
                  edits the player limit on Basics or adds a reservation on Reservations. */}
              {hasDrawStructure && (
                <TabsContent value="draw-structure">
                  <DrawStructureSection
                    event={draft}
                    onGoToBasics={() => setSection('basics')}
                  />
                </TabsContent>
              )}
            </Tabs>
          </div>
        )}

        {/* The refusal, where the work is. An `Alert` rather than a toast on
            purpose: a toast is a portal that leaves in four seconds, and what it
            would be reporting here is that the sheet in front of you still holds
            unsaved work. It sits above the footer, next to the button that was
            just refused.

            Every word of it is ours (`saveFailureMessage`): a 422's `detail` is
            Pydantic's own prose ("String should have at most 255 characters") and
            never reaches this markup. */}
        {/* ⚠️ The inset is a PADDED WRAPPER, not `mx-6` on the Alert. `Alert` is
            `w-full` (`components/ui/alert.tsx`), and `width: 100%` plus a 24px margin
            either side is `100% + 48px` — so the banner ran 24px past the right-hand edge
            of the sheet at every width, phone and desktop alike. The one place a failure
            is reported is not a place that may itself be half off the screen. */}
        {failure && (
          <div className="px-6 pb-1">
            <Alert variant="destructive" data-testid="event-editor-error">
              <TriangleAlert size={16} />
              <AlertTitle>
                {isNew ? "Couldn't create this event" : "Couldn't save your changes"}
              </AlertTitle>
              <AlertDescription>
                {saveFailureMessage(failure, EVENT_SAVE_TARGET)} Nothing was saved
                — your changes are still here.
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* **A row above `sm`, a stack below it.** Three buttons in a `flex-row` that
            cannot wrap need ~390px, and on a 375px phone the last of them — "Save
            changes", the primary action, the whole reason the sheet is open — was CLIPPED
            at the right-hand edge (x=244..393). A CTA you cannot press is a form you
            cannot submit, and it hid behind `toBeVisible()` exactly as the rule row did.

            Stacked, they are full-width and in DOM order, so Save is the bottom one: the
            last thing read and the nearest thing to a thumb. The `flex-1` spacer that
            pushes Cancel/Save right is a *row* device, so it exists only in the row. */}
        <SheetFooter className="flex-col items-stretch gap-2 border-t border-[color:var(--border-subtle)] px-6 py-4 sm:flex-row sm:items-center">
          {canEdit && !isNew && draft && (
            <Button variant="destructive" onClick={() => onDelete(draft.id)}>
              <Trash2 size={16} />
              Delete event
            </Button>
          )}
          <span className="hidden sm:block sm:flex-1" />
          {/* A non-creator can only dismiss the read-only view. */}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {canEdit ? 'Cancel' : 'Done'}
          </Button>
          {canEdit && (
            // Disabled only while the save is in the air — never on validity
            // (`CLAUDE.md`, `## Forms`): pressing it is how the organizer finds out
            // what is wrong, and a dead button explains nothing.
            //
            // "In the air" is TWO facts, and one of them is not this component's to
            // know (see `saving` on the props): `isSubmitting` ends when the `onSave`
            // promise settles, while the mutation behind it stays pending through its
            // own success work. Five rapid clicks got five events through the gap
            // (#1231 QA). Both are asked, so it re-enables only once BOTH are done —
            // and a rejected save re-enables it, because both go false, which is what
            // lets the organizer retry the failure the `Alert` above is reporting.
            <Button disabled={!draft || isSubmitting || saving} onClick={submit}>
              <Check size={16} />
              {isNew ? 'Create event' : 'Save changes'}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
