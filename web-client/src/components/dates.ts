// Calendar dates as the date picker handles them: local dates with no time,
// written as ISO strings such as "2026-04-11" in config and state.
export type IsoDate = string

export const MONTHS = [
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

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function isoDate(date: Date): IsoDate {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

// Built from its parts, because `new Date("2026-04-11")` is midnight UTC,
// which is the day before in a timezone west of Greenwich.
export function dateFromIso(iso: IsoDate): Date {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(year, month - 1, day)
}

// The date in full, e.g. "Saturday 11 April 2026".
export function longDate(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

// Reads a typed date: "11 April 2026", "Sat 11 Apr", "April 11 2026",
// "11/4/2026" (day first), "11.4.26" or "2026-04-11". With no year it takes
// `fallbackYear`. Returns null unless it's a real date, so "31/2/2026" is
// null.
export function parseDate(text: string, fallbackYear: number): Date | null {
  const words = text
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/g, ' ')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .trim()
  let year: number
  let month: number
  let day: number
  let match: RegExpMatchArray | null
  if ((match = words.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    year = Number(match[1])
    month = Number(match[2])
    day = Number(match[3])
  } else if ((match = words.match(/^(\d{1,2})[/.\-\s](\d{1,2})(?:[/.\-\s](\d{2,4}))?$/))) {
    day = Number(match[1])
    month = Number(match[2])
    year = match[3] ? Number(match[3]) : fallbackYear
  } else {
    const monthIndex = MONTHS.findIndex((name) =>
      new RegExp(`\\b${name.slice(0, 3).toLowerCase()}[a-z]*\\b`).test(words),
    )
    if (monthIndex < 0) return null
    month = monthIndex + 1
    const numbers = (words.match(/\d+/g) ?? []).map(Number)
    const dayNumber = numbers.find((n) => n <= 31)
    if (dayNumber === undefined) return null
    day = dayNumber
    year =
      numbers.find((n) => n > 31) ??
      (numbers.length > 1 && numbers[1] < 100 && numbers[0] !== numbers[1]
        ? numbers[1]
        : fallbackYear)
  }
  if (year < 100) year += 2000
  const date = new Date(year, month - 1, day)
  const real =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  return real ? date : null
}
