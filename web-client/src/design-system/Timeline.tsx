import { type ReactNode } from 'react'
import { minutes, TimelineContext } from './TimelineContext.ts'

export interface TimelineMark {
  // Minutes from the timeline's start.
  at: number
  // The time as the user reads it, e.g. "11:00" (format it in the user's locale).
  label: string
}

// A schedule timeline (fm-timeline): a ruler of times over one TimelineTrack per table, `length`
// minutes wide. `now`, if given, is marked on the ruler and drawn as a line across every track.
// Times are minutes from the timeline's start; their labels are the caller's, in the user's locale.
export function Timeline({
  label,
  length,
  marks,
  now,
  children,
}: {
  label: string
  length: number
  marks: TimelineMark[]
  now?: TimelineMark
  children: ReactNode
}) {
  return (
    <TimelineContext value={{ length, now: now?.at }}>
      <div className="fm-timeline" role="group" aria-label={label}>
        <span aria-hidden="true"></span>
        <div className="fm-timeline__ruler" aria-hidden="true" style={{ width: minutes(length) }}>
          {marks.map((mark) => (
            <span key={mark.at} style={{ left: minutes(mark.at) }}>
              {mark.label}
            </span>
          ))}
          {now && (
            <span className="now" style={{ left: minutes(now.at) }}>
              {now.label}
            </span>
          )}
        </div>
        {children}
      </div>
    </TimelineContext>
  )
}
