import { type ReactNode, use } from 'react'
import { minutes, TimelineContext } from './TimelineContext.ts'

// One table's row of a Timeline: its name, then its ScheduleBlocks (placed with their start and
// length), as a group named after the table.
export function TimelineTrack({ name, children }: { name: string; children: ReactNode }) {
  const { length, now } = use(TimelineContext)
  return (
    <>
      <div className="fm-timeline__table">{name}</div>
      <div
        className="fm-timeline__track"
        role="group"
        aria-label={name}
        style={{ width: minutes(length) }}
      >
        {children}
        {now !== undefined && <span className="fm-timeline__now" style={{ left: minutes(now) }} />}
      </div>
    </>
  )
}
