import { format, formatDistanceToNowStrict } from 'date-fns'

const TZ_DESIGNATOR_RE = /(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * The API emits UTC timestamps, but some arrive without an explicit zone
 * designator — `new Date()` then parses them in the browser's local zone,
 * which drifts "just now" hours into the past or future. Treat a
 * designator-less datetime as UTC.
 */
export function parseApiDate(iso: string): Date {
  const needsUtc = iso.includes('T') && !TZ_DESIGNATOR_RE.test(iso)
  return new Date(needsUtc ? `${iso}Z` : iso)
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return format(parseApiDate(iso), 'MMM d, yyyy')
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return '—'
  return format(parseApiDate(iso), 'MMM d')
}

export function fmtDateRel(iso: string | null | undefined): string {
  if (!iso) return '—'
  return formatDistanceToNowStrict(parseApiDate(iso), { addSuffix: true })
}

/** Full weekday, month and day for a header — e.g. "Tuesday, April 22". */
export function fmtLongDate(date: Date = new Date()): string {
  return format(date, 'EEEE, MMMM d')
}
