import { Plus, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import { findPoolConflicts, genId } from '../../data/helpers'
import type { Pool, TournamentEvent, TournamentTable } from '../../data/types'
import { EmptyState } from '../../empty-state'
import { SectionHeader } from '../section-header'
import { PoolCard } from './pools-section/pool-card'

export interface PoolsSectionProps {
  event: TournamentEvent
  /** The tables available to this tournament. */
  tables: TournamentTable[]
  onChange: (next: TournamentEvent) => void
}

/** The event editor's "Table pools" tab: each pool reserves a slice of tables
 * for a window, with a warning when tables are double-booked across overlapping
 * pools. */
export const PoolsSection = ({ event, tables, onChange }: PoolsSectionProps) => {
  const pools = event.pools
  const setPools = (next: Pool[]) => onChange({ ...event, pools: next })
  const conflicts = findPoolConflicts(pools)
  // Count distinct tables, not conflict pairs: one table double-booked across
  // several overlapping pools yields multiple conflict entries.
  const conflictTableCount = new Set(conflicts.map((c) => c.table)).size

  const addPool = () =>
    setPools([
      ...pools,
      {
        id: genId('p'),
        name: `Pool ${String.fromCharCode(65 + pools.length)}`,
        slot: { ...event.slot },
        tableIds: [],
      },
    ])

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Table pools"
        subtitle="Each pool reserves a slice of tables for a window of time."
        action={
          <Button size="sm" onClick={addPool}>
            <Plus size={14} />
            Add pool
          </Button>
        }
      />

      {conflicts.length > 0 && (
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

      {pools.length === 0 ? (
        <EmptyState
          title="No pools yet"
          hint="Add a pool to reserve tables for this event."
          action={
            <Button onClick={addPool}>
              <Plus size={16} />
              Add first pool
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {pools.map((p, i) => (
            <PoolCard
              key={p.id}
              pool={p}
              tables={tables}
              onChange={(np) => setPools(pools.map((x, j) => (j === i ? np : x)))}
              onRemove={() => setPools(pools.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}
    </div>
  )
}
