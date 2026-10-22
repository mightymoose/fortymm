// A day on the calendar with no time and no time zone, as an ISO 8601
// `YYYY-MM-DD` string: the value of an `<input type="date">` and of an
// OpenAPI `format: date`. The day arithmetic below runs on UTC timestamps,
// which have no daylight saving time, and reads them back with the UTC
// getters, so a day never shifts across midnight or a clock change in the
// user's zone. Only localToday() reads the local clock.
export type PlainDate = string & { readonly __brand: 'PlainDate' }

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

const DAY_MS = 24 * 60 * 60 * 1000

function toUtc(date: PlainDate): Date {
  return new Date(`${date}T00:00:00Z`)
}

function fromUtc(utc: Date): PlainDate {
  return utc.toISOString().slice(0, 10) as PlainDate
}

// The day `day` of `month` (1 to 12) in `year`. Out-of-range days and
// months roll over, as Date.UTC does: plainDate(2026, 4, 31) is May 1.
export function plainDate(year: number, month: number, day: number): PlainDate {
  return fromUtc(new Date(Date.UTC(year, month - 1, day)))
}

// Today's date where the user is.
export function localToday(): PlainDate {
  const now = new Date()
  return plainDate(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

export function parts(date: PlainDate): {
  year: number
  month: number
  day: number
  weekday: number
} {
  const utc = toUtc(date)
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    weekday: utc.getUTCDay(),
  }
}

export function addDays(date: PlainDate, days: number): PlainDate {
  return fromUtc(new Date(toUtc(date).getTime() + days * DAY_MS))
}

// The same day `months` months away, or that month's last day if it's
// shorter: a month after January 31 is February 28 (or 29).
export function addMonths(date: PlainDate, months: number): PlainDate {
  const { year, month, day } = parts(date)
  const lastDay = parts(plainDate(year, month + months + 1, 0)).day
  return plainDate(year, month + months, Math.min(day, lastDay))
}

export function sameMonth(a: PlainDate, b: PlainDate): boolean {
  return a.slice(0, 7) === b.slice(0, 7)
}

// "April 12, 2026".
export function formatDate(date: PlainDate): string {
  const { year, month, day } = parts(date)
  return `${MONTHS[month - 1]} ${day}, ${year}`
}

// "April 2026".
export function formatMonth(date: PlainDate): string {
  const { year, month } = parts(date)
  return `${MONTHS[month - 1]} ${year}`
}

// The weeks, Sunday to Saturday, that hold the days of `date`'s month,
// with the days of the months before and after that fill them out.
export function monthWeeks(date: PlainDate): PlainDate[][] {
  const { year, month } = parts(date)
  const first = plainDate(year, month, 1)
  const last = plainDate(year, month + 1, 0)
  const weeks: PlainDate[][] = []
  let day = addDays(first, -parts(first).weekday)
  while (day <= last) {
    const week: PlainDate[] = []
    for (let i = 0; i < 7; i++) {
      week.push(day)
      day = addDays(day, 1)
    }
    weeks.push(week)
  }
  return weeks
}
