import { Calendar } from './Calendar'
import { useCalendar, type CalendarConfig } from './calendarState'
import { isoDate, type IsoDate } from './dates'

// A calendar set in the page rather than in a popup, for scheduling
// screens, styled by `.fm-cal--inline` in styles/kit.css. Picking a day
// keeps focus on it and announces it.
export function InlineCalendar({
  config,
  onChange,
}: {
  config: CalendarConfig
  onChange?: (date: IsoDate) => void
}) {
  const calendar = useCalendar(config)
  return (
    <Calendar
      calendar={calendar}
      config={config}
      inline
      onPick={(date) => onChange?.(isoDate(date))}
    />
  )
}
