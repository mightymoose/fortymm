import { useId } from 'react'
import { type Control, useFieldArray, useFormState, useWatch } from 'react-hook-form'
import { Lock, Plus, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import type { EditFreeze } from '../../data/draw'
import { findReservationConflicts } from '../../data/helpers'
import { addedReservation, reservationEntryKey } from '../../data/reservation-entries'
import type { ReservationEntry, TournamentTable } from '../../data/types'
import { EmptyState } from '../../empty-state'
import { type EventFormValues, isOverReservationCap } from '../event-form'
import { SectionHeader } from '../section-header'
import { ReservationCard } from './reservations-section/reservation-card'

export interface ReservationsSectionProps {
  /** The editor's React-Hook-Form control. The reservation list is a `useFieldArray` on
   * this same form, so adding, editing and removing a reservation is form state
   * validated by the one `eventSchema` on save (chore 1e). */
  control: Control<EventFormValues>
  /** The tables available to this tournament. */
  tables: TournamentTable[]
  /** When false (a non-creator), the reservation *editor* becomes a reservation *list*:
   * each reservation reads back as its name, its window and its reserved tables, and
   * every mutating affordance is hidden (ADR 0015). */
  canEdit: boolean
  /** Whether the event's **set of groups** may still change (`groupSetFreeze`,
   * `data/draw`) — asked of the reservations, since a group is minted 1:1 with one
   * (ticket #1369) and adding/removing/reordering a reservation does the same to its
   * mapped group. Frozen once its draw is cut — see the component doc below. */
  freeze: EditFreeze
  /** What is wrong with each reservation's **name**, keyed by `reservationEntryKey`
   * (`reservationNameIssues`, `data/event-validation`) — rendered in red under the box
   * it is about. The key is the server's id for a stored reservation and the card key
   * for one the director has just added, which is the same thing the cards themselves
   * are keyed on: a reservation with no id yet still has a name box, and it can still be
   * emptied.
   *
   * `undefined` is *"do not say anything yet"*, and it is what the editor passes until
   * the organizer has actually pressed Save: a name box they are halfway through
   * re-typing is not yet wrong. The same shape, and the same reasoning, as
   * `EligibilitySection`'s `issues`. */
  nameIssues?: Record<string, string>
}

/**
 * The event editor's "Reservations" tab: each reservation books a slice of tables for a
 * window of time, with a warning when tables are double-booked across overlapping
 * reservations.
 *
 * ## Once the draw is cut, the group *set* freezes — and nothing about a reservation does
 *
 * A fixture names its group by that group's string `id` (ADR-0786), and a group is
 * minted 1:1 with a reservation (ticket #1369) — so adding or removing a reservation
 * under a standing draw either orphans fixtures or produces a group with none. The
 * server refuses it with a **409**; this section declines to *build* the change, and
 * says why, and says how to get out of it — because a director who is merely stopped is
 * stuck, and the way out (delete the draw, edit, cut it again) is the whole content of
 * the refusal.
 *
 * **Disabled with a visible reason, not hidden.** That is the opposite of the
 * owner/viewer split one prop over (`canEdit`), and deliberately so: a viewer's missing
 * button is *not their business* — nothing they could do would bring it back — whereas
 * this director's Add-reservation button is one deleted draw away from working. Hiding
 * it would hide the way out along with the control. (ADR-0015 forbids the *unexplained*
 * dead end; a reason in text is what makes this one not that. It goes in text and not in
 * a tooltip because a `disabled` button is not focusable and holds no tooltip a screen
 * reader will ever read.)
 *
 * **What stays live is the point of the whole freeze**: a reservation's name, its
 * window, and its tables are still editable with a draw standing (`ReservationCard`
 * renders them exactly as before). Venues move under a running tournament — a table
 * breaks and is pulled, one frees up early — and a director who had to delete a
 * *correct* draw to record that would lose every placement to a broken table. A section
 * that greyed itself out wholesale would look tidy, pass a test that only checked Add
 * and Remove, and break the one case this freeze exists to permit.
 *
 * ## A reservation is *called* something
 *
 * The name box being live is also the one way this editor can author a reservation the
 * server refuses: a default name is **minted** (`addReservation`) — the id is the
 * server's, and this editor authors none — but an emptied name box is a `min_length=1`
 * 422 (`ReservationWrite.name`, `api/app/schemas/tournament.py`). So the rule is
 * mirrored client-side (`reservationNameSchema`) and its verdict arrives here as
 * `nameIssues`, in red, under the box — and the save is refused in the form, which is
 * what means Pydantic's prose never reaches anybody.
 */
export const ReservationsSection = ({
  control,
  tables,
  canEdit,
  freeze,
  nameIssues,
}: ReservationsSectionProps) => {
  // The frozen notice is what both the Add button and every Remove button point at with
  // `aria-describedby`: one explanation, in one place, said once.
  const freezeNoticeId = useId()
  const frozen = freeze.kind === 'frozen'
  // #1482's reservation cap: a non-`rr-then-ko` event holds at most one reservation, so
  // once it already holds one, Add would build a second — dead data no fixture could
  // ever be dealt into (ADR 20260808: only `rr-then-ko` has structural settings, so
  // every other draw type runs one group per stage). Read off the FORM's watched
  // `drawType`, never `event.drawType`, so a director who flips the type on Basics sees
  // Add disable before anything is saved. Gated on `!frozen`: once the draw is cut, the
  // freeze already disables Add for its own (more actionable) reason, and showing this
  // notice too would be a second, less useful story about the same dead button.
  const capNoticeId = useId()
  // `keyName: 'rhfKey'` keeps the field array's internal key off our own fields — and
  // the cards are NOT keyed on it, because `update()` regenerates it for the row it
  // touches, which would remount the card the director is typing in and drop their
  // cursor. They are keyed on `reservationEntryKey` instead: the server's id for a
  // stored reservation, the card key for one that has just been added.
  const { fields, append, remove, update } = useFieldArray({
    control,
    name: 'reservations',
    keyName: 'rhfKey',
  })
  // A new reservation defaults to the event's own window; watched so it tracks the
  // Basics slot as the organizer edits it.
  const eventSlot = useWatch({ control, name: 'slot' })
  // The event's timezone (ADR 20260719) — shown as a caption beside every reservation
  // window. Watched, so changing it on the Basics tab relabels the reservations live.
  const timezone = useWatch({ control, name: 'timezone' })

  // Clean domain entries (no `rhfKey`) for the conflict check and the cards, so an
  // edit never writes the field array's internal key back into form state. Rebuilt
  // per arm rather than spread, so an entry cannot pick up a field its arm does not
  // have — an `added` reservation that grew an `id` would be the 422 this union exists
  // to prevent.
  //
  // NOT re-sorted here. The field array arrived in position order (`eventToFormValues`
  // seeds it that way) and its order is the director's, kept across every add and remove
  // — and it is the order a save puts on the wire, from which the server derives the
  // positions (and, through them, every mapped group's position too). Sorting the
  // *render* while `update(i, …)` / `remove(i)` still addressed the underlying array by
  // index would edit the wrong card.
  const reservations: ReservationEntry[] = fields.map((f) =>
    f.kind === 'kept'
      ? { kind: 'kept', id: f.id, name: f.name, slot: f.slot, tableIds: f.tableIds }
      : { kind: 'added', key: f.key, name: f.name, slot: f.slot, tableIds: f.tableIds },
  )

  // Watched off the form, not read from the saved `event` — a director's in-progress
  // (unsaved) draw-type pick has to disable Add immediately, before a save round-trips
  // it back as `event.drawType`.
  const drawType = useWatch({ control, name: 'drawType' })

  // The array-level save refusal (`eventSchema`'s `superRefine`, `event-form.ts`). RHF
  // nests an array-level custom issue under `.root` once a PER-ROW error joins it (a
  // blank name alongside the cap), and leaves it as the array's own `.message` when the
  // cap is the only reservations error — read both, so neither shape goes silently blank.
  //
  // **Gated on the live watched pair, because RHF's error object goes STALE here.** The
  // refusal is raised at the ARRAY's path but its condition reads `drawType`, a
  // DIFFERENT field, and RHF revalidates the field that changed, never a sibling. So a
  // director who takes this very message's second remedy ("switch the draw type to
  // rr-then-ko") watches Add re-enable beside a red alert still insisting the draw type
  // is not rr-then-ko. The sentence is false at the moment it is on screen, and it is
  // false precisely because the director did what it asked.
  //
  // Re-deriving the condition costs nothing and cannot go stale: `drawType` is already
  // watched above and `fields` is the live array. The `superRefine` itself STAYS — it is
  // what refuses the save, and `firstInvalidSection` reads `errors.reservations` to jump
  // to this tab. This gate only decides whether the sentence is still TRUE.
  //
  // The predicate is IMPORTED, never restated here: the `superRefine` calls the same
  // `isOverReservationCap`, so "the display gate is exactly the resolver's condition" is
  // a fact about the code rather than a promise made in a comment. A second hand-written
  // copy is how one of them gets fixed and the other does not.
  const { errors } = useFormState({ control })
  const overCap = isOverReservationCap(drawType, fields.length)
  const capError = overCap
    ? (errors.reservations?.root?.message ?? errors.reservations?.message)
    : undefined

  const capped = !frozen && drawType !== 'rr-then-ko' && fields.length >= 1

  // Whether the button is DEAD and whether this notice EXPLAINS it are two questions,
  // and they must not share one flag: `capped` disables Add from the first reservation
  // (`length >= 1`), while the save refusal only exists past the second (`length > 1`),
  // so folding the two together would re-enable Add at two reservations — letting the
  // director add a third from the very screen that just refused to save two.
  //
  // Which leaves only the notice to suppress, and for the same reason it is suppressed
  // once the draw is cut: when the SAVE refusal below is on screen, this notice is a
  // second, weaker story about the very same rule — the error names the count actually
  // held AND the way down to one, so stacking a `Lock` alert reading "can hold only one
  // reservation" directly above a destructive one reading "it currently holds 2" tells
  // the director nothing new and buries the sentence that does. One dead button, one
  // explanation, said once.
  const showCapNotice = capped && !capError

  // Double-booking is a diagnostic only the organizer can act on, so a viewer
  // is neither shown it nor pays to compute it.
  const conflicts = canEdit ? findReservationConflicts(reservations) : []
  // Count distinct tables, not conflict pairs: one table double-booked across
  // several overlapping reservations yields multiple conflict entries.
  const conflictTableCount = new Set(conflicts.map((c) => c.table)).size

  // A reservation the server has never seen: a default name, the event's window, no
  // tables — and, pointedly, **no id** (`addedReservation`, `data/reservation-entries`).
  // The id is minted by the server when this entry reaches it with none (ADR 20260801);
  // an id authored here would be a 422 naming this very entry, and before the ids moved
  // server-side it was worse than that — the client's id was accepted, so a name
  // collision was a silent identity swap.
  //
  // It joins at the END, which is where `append` puts it and where the server will
  // therefore position it: the array order is the reservation order (and the mapped
  // group order with it), and nothing else is.
  const addReservation = () =>
    append(
      addedReservation({
        name: `Reservation ${String.fromCharCode(65 + fields.length)}`,
        slot: { ...eventSlot },
        tableIds: [],
      }),
    )

  return (
    <div className="flex flex-col gap-4" data-testid="reservations-section">
      <SectionHeader
        title="Reservations"
        subtitle="Each reservation books a slice of tables for a window of time."
        action={
          canEdit && (
            <Button
              size="sm"
              onClick={addReservation}
              disabled={frozen || capped}
              aria-describedby={
                frozen ? freezeNoticeId : showCapNotice ? capNoticeId : undefined
              }
            >
              <Plus size={14} />
              Add reservation
            </Button>
          )
        }
      />

      {/* Why the two identity affordances are dead, and how to bring them back — the
          director's, so a viewer (who has no Add button and no way to delete a draw)
          is never shown it. An `Alert` because this is the app talking back about the
          state of the thing in front of them; not `destructive`, because nothing has
          gone wrong: a cut draw is the *correct* state of an event that is about to be
          played. Both the Add button and every Remove button `aria-describedby` it, so
          a screen reader reaching a disabled control is told the same sentence a sighted
          director reads above it. */}
      {canEdit && freeze.kind === 'frozen' && (
        <Alert id={freezeNoticeId} data-testid="reservations-frozen-notice">
          <Lock size={16} />
          <AlertTitle>This event’s draw is cut</AlertTitle>
          <AlertDescription>{freeze.reason}</AlertDescription>
        </Alert>
      )}

      {/* #1482's cap notice: why ADD is disabled once a non-`rr-then-ko` event already
          holds one reservation. Its own testid and its own `id` — never
          `freezeNoticeId`, whose sentence is about a cut draw and would be a lie here.
          Never shown alongside EITHER of the other two (`showCapNotice` is already
          `capped && !capError`, and `capped` is already `!frozen`): the freeze is the
          more actionable refusal once a draw is cut, the save error names the count
          held and the way down to one, and two alerts explaining the same dead button
          would be a worse answer than one. The BUTTON stays disabled either way — only
          this notice steps aside. */}
      {canEdit && showCapNotice && (
        <Alert id={capNoticeId} data-testid="reservations-cap-notice">
          <Lock size={16} />
          <AlertTitle>This event can hold only one reservation</AlertTitle>
          <AlertDescription>
            A draw type other than “rr-then-ko” runs its whole stage as one group, so
            this event can hold only one reservation. Switch the draw type to
            “rr-then-ko” on the Basics tab to use more than one.
          </AlertDescription>
        </Alert>
      )}

      {/* #1482's array-level SAVE refusal: a non-`rr-then-ko` event that would be left
          holding more than one reservation. Independent of the freeze/cap notices
          above (which are about the ADD button) — this is the resolver's own verdict on
          the reservations LIST, and it has to be visible whether or not the draw is
          cut: a cut round-robin event holding two legacy reservations still refuses the
          save (re-sending both unchanged passes the freeze and then hits this cap), and
          the director still needs to be told why. */}
      {canEdit && capError && (
        <Alert variant="destructive" data-testid="reservations-cap-error">
          <TriangleAlert size={16} />
          <AlertTitle>Too many reservations</AlertTitle>
          <AlertDescription>{capError}</AlertDescription>
        </Alert>
      )}

      {/* A double-booking is a flaw in the *configuration*, and only the
          organizer can fix it. To a reader it is an unactionable warning about
          someone else's tournament — noise, not information — so they are not
          shown it. (It is non-interactive, so this is a copy/UX call, not a
          control leak: the guard sweep passes either way.) */}
      {canEdit && conflicts.length > 0 && (
        // Addressed by a testid, not by `role="alert"`: the freeze notice above is an
        // `Alert` too, and an event can be both frozen and double-booked (a director
        // moving a broken table's reservation onto tables another reservation already
        // holds — an edit the freeze deliberately still allows). A page object querying
        // "the alert" would throw on exactly that overlap.
        <Alert
          data-testid="reservations-conflict-alert"
          className="border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10"
        >
          <TriangleAlert className="text-[color:var(--warn)]" />
          <AlertTitle className="text-[color:var(--warn)]">
            {conflictTableCount}{' '}
            {conflictTableCount === 1 ? 'table is' : 'tables are'} double-booked
            within this event
          </AlertTitle>
          <AlertDescription className="text-[11px] text-[color:var(--fg-3)]">
            {conflicts
              .map((c) => `${c.table} (${c.reservationA}↔${c.reservationB})`)
              .join(' · ')}
          </AlertDescription>
        </Alert>
      )}

      {fields.length === 0 ? (
        // "No reservations yet" is a to-do — it reads as a gap the organizer is meant
        // to close. A viewer is being told a fact about the event instead, and
        // is offered nothing to add.
        <EmptyState
          title={canEdit ? 'No reservations yet' : 'No reservations'}
          hint={
            canEdit
              ? 'Add a reservation to reserve tables for this event.'
              : 'No tables are reserved for this event.'
          }
          action={
            canEdit && (
              // Reachable: a draw whose fixtures belong to no group (a knockout, #785)
              // leaves an event with fixtures and an empty reservation list — and its
              // group set is frozen like any other. The invitation is still shown, and
              // still dead, and the notice above it still says why.
              <Button
                onClick={addReservation}
                disabled={frozen}
                aria-describedby={frozen ? freezeNoticeId : undefined}
              >
                <Plus size={16} />
                Add first reservation
              </Button>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {reservations.map((entry, i) => (
            <ReservationCard
              // The server's id, or the card key of a reservation it has never seen —
              // never the field array's `rhfKey`, which `update()` regenerates on the
              // row being edited (a remount mid-keystroke), and never the index, which
              // renumbers when a card above is removed.
              key={reservationEntryKey(entry)}
              reservation={entry}
              tables={tables}
              timezone={timezone ?? ''}
              canEdit={canEdit}
              // ONLY the removal freezes. The card's name box, its window and its table
              // chips stay live under a cut draw — that is the case the freeze exists to
              // permit, not an oversight (see the component doc).
              removal={
                frozen
                  ? { kind: 'frozen', reasonId: freezeNoticeId }
                  : { kind: 'allowed' }
              }
              // The one thing on this card the organizer can *clear* — and the server
              // now refuses a reservation with no name (`min_length=1`). The card says
              // so under the box; the save never leaves the room.
              nameError={nameIssues?.[reservationEntryKey(entry)]}
              // The card hands back a `ReservationDraft` — the three fields it can edit
              // — and the entry's identity is re-attached HERE, from the entry that is
              // already in form state. That is what makes it structurally impossible for
              // a card to promote an added reservation into a kept one (or the reverse):
              // it never sees the arm, so it cannot change it.
              onChange={(draft) => update(i, { ...entry, ...draft })}
              onRemove={() => remove(i)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
