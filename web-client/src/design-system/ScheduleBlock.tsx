import { type CSSProperties, type ReactNode } from 'react'
import { ToggleButton } from 'react-aria-components'
import { minutes } from './TimelineContext.ts'

export type ScheduleBlockState = 'final' | 'live' | 'upcoming' | 'conflict' | 'offline' | 'free'

// The gap kit.css's blocks leave between neighbours on a track.
const gap = 6

// A schedule block (fm-slot): one match on a table's schedule, or a free gap between matches.
//
// - Its status line comes from its state: "Final" and the score, "Live", "Needs decision",
//   "Scorer offline", "Free". An upcoming match has none, unless a player is resting before it
//   (`rest`: "Lindqvist rests to 12:10").
// - `names` are the players' short names, drawn one per line; `time` its time.
// - `description` is what it is read as, after its status: who plays, where and when, e.g.
//   "Chen, Wei vs Ali, Rashid · Table 1 · 12:00–12:35". The drawn names and time are hidden from
//   assistive technology, which reads the description instead.
// - A match is a toggle button that selects it (isSelected, onSelectedChange); a free gap is not.
// - On a TimelineTrack, `start` and `length` place it, in minutes from the timeline's start.
export function ScheduleBlock({
  state,
  score,
  rest,
  names,
  time,
  description,
  isSelected = false,
  onSelectedChange,
  start,
  length,
}: {
  state: ScheduleBlockState
  score?: string
  rest?: { player: string; until: string }
  names?: [string, string]
  time: string
  description?: string
  isSelected?: boolean
  onSelectedChange?: (isSelected: boolean) => void
  start?: number
  length?: number
}) {
  const style: CSSProperties | undefined =
    start === undefined || length === undefined
      ? undefined
      : { left: minutes(start), width: `calc(${length} * var(--ppm) - ${gap}px)` }
  if (state === 'free') {
    return (
      <div className="fm-slot" data-state="free" style={style}>
        <span className="fm-slot__status">Free</span>
        <span className="fm-slot__time">{time}</span>
      </div>
    )
  }
  return (
    <ToggleButton
      className="fm-slot"
      data-state={state}
      isSelected={isSelected}
      onChange={onSelectedChange}
      style={style}
    >
      <Status state={state} score={score} rest={rest} />
      {names && (
        <span className="fm-slot__names" aria-hidden="true">
          <span>{names[0]}</span>
          <span>{names[1]}</span>
        </span>
      )}
      <span className="fm-slot__time" aria-hidden="true">
        {time}
      </span>
      {description && <span className="fm-sr">{description}</span>}
    </ToggleButton>
  )
}

function Status({
  state,
  score,
  rest,
}: {
  state: Exclude<ScheduleBlockState, 'free'>
  score?: string
  rest?: { player: string; until: string }
}): ReactNode {
  switch (state) {
    case 'final':
      return (
        <span className="fm-slot__status">
          Final <span className="num">{score}</span>
        </span>
      )
    case 'live':
      return <span className="fm-slot__status live-marker">Live</span>
    case 'conflict':
      return <span className="fm-slot__status">Needs decision</span>
    case 'offline':
      return <span className="fm-slot__status">Scorer offline</span>
    case 'upcoming':
      return (
        rest && (
          <span className="fm-slot__status rest">
            {rest.player} rests to <span className="num">{rest.until}</span>
          </span>
        )
      )
  }
}
