import { useId } from 'react'

import type { GroupStandingsView } from '../../../../data/standings'
import { StandingsTable } from './standings-table'

export interface GroupStandingsTableProps {
  group: GroupStandingsView
}

/**
 * One **group's standings** (ADR-0788): the group's label over the table that ranks it.
 *
 * The table itself is `StandingsTable` — shared with the group-less swiss block, so the two
 * cannot drift on a column, an order or a sign. What this adds is the two things that are
 * about the *group*: the heading that names it, and the test hook that scopes it, so a card
 * showing several groups still names each one.
 */
export const GroupStandingsTable = ({ group }: GroupStandingsTableProps) => {
  const captionId = useId()

  return (
    <section
      data-testid={`group-standings-${group.groupId}`}
      aria-labelledby={captionId}
      className="rounded-[10px] border border-[color:var(--border-subtle)] p-3"
    >
      <h4
        id={captionId}
        className="text-[13px] font-semibold text-[color:var(--fg-1)]"
      >
        {group.label}
      </h4>

      {/* `format="group"` is the whole of what this table is not: a group gives every
          entrant the same opposition, so strength of schedule carries no information and
          there is no Buchholz column to show (ADR "swiss standings add Buchholz…"). */}
      <StandingsTable
        format="group"
        ariaLabel={`Standings for ${group.label}`}
        rows={group.rows}
        className="mt-2"
      />
    </section>
  )
}
