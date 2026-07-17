import { CalendarClock } from 'lucide-react'

import { EmptyState } from '../../empty-state'

export interface BoardEmptyProps {
  /** Owner? The prompt tells the owner what to *do* (run the scheduler); a
   * viewer gets the fact, not the instruction (ADR-0015's copy rule). */
  canEdit: boolean
}

/**
 * The boards' designed "no placements yet" state (never an error): fixtures
 * exist, but nothing has a table **and** a time, so there is nothing to draw on
 * a time axis yet. The way out is the solver — the strip's Run-scheduler button
 * is already on screen right above this.
 */
export const BoardEmpty = ({ canEdit }: BoardEmptyProps) => (
  <div data-testid="schedule-board-empty">
    <EmptyState
      icon={<CalendarClock size={28} />}
      title="No matches placed yet"
      hint={
        canEdit
          ? 'Run the scheduler to place every match on a table — the board draws the plan it produces.'
          : 'The organizer has not placed any matches yet.'
      }
    />
  </div>
)
