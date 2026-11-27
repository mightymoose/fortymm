import { CalendarDate, DateFormatter } from '@internationalized/date'
import { useMemo } from 'react'
import { useLocale } from 'react-aria'

// How dates are written and read in the user's language (React Aria's locale: the browser's, or an
// I18nProvider's): the full date in the locale's own long pattern ("Saturday, April 11, 2026" in
// the US, "Saturday 11 April 2026" in Britain), and typed numbers in the locale's order (4/11/2026
// is April 11 in the US, 4 November in Britain).
export interface DateFormat {
  locale: string
  // "Saturday, April 11, 2026"
  formatDate(date: CalendarDate): string
  // "Saturday, April 11", for when the year goes without saying.
  formatDay(date: CalendarDate): string
  // "April 2026"
  formatMonth(date: CalendarDate): string
  // "Saturday"
  formatWeekday(date: CalendarDate): string
  // A typed date, or null when it can't be read (see dateFormat).
  parseDate(text: string): CalendarDate | null
}

export function useDateFormat(): DateFormat {
  const { locale } = useLocale()
  return useMemo(() => dateFormat(locale), [locale])
}

// The date with this year, month (1–12) and day, or null when there is none (e.g. 31 April).
function dateOf(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1) return null
  const date = new CalendarDate(year, month, day)
  return date.day === day ? date : null
}

// The DateFormat for a locale. Reads the way formatDate writes a date, with or without the
// weekday; a month name or its first three letters or more, before or after the day ("11 Apr
// 2026", "April 11 2026"); numbers in the locale's order ("4/11/2026", "4.11.2026"); and ISO
// ("2026-04-11").
export function dateFormat(locale: string): DateFormat {
  const utc = (date: CalendarDate) => date.toDate('UTC')
  const full = new DateFormatter(locale, { dateStyle: 'full', timeZone: 'UTC' })
  const day = new DateFormatter(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
  const month = new DateFormatter(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const weekday = new DateFormatter(locale, { weekday: 'long', timeZone: 'UTC' })

  const monthNames = new DateFormatter(locale, { month: 'long', timeZone: 'UTC' })
  const months = Array.from({ length: 12 }, (_, i) =>
    monthNames.format(new Date(Date.UTC(2026, i, 1))).toLowerCase(),
  )
  const monthNamed = (name: string) =>
    name.length >= 3 ? months.findIndex((m) => m.startsWith(name)) + 1 : 0
  // The order the locale writes day, month and year in, as numbers.
  const order = new DateFormatter(locale, { timeZone: 'UTC' })
    .formatToParts(new Date(Date.UTC(2026, 3, 11)))
    .map((part) => part.type)
    .filter((type) => type === 'day' || type === 'month' || type === 'year')

  // A week of weekday names, to drop from typed dates: 6–12 April 2026 is Monday to Sunday.
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    weekday.format(new Date(Date.UTC(2026, 3, 6 + i))).toLowerCase(),
  )

  function parseDate(text: string) {
    const t = text.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ')
    const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (iso) return dateOf(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    const numeric = t.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/)
    if (numeric) {
      const value = (type: string) => Number(numeric[order.indexOf(type as never) + 1])
      return dateOf(value('year'), value('month'), value('day'))
    }
    // Drop the weekday, if any, and ordinals ("11th").
    const words = t.split(' ').filter((w) => !weekdays.some((d) => d.startsWith(w) && w.length >= 3))
    const named = words.join(' ').replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    const dayFirst = named.match(/^(\d{1,2}) ([^\d\s]+) (\d{4})$/)
    if (dayFirst) return dateOf(Number(dayFirst[3]), monthNamed(dayFirst[2]), Number(dayFirst[1]))
    const monthFirst = named.match(/^([^\d\s]+) (\d{1,2}) (\d{4})$/)
    if (monthFirst) {
      return dateOf(Number(monthFirst[3]), monthNamed(monthFirst[1]), Number(monthFirst[2]))
    }
    return null
  }
  return {
    locale,
    formatDate: (date) => full.format(utc(date)),
    formatDay: (date) => day.format(utc(date)),
    formatMonth: (date) => month.format(utc(date)),
    formatWeekday: (date) => weekday.format(utc(date)),
    parseDate,
  }
}
