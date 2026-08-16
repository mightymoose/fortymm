import { useId } from 'react'
import { Overline } from '@/components/overline'
import type { TournamentPathRowView } from '../tournament-panel-view'
import { TournamentPathRow } from './tournament-path-list/tournament-path-row'

export interface TournamentPathListProps {
  /** `Your matches` — what this event calls the viewer's own run through it. */
  heading: string
  /** `Group A · 4 players`, or null for an ungrouped draw. */
  subheading: string | null
  rows: TournamentPathRowView[]
}

/**
 * The viewer's own schedule within one tournament event, in draw order.
 *
 * Renders nothing at all when there are no rows: an event whose draw has not
 * been cut has no schedule yet, and a heading over an empty list would read as
 * "you have no matches" rather than "the draw is not made".
 */
export const TournamentPathList = ({
  heading,
  subheading,
  rows,
}: TournamentPathListProps) => {
  const headingId = useId()
  if (rows.length === 0) return null
  return (
    <section aria-labelledby={headingId} data-testid="tournament-panel-path">
      <Overline as="h4" id={headingId} className="mb-1 text-[10px]">
        {heading}
      </Overline>
      {subheading !== null && (
        <p className="mb-3 font-mono text-[12px] text-[color:var(--fg-3)]">
          {subheading}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <TournamentPathRow key={row.key} row={row} />
        ))}
      </ul>
    </section>
  )
}
