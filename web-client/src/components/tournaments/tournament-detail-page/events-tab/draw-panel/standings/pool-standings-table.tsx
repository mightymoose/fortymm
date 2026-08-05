import { useId } from 'react'

import type { PoolStandingsView } from '../../../../data/standings'
import { StandingsTable } from './standings-table'

export interface PoolStandingsTableProps {
  pool: PoolStandingsView
}

/**
 * One **pool's standings** (ADR-0788): the pool's name over the table that ranks it.
 *
 * The table itself is `StandingsTable` — shared with the pool-less swiss block, so the two
 * cannot drift on a column, an order or a sign. What this adds is the two things that are
 * about the *pool*: the heading that names it, and the test hook that scopes it, so a card
 * showing several pools still names each one.
 */
export const PoolStandingsTable = ({ pool }: PoolStandingsTableProps) => {
  const captionId = useId()

  return (
    <section
      data-testid={`pool-standings-${pool.poolId}`}
      aria-labelledby={captionId}
      className="rounded-[10px] border border-[color:var(--border-subtle)] p-3"
    >
      <h4
        id={captionId}
        className="text-[13px] font-semibold text-[color:var(--fg-1)]"
      >
        {pool.name}
      </h4>

      <StandingsTable
        ariaLabel={`Standings for ${pool.name}`}
        rows={pool.rows}
        className="mt-2"
      />
    </section>
  )
}
