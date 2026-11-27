import { type CalendarDate } from '@internationalized/date'
import { type CalendarState } from 'react-stately'
import { useDateFormat } from './dates.ts'

// A day of the month before or after the one a Calendar shows, filling out its first or last week
// (fm-cal__day out): greyed, and picking it selects it and turns to its month. Disabled when it is
// unavailable, like the days of the month. Not in the tab order: the arrow keys reach it by turning
// the page.
export function CalendarOutsideDay({
  date,
  state,
  isUnavailable,
}: {
  date: CalendarDate
  state: CalendarState
  isUnavailable: boolean
}) {
  const { formatDate } = useDateFormat()
  return (
    <td>
      <button
        type="button"
        className="fm-cal__day out"
        tabIndex={-1}
        aria-label={formatDate(date)}
        disabled={isUnavailable}
        onClick={() => state.selectDate(date)}
      >
        {date.day}
      </button>
    </td>
  )
}
