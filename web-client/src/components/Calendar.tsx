import {
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react'
import { useAnnounce } from './announceContext'
import { Button } from './Button'
import type { CalendarConfig, CalendarModel } from './calendarState'
import { dateFromIso, isoDate, longDate, MONTHS } from './dates'
import { Icon } from './Icon'

const WEEKDAY_ABBREVIATIONS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

// The days a key moves focus by.
const DAY_STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
}

export type CalendarHandle = {
  // Focuses the calendar's focused day once it's on screen.
  focusDay: () => void
}

// The six weeks, Monday first, that show `month`.
function weeksOf(month: Date): Date[][] {
  const year = month.getFullYear()
  const index = month.getMonth()
  const first = 1 - ((new Date(year, index, 1).getDay() + 6) % 7)
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => new Date(year, index, first + week * 7 + day)),
  )
}

// A month grid for picking a day, styled by `.fm-cal` in styles/kit.css, as
// kit.js's date picker draws it. The arrows move a day or a week, Page Up
// and Page Down a month, Home and End to the week's ends, and Enter picks.
// `inline` sets it in the page; otherwise it's DateField's popup, which Esc
// closes through `onEscape`.
export function Calendar({
  calendar: { state, dispatch },
  config: { today, min },
  inline = false,
  hidden,
  onPick,
  onEscape,
  ref,
}: {
  calendar: CalendarModel
  config: CalendarConfig
  inline?: boolean
  hidden?: boolean
  onPick?: (date: Date) => void
  onEscape?: () => void
  ref?: Ref<CalendarHandle>
}) {
  const titleId = useId()
  const root = useRef<HTMLDivElement>(null)
  const announce = useAnnounce()
  // Counts the requests to focus the focused day, so each one runs once
  // the grid shows that day.
  const [focusRequests, setFocusRequests] = useState(0)
  const focusedRequests = useRef(0)
  const focusDay = () => setFocusRequests((count) => count + 1)
  useImperativeHandle(ref, () => ({ focusDay }))

  useLayoutEffect(() => {
    if (focusRequests === focusedRequests.current) return
    focusedRequests.current = focusRequests
    root.current?.querySelector<HTMLElement>(`[data-date="${state.focused}"]`)?.focus()
  })

  const month = dateFromIso(state.month)

  function moveFocus(date: Date) {
    dispatch({ type: 'focus', date })
    focusDay()
  }

  function pick(date: Date) {
    dispatch({ type: 'pick', date })
    if (inline) {
      focusDay()
      announce(`${longDate(date)} selected`)
    }
    onPick?.(date)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onEscape?.()
      return
    }
    const day = (event.target as HTMLElement).closest<HTMLElement>('[data-date]')
    if (!day) return
    const from = dateFromIso(day.dataset.date!)
    const year = from.getFullYear()
    const monthIndex = from.getMonth()
    const date = from.getDate()
    const step = DAY_STEPS[event.key]
    if (step) {
      event.preventDefault()
      moveFocus(new Date(year, monthIndex, date + step))
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault()
      moveFocus(new Date(year, monthIndex + (event.key === 'PageUp' ? -1 : 1), date))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const weekday = (from.getDay() + 6) % 7
      moveFocus(new Date(year, monthIndex, date + (event.key === 'Home' ? -weekday : 6 - weekday)))
    }
  }

  return (
    <div
      ref={root}
      className={inline ? 'fm-cal fm-cal--inline' : 'fm-overlay fm-cal'}
      hidden={hidden}
      role={inline ? undefined : 'dialog'}
      aria-label={inline ? undefined : 'Choose date'}
      onKeyDown={onKeyDown}
    >
      <div className="fm-cal__head">
        <Button
          variant="ghost"
          size="sm"
          icon
          aria-label="Previous month"
          onClick={() => dispatch({ type: 'showMonth', delta: -1 })}
        >
          <Icon name="left" className="fm-ic--sm" />
        </Button>
        <span className="fm-cal__title" id={titleId} aria-live="polite">
          {MONTHS[month.getMonth()]} {month.getFullYear()}
        </span>
        <Button
          variant="ghost"
          size="sm"
          icon
          aria-label="Next month"
          onClick={() => dispatch({ type: 'showMonth', delta: 1 })}
        >
          <Icon name="right" className="fm-ic--sm" />
        </Button>
      </div>
      <table role="grid" aria-labelledby={titleId}>
        <thead>
          <tr>
            {WEEKDAY_ABBREVIATIONS.map((day) => (
              <th key={day} scope="col" abbr={day}>
                {day}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeksOf(month).map((week) => (
            <tr key={isoDate(week[0])}>
              {week.map((day) => {
                const iso = isoDate(day)
                const classes = ['fm-cal__day']
                if (day.getMonth() !== month.getMonth()) classes.push('out')
                if (iso === today) classes.push('today')
                return (
                  <td key={iso}>
                    <button
                      type="button"
                      className={classes.join(' ')}
                      data-date={iso}
                      tabIndex={iso === state.focused ? 0 : -1}
                      aria-selected={iso === state.selected}
                      aria-label={iso === today ? `${longDate(day)}, today` : longDate(day)}
                      disabled={min !== undefined && iso < min}
                      onClick={() => pick(day)}
                    >
                      {day.getDate()}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fm-cal__foot">
        <span></span>
        <Button variant="link" onClick={() => moveFocus(dateFromIso(today))}>
          Today
        </Button>
      </div>
    </div>
  )
}
