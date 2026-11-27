import { createContext } from 'react'

// What a Timeline tells its tracks: how many minutes it spans, and where now is (minutes from its
// start), if it is within them.
export interface TimelineValue {
  length: number
  now?: number
}

// A length on the timeline, as CSS: kit.css draws --ppm pixels per minute.
export function minutes(count: number) {
  return `calc(${count} * var(--ppm))`
}

export const TimelineContext = createContext<TimelineValue>({ length: 0 })
