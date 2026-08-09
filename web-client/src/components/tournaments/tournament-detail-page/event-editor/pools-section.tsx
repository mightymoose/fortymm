import { useId } from 'react'
import { type Control, useFieldArray, useWatch } from 'react-hook-form'
import { Lock, Plus, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import type { EditFreeze } from '../../data/draw'
import { findPoolConflicts } from '../../data/helpers'
import { addedPool, poolEntryKey } from '../../data/pool-entries'
import { poolNameAt } from '../../data/pool-reconciliation'
import type { PoolEntry, TournamentTable } from '../../data/types'
import { EmptyState } from '../../empty-state'
import type { EventFormValues } from '../event-form'
import { SectionHeader } from '../section-header'
import { PoolCard } from './pools-section/pool-card'

export interface PoolsSectionProps {
  /** The editor's React-Hook-Form control. The pool list is a `useFieldArray` on
   * this same form, so adding, editing and removing a pool is form state
   * validated by the one `eventSchema` on save (chore 1e). */
  control: Control<EventFormValues>
  /** The tables available to this tournament. */
  tables: TournamentTable[]
  /** When false (a non-creator), the pool *editor* becomes a pool *list*: each
   * pool reads back as its name, its window and its reserved tables, and every
   * mutating affordance is hidden (ADR 0015). */
  canEdit: boolean
  /** Whether the event's **set of pools** may still change (`poolSetFreeze`,
   * `data/draw`). Frozen once its draw is cut — see the component doc below. */
  freeze: EditFreeze
  /** What is wrong with each pool's **name**, keyed by `poolEntryKey`
   * (`poolNameIssues`, `data/event-validation`) — rendered in red under the box it is
   * about. The key is the server's id for a stored pool and the card key for one the
   * director has just added, which is the same thing the cards themselves are keyed on:
   * a pool with no id yet still has a name box, and it can still be emptied.
   *
   * `undefined` is *"do not say anything yet"*, and it is what the editor passes until
   * the organizer has actually pressed Save: a name box they are halfway through
   * re-typing is not yet wrong. The same shape, and the same reasoning, as
   * `EligibilitySection`'s `issues`. */
  nameIssues?: Record<string, string>
}

/**
 * The event editor's "Table pools" tab: each pool reserves a slice of tables for a
 * window, with a warning when tables are double-booked across overlapping pools.
 *
 * ## Once the draw is cut, the pool *set* freezes — and nothing else does
 *
 * A fixture names its pool by that pool's string `id` (ADR-0786), so adding or removing
 * a pool under a standing draw either orphans fixtures or produces a pool with none. The
 * server refuses it with a **409**; this section declines to *build* the change, and says
 * why, and says how to get out of it — because a director who is merely stopped is stuck,
 * and the way out (delete the draw, edit, cut it again) is the whole content of the
 * refusal.
 *
 * **Disabled with a visible reason, not hidden.** That is the opposite of the
 * owner/viewer split one prop over (`canEdit`), and deliberately so: a viewer's missing
 * button is *not their business* — nothing they could do would bring it back — whereas
 * this director's Add-pool button is one deleted draw away from working. Hiding it would
 * hide the way out along with the control. (ADR-0015 forbids the *unexplained* dead end;
 * a reason in text is what makes this one not that. It goes in text and not in a tooltip
 * because a `disabled` button is not focusable and holds no tooltip a screen reader will
 * ever read.)
 *
 * **What stays live is the point of the whole freeze**: a pool's name, its window, and
 * its tables are still editable with a draw standing (`PoolCard` renders them exactly as
 * before). Venues move under a running tournament — a table breaks and is pulled, one
 * frees up early — and a director who had to delete a *correct* draw to record that would
 * lose every placement to a broken table. A section that greyed itself out wholesale
 * would look tidy, pass a test that only checked Add and Remove, and break the one case
 * this freeze exists to permit.
 *
 * ## A pool is *called* something
 *
 * The name box being live is also the one way this editor can author a pool the server
 * refuses: a default name is **minted** (`addPool`) — the id is the server's, and this
 * editor authors none — but an emptied name box is a `min_length=1` 422 (`PoolWrite.name`,
 * `api/app/schemas/tournament.py`). So the rule is
 * mirrored client-side (`poolNameSchema`) and its verdict arrives here as `nameIssues`,
 * in red, under the box — and the save is refused in the form, which is what means
 * Pydantic's prose never reaches anybody.
 */
export const PoolsSection = ({
  control,
  tables,
  canEdit,
  freeze,
  nameIssues,
}: PoolsSectionProps) => {
  // The frozen notice is what both the Add button and every Remove button point at with
  // `aria-describedby`: one explanation, in one place, said once.
  const freezeNoticeId = useId()
  const frozen = freeze.kind === 'frozen'
  // `keyName: 'rhfKey'` keeps the field array's internal key off our own fields — and
  // the cards are NOT keyed on it, because `update()` regenerates it for the row it
  // touches, which would remount the card the director is typing in and drop their
  // cursor. They are keyed on `poolEntryKey` instead: the server's id for a stored pool,
  // the card key for one that has just been added.
  const { fields, append, remove, update } = useFieldArray({
    control,
    name: 'pools',
    keyName: 'rhfKey',
  })
  // A new pool defaults to the event's own window; watched so it tracks the
  // Basics slot as the organizer edits it.
  const eventSlot = useWatch({ control, name: 'slot' })
  // The event's timezone (ADR 20260719) — shown as a caption beside every pool
  // window. Watched, so changing it on the Basics tab relabels the pools live.
  const timezone = useWatch({ control, name: 'timezone' })

  // Clean domain entries (no `rhfKey`) for the conflict check and the cards, so an
  // edit never writes the field array's internal key back into form state. Rebuilt
  // per arm rather than spread, so an entry cannot pick up a field its arm does not
  // have — an `added` pool that grew an `id` would be the 422 this union exists to
  // prevent.
  //
  // NOT re-sorted here. The field array arrived in position order (`eventToFormValues`
  // seeds it that way) and its order is the director's, kept across every add and remove
  // — and it is the order a save puts on the wire, from which the server derives the
  // positions. Sorting the *render* while `update(i, …)` / `remove(i)` still addressed
  // the underlying array by index would edit the wrong card.
  const pools: PoolEntry[] = fields.map((f) =>
    f.kind === 'kept'
      ? { kind: 'kept', id: f.id, name: f.name, slot: f.slot, tableIds: f.tableIds }
      : { kind: 'added', key: f.key, name: f.name, slot: f.slot, tableIds: f.tableIds },
  )

  // Double-booking is a diagnostic only the organizer can act on, so a viewer
  // is neither shown it nor pays to compute it.
  const conflicts = canEdit ? findPoolConflicts(pools) : []
  // Count distinct tables, not conflict pairs: one table double-booked across
  // several overlapping pools yields multiple conflict entries.
  const conflictTableCount = new Set(conflicts.map((c) => c.table)).size

  // A pool the server has never seen: a default name, the event's window, no tables —
  // and, pointedly, **no id** (`addedPool`, `data/pool-entries`). The id is minted by the
  // server when this entry reaches it with none (ADR 20260801); an id authored here would
  // be a 422 naming this very entry, and before the ids moved server-side it was worse
  // than that — the client's id was accepted, so a name collision was a silent identity
  // swap.
  //
  // It joins at the END, which is where `append` puts it and where the server will
  // therefore position it: the array order is the pool order, and nothing else is.
  //
  // The name comes from `poolNameAt` — the ONE place a default pool name is minted, shared
  // with the Draw structure tab's pool-count reconciliation (`data/pool-reconciliation`),
  // because "continuing the letter sequence" is a promise about one sequence. This used to
  // spell the letter `String.fromCharCode(65 + n)` here, which prints `Pool [` for the 27th
  // pool — reachable now that a director can type a pool count of up to 512.
  const addPool = () =>
    append(
      addedPool({
        name: poolNameAt(fields.length),
        slot: { ...eventSlot },
        tableIds: [],
      }),
    )

  return (
    <div className="flex flex-col gap-4" data-testid="pools-section">
      <SectionHeader
        title="Table pools"
        subtitle="Each pool reserves a slice of tables for a window of time."
        action={
          canEdit && (
            <Button
              size="sm"
              onClick={addPool}
              disabled={frozen}
              aria-describedby={frozen ? freezeNoticeId : undefined}
            >
              <Plus size={14} />
              Add pool
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
        <Alert id={freezeNoticeId} data-testid="pools-frozen-notice">
          <Lock size={16} />
          <AlertTitle>This event’s draw is cut</AlertTitle>
          <AlertDescription>{freeze.reason}</AlertDescription>
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
        // moving a broken table's pool onto tables another pool already holds — an edit
        // the freeze deliberately still allows). A page object querying "the alert"
        // would throw on exactly that overlap.
        <Alert
          data-testid="pools-conflict-alert"
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
              .map((c) => `${c.table} (${c.poolA}↔${c.poolB})`)
              .join(' · ')}
          </AlertDescription>
        </Alert>
      )}

      {fields.length === 0 ? (
        // "No pools yet" is a to-do — it reads as a gap the organizer is meant
        // to close. A viewer is being told a fact about the event instead, and
        // is offered nothing to add.
        <EmptyState
          title={canEdit ? 'No pools yet' : 'No table pools'}
          hint={
            canEdit
              ? 'Add a pool to reserve tables for this event.'
              : 'No tables are reserved for this event.'
          }
          action={
            canEdit && (
              // Reachable: a draw whose fixtures belong to no pool (a knockout, #785)
              // leaves an event with fixtures and an empty pool list — and its pool set
              // is frozen like any other. The invitation is still shown, and still dead,
              // and the notice above it still says why.
              <Button
                onClick={addPool}
                disabled={frozen}
                aria-describedby={frozen ? freezeNoticeId : undefined}
              >
                <Plus size={16} />
                Add first pool
              </Button>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {pools.map((entry, i) => (
            <PoolCard
              // The server's id, or the card key of a pool it has never seen — never the
              // field array's `rhfKey`, which `update()` regenerates on the row being
              // edited (a remount mid-keystroke), and never the index, which renumbers
              // when a card above is removed.
              key={poolEntryKey(entry)}
              pool={entry}
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
              // now refuses a pool with no name (`min_length=1`). The card says so under
              // the box; the save never leaves the room.
              nameError={nameIssues?.[poolEntryKey(entry)]}
              // The card hands back a `PoolDraft` — the three fields it can edit — and
              // the entry's identity is re-attached HERE, from the entry that is already
              // in form state. That is what makes it structurally impossible for a card
              // to promote an added pool into a kept one (or the reverse): it never sees
              // the arm, so it cannot change it.
              onChange={(draft) => update(i, { ...entry, ...draft })}
              onRemove={() => remove(i)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
