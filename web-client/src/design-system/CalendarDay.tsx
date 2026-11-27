import { type CalendarDate, isSameDay } from '@internationalized/date'
import { useRef } from 'react'
import { useCalendarCell } from 'react-aria'
import { type CalendarState } from 'react-stately'

// A day of the month a Calendar shows (fm-cal__day): React Aria's useCalendarCell on kit.css's
// markup, a button in each cell. kit.css draws the selected day from aria-selected on the button,
// as the board does; today is outlined; an unavailable day (e.g. a past one) is disabled and
// struck through.
export function CalendarDay({
  date,
  state,
  today,
}: {
  date: CalendarDate
  state: CalendarState
  today: CalendarDate
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const { cellProps, buttonProps, isSelected, isDisabled, isUnavailable } = useCalendarCell(
    { date },
    state,
    ref,
  )
  const isToday = isSameDay(date, today)
  return (
    <td {...cellProps}>
      <button
        {...buttonProps}
        ref={ref}
        type="button"
        className={isToday ? 'fm-cal__day today' : 'fm-cal__day'}
        aria-selected={isSelected || undefined}
        aria-current={isToday ? 'date' : undefined}
        disabled={isDisabled || isUnavailable}
      >
        {date.day}
      </button>
    </td>
  )
}
