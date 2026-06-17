import { parseApiDate } from '@/lib/dates'

/**
 * Format an ISO timestamp as a compact, scoreboard-style relative label —
 * "now", "2m", "1h", "Yesterday", "3d", "2w", then a short date. Matches the
 * design's feed timestamps. Pure: pass `now` to keep it testable.
 *
 * Parses via `parseApiDate` so a zone-less API timestamp is read as UTC rather
 * than drifting to local time.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = parseApiDate(iso)
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000)

  // Clock skew (a timestamp slightly in the future) still reads as "now".
  if (seconds < 45) return 'now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d`

  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`

  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
