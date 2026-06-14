import { Plus, TriangleAlert } from 'lucide-react'

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
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-[6px] border border-[color:rgba(255,196,61,0.3)] bg-[color:rgba(255,196,61,0.1)] px-3.5 py-2.5"
        >
          <TriangleAlert
            size={16}
            className="mt-0.5 text-[color:var(--warn)]"
          />
          <div className="text-[13px] text-[color:var(--fg-2)]">
            <div className="font-semibold text-[color:var(--warn)]">
              {conflicts.length}{' '}
              {conflicts.length === 1 ? 'table is' : 'tables are'} double-booked
              within this event
            </div>
            <div className="mt-0.5 text-[11px] text-[color:var(--fg-3)]">
              {conflicts
                .map((c) => `${c.table} (${c.poolA}↔${c.poolB})`)
                .join(' · ')}
            </div>
          </div>
        </div>
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
