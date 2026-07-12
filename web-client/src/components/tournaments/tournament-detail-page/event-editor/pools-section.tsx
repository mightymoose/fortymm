import { type Control, useFieldArray, useWatch } from 'react-hook-form'
import { Plus, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import { findPoolConflicts, genId } from '../../data/helpers'
import type { Pool, TournamentTable } from '../../data/types'
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
}

/** The event editor's "Table pools" tab: each pool reserves a slice of tables
 * for a window, with a warning when tables are double-booked across overlapping
 * pools. */
export const PoolsSection = ({
  control,
  tables,
  canEdit,
}: PoolsSectionProps) => {
  // `keyName: 'rhfKey'` keeps the field array's internal key off our domain
  // `id`, so a card is keyed on the stable `id` and an in-place `update`
  // re-renders it rather than remounting it (which would drop input focus).
  const { fields, append, remove, update } = useFieldArray({
    control,
    name: 'pools',
    keyName: 'rhfKey',
  })
  // A new pool defaults to the event's own window; watched so it tracks the
  // Basics slot as the organizer edits it.
  const eventSlot = useWatch({ control, name: 'slot' })

  // Clean domain pools (no `rhfKey`) for the conflict check and the cards, so an
  // edit never writes the field array's internal key back into form state.
  const pools: Pool[] = fields.map((f) => ({
    id: f.id,
    name: f.name,
    slot: f.slot,
    tableIds: f.tableIds,
  }))

  // Double-booking is a diagnostic only the organizer can act on, so a viewer
  // is neither shown it nor pays to compute it.
  const conflicts = canEdit ? findPoolConflicts(pools) : []
  // Count distinct tables, not conflict pairs: one table double-booked across
  // several overlapping pools yields multiple conflict entries.
  const conflictTableCount = new Set(conflicts.map((c) => c.table)).size

  const addPool = () =>
    append({
      id: genId('p'),
      name: `Pool ${String.fromCharCode(65 + fields.length)}`,
      slot: { ...eventSlot },
      tableIds: [],
    })

  return (
    <div className="flex flex-col gap-4" data-testid="pools-section">
      <SectionHeader
        title="Table pools"
        subtitle="Each pool reserves a slice of tables for a window of time."
        action={
          canEdit && (
            <Button size="sm" onClick={addPool}>
              <Plus size={14} />
              Add pool
            </Button>
          )
        }
      />

      {/* A double-booking is a flaw in the *configuration*, and only the
          organizer can fix it. To a reader it is an unactionable warning about
          someone else's tournament — noise, not information — so they are not
          shown it. (It is non-interactive, so this is a copy/UX call, not a
          control leak: the guard sweep passes either way.) */}
      {canEdit && conflicts.length > 0 && (
        <Alert className="border-[color:var(--warn)]/40 bg-[color:var(--warn)]/10">
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
              <Button onClick={addPool}>
                <Plus size={16} />
                Add first pool
              </Button>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {fields.map((field, i) => (
            <PoolCard
              key={field.id}
              pool={pools[i]}
              tables={tables}
              canEdit={canEdit}
              onChange={(np) => update(i, np)}
              onRemove={() => remove(i)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
