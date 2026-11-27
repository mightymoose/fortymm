import {
  type CalendarDate,
  type DateValue,
  createCalendar,
  getWeeksInMonth,
  isSameMonth,
  today as todayIn,
} from '@internationalized/date'
import { useCalendar, useCalendarGrid } from 'react-aria'
import { useCalendarState } from 'react-stately'
import { Button } from './Button.tsx'
import { CalendarDay } from './CalendarDay.tsx'
import { CalendarOutsideDay } from './CalendarOutsideDay.tsx'
import { useDateFormat } from './dates.ts'
import { Icon } from './Icon.tsx'

// A month to pick a day from (fm-cal): React Aria's useCalendar and useCalendarGrid on kit.css's
// markup, in the user's language (see useDateFormat), weeks starting on the locale's first day
// (Sunday in the US, Monday in Britain). The selected day is orange, today is outlined, and the
// footer says which is which.
//
// - today: the day to treat as today. Defaults to the real one; the showcase fixes it.
// - minValue: days before it are struck through and can't be picked. They stay in view, so the
//   month before can still be turned to.
// - variant: inline sits in the page on a panel; overlay drops below a DateField.
export function Calendar({
  value,
  defaultValue,
  onChange,
  today = todayIn('UTC'),
  minValue,
  variant = 'inline',
  autoFocus,
  'aria-label': ariaLabel,
}: {
  value?: CalendarDate | null
  defaultValue?: CalendarDate | null
  onChange?: (date: CalendarDate) => void
  today?: CalendarDate
  minValue?: CalendarDate
  variant?: 'inline' | 'overlay'
  autoFocus?: boolean
  'aria-label'?: string
}) {
  const isUnavailable = (date: DateValue) => minValue !== undefined && date.compare(minValue) < 0
  const props = {
    value,
    defaultValue,
    onChange: (date: CalendarDate) => onChange?.(date),
    isDateUnavailable: isUnavailable,
    defaultFocusedValue: value ?? defaultValue ?? today,
    autoFocus,
    'aria-label': ariaLabel,
  }
  const { locale, formatDay, formatMonth, formatWeekday } = useDateFormat()
  const state = useCalendarState({ ...props, locale, createCalendar })
  const { calendarProps } = useCalendar(props, state)
  const { gridProps } = useCalendarGrid({}, state)
  const month = state.visibleRange.start
  const weeks = [...Array(getWeeksInMonth(month, locale)).keys()].map((week) =>
    state.getDatesInWeek(week, month).filter((date) => date !== null),
  )
  const selected = state.value
  return (
    <div
      {...calendarProps}
      className={variant === 'inline' ? 'fm-cal fm-cal--inline' : 'fm-cal fm-overlay'}
    >
      <div className="fm-cal__head">
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label="Previous month"
          onPress={() => state.focusPreviousPage()}
        >
          <Icon name="chevron-left" />
        </Button>
        <span className="fm-cal__title">{formatMonth(month)}</span>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          aria-label="Next month"
          onPress={() => state.focusNextPage()}
        >
          <Icon name="chevron-right" />
        </Button>
      </div>
      <table {...gridProps}>
        <thead>
          <tr>
            {weeks[0].map((date) => (
              <th key={date.toString()} scope="col" abbr={formatWeekday(date)}>
                {formatWeekday(date).slice(0, 2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((dates) => (
            <tr key={dates[0].toString()}>
              {dates.map((date) =>
                isSameMonth(date, month) ? (
                  <CalendarDay key={date.toString()} date={date} state={state} today={today} />
                ) : (
                  <CalendarOutsideDay
                    key={date.toString()}
                    date={date}
                    state={state}
                    isUnavailable={isUnavailable(date)}
                  />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fm-cal__foot">
        <span>Today: {formatDay(today)}</span>
        {selected && <span>Selected: {formatDay(selected)}</span>}
      </div>
    </div>
  )
}
