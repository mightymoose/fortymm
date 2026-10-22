import {
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  type ComponentProps,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { Button } from './Button'
import { useField, useFieldControl } from './fieldContext'
import {
  WEEKDAYS,
  addDays,
  addMonths,
  formatDate,
  formatMonth,
  localToday,
  monthWeeks,
  parts,
  sameMonth,
  type PlainDate,
} from './plainDate'

// The calendar shows the focused day's month, so the visible month is never
// stored, and a focused day exists only while the calendar is open.
type DatePickerState = {
  value: PlainDate | null
  calendar: { open: false } | { open: true; focused: PlainDate }
}

type DatePickerAction =
  | { type: 'opened'; focused: PlainDate }
  | { type: 'focused'; date: PlainDate }
  | { type: 'chose'; date: PlainDate }
  | { type: 'closed' }

function reducer(
  state: DatePickerState,
  action: DatePickerAction,
): DatePickerState {
  switch (action.type) {
    case 'opened':
      return { ...state, calendar: { open: true, focused: action.focused } }
    case 'focused':
      if (!state.calendar.open) return state
      return { ...state, calendar: { open: true, focused: action.date } }
    case 'chose':
      return { value: action.date, calendar: { open: false } }
    case 'closed':
      return state.calendar.open ? { ...state, calendar: { open: false } } : state
  }
}

// The grid's keys, from the WAI-ARIA date picker dialog pattern, and the
// day each one moves the focus to.
const MOVES: Record<string, (date: PlainDate) => PlainDate> = {
  ArrowLeft: (date) => addDays(date, -1),
  ArrowRight: (date) => addDays(date, 1),
  ArrowUp: (date) => addDays(date, -7),
  ArrowDown: (date) => addDays(date, 7),
  Home: (date) => addDays(date, -parts(date).weekday),
  End: (date) => addDays(date, 6 - parts(date).weekday),
  PageUp: (date) => addMonths(date, -1),
  PageDown: (date) => addMonths(date, 1),
  'Shift+PageUp': (date) => addMonths(date, -12),
  'Shift+PageDown': (date) => addMonths(date, 12),
}

// A button that opens a calendar for picking a day, following the WAI-ARIA
// date picker dialog pattern, from the reference kit's Date Picker: an
// outline Button showing the chosen date and a `.cal` dialog holding the
// month, its previous and next buttons and a grid of days (styles/base.css).
// The arrow keys, Home, End, PageUp and PageDown move the focused day, and
// Enter, Space or a click chooses one: the dialog closes, the focus goes
// back to the button and `onValueChange` gets the day. Escape closes the
// dialog too, and so does the focus leaving the picker. The dialog isn't
// modal: it floats under the button, over the page, and leaves the rest of
// the page usable.
//
// It's uncontrolled: `defaultValue` sets the chosen day and `defaultOpen`
// opens the calendar on it, without taking the focus. `today` is marked in
// the calendar and is where it opens with no day chosen; it defaults to the
// date on the user's clock. `label` goes above the button, e.g. a Field's
// Label. `className` adds to the root's class, and the other props go to
// the button.
//
// Inside a Field it takes the field's label, help text, disabled and invalid
// states. The button's name is the label followed by the chosen date. A
// button can't be required, so it takes no `required`, but a required
// Field's Label still shows its asterisk. It shows the invalid state with
// the text controls' error border, and its help text says why.
export function DatePicker({
  defaultValue = null,
  defaultOpen = false,
  today = localToday(),
  placeholder = 'Pick a date',
  onValueChange,
  label,
  className,
  onClick,
  ...props
}: Omit<
  ComponentProps<'button'>,
  'value' | 'defaultValue' | 'children' | 'type' | 'className' | 'ref'
> & {
  defaultValue?: PlainDate | null
  defaultOpen?: boolean
  today?: PlainDate
  placeholder?: string
  onValueChange?: (date: PlainDate) => void
  label?: ReactNode
  className?: string
}) {
  const [state, dispatch] = useReducer(
    reducer,
    undefined,
    (): DatePickerState => ({
      value: defaultValue,
      calendar: defaultOpen
        ? { open: true, focused: defaultValue ?? today }
        : { open: false },
    }),
  )
  const field = useField()
  const {
    required: _required,
    'aria-invalid': invalid,
    ...buttonProps
  } = useFieldControl<typeof props & { required?: boolean }>(props)
  const textId = useId()
  const dialogId = useId()
  const monthId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  // Where the focus goes after the next render, once the element it goes to
  // is there. Only a user's action sets it, so a calendar that starts open
  // doesn't take the focus.
  const focusNext = useRef<'trigger' | 'grid' | null>(null)
  useLayoutEffect(() => {
    const target = focusNext.current
    focusNext.current = null
    if (target === 'trigger') triggerRef.current?.focus()
    if (target === 'grid') {
      gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus()
    }
  })

  const disabled = buttonProps.disabled
  const calendar = disabled ? { open: false as const } : state.calendar
  // Disabling the picker closes it for good, so it doesn't open again by
  // itself once it's enabled.
  useEffect(() => {
    if (disabled) dispatch({ type: 'closed' })
  }, [disabled])
  const text = state.value ? formatDate(state.value) : placeholder
  const ownLabel = props['aria-label']
  const labelledBy = ownLabel
    ? undefined
    : (props['aria-labelledby'] ?? field?.labelId)

  function choose(date: PlainDate) {
    dispatch({ type: 'chose', date })
    focusNext.current = 'trigger'
    onValueChange?.(date)
  }

  function handleTriggerClick(event: MouseEvent<HTMLButtonElement>) {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (calendar.open) {
      dispatch({ type: 'closed' })
      focusNext.current = 'trigger'
    } else {
      dispatch({ type: 'opened', focused: state.value ?? today })
      focusNext.current = 'grid'
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && calendar.open) {
      event.preventDefault()
      dispatch({ type: 'closed' })
      focusNext.current = 'trigger'
    }
  }

  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!calendar.open || event.altKey || event.ctrlKey || event.metaKey) return
    const move = MOVES[`${event.shiftKey ? 'Shift+' : ''}${event.key}`]
    if (move) {
      // Natively the arrows and Page keys would scroll the page.
      event.preventDefault()
      dispatch({ type: 'focused', date: move(calendar.focused) })
      focusNext.current = 'grid'
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(calendar.focused)
    }
  }

  // With the focus in the picker, a press on the button or the label would
  // move it out first, where a browser doesn't focus a button on a press
  // (Safari) or the label isn't focusable, and close the calendar before
  // their click toggles it. A click inside the dialog keeps the focus in the
  // picker by itself, since the dialog takes it. With the focus elsewhere,
  // the press goes ahead, so the browser doesn't show a click's focus as
  // keyboard focus.
  function handleMouseDown(event: MouseEvent<HTMLDivElement>) {
    const root = event.currentTarget
    const inDialog = (event.target as Element).closest('[role="dialog"]')
    if (calendar.open && !inDialog && root.contains(document.activeElement)) {
      event.preventDefault()
    }
  }

  // Only the focus leaving the picker closes it.
  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      dispatch({ type: 'closed' })
    }
  }

  return (
    <div
      className={className ? `date-picker ${className}` : 'date-picker'}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      onBlur={handleBlur}
    >
      <div>
        {label}
        <Button
          variant="outline"
          className="date-picker-trigger"
          aria-haspopup="dialog"
          aria-expanded={calendar.open}
          aria-controls={calendar.open ? dialogId : undefined}
          data-invalid={invalid === true || invalid === 'true' ? true : undefined}
          {...buttonProps}
          ref={triggerRef}
          aria-label={ownLabel ? `${ownLabel} ${text}` : undefined}
          aria-labelledby={labelledBy ? `${labelledBy} ${textId}` : undefined}
          onClick={handleTriggerClick}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
          <span
            id={textId}
            className={state.value ? undefined : 'date-picker-placeholder'}
          >
            {text}
          </span>
        </Button>
      </div>
      {calendar.open && (
        <div
          role="dialog"
          id={dialogId}
          className="cal"
          tabIndex={-1}
          aria-label={ownLabel}
          aria-labelledby={labelledBy}
        >
          <div className="cal-h">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Previous month"
              onClick={() =>
                dispatch({
                  type: 'focused',
                  date: addMonths(calendar.focused, -1),
                })
              }
            >
              ‹
            </Button>
            <span id={monthId} aria-live="polite">
              {formatMonth(calendar.focused)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Next month"
              onClick={() =>
                dispatch({
                  type: 'focused',
                  date: addMonths(calendar.focused, 1),
                })
              }
            >
              ›
            </Button>
          </div>
          <div
            role="grid"
            className="cal-grid"
            aria-labelledby={monthId}
            ref={gridRef}
            onKeyDown={handleGridKeyDown}
          >
            <div role="row" className="cal-week">
              {WEEKDAYS.map((weekday) => (
                <span
                  key={weekday}
                  role="columnheader"
                  className="dow"
                  aria-label={weekday}
                >
                  {weekday[0]}
                </span>
              ))}
            </div>
            {monthWeeks(calendar.focused).map((week) => (
              <div role="row" className="cal-week" key={week[0]}>
                {week.map((date) => (
                  <span
                    key={date}
                    role="gridcell"
                    className={
                      sameMonth(date, calendar.focused) ? 'day' : 'day day--muted'
                    }
                    tabIndex={date === calendar.focused ? 0 : -1}
                    aria-label={formatDate(date)}
                    aria-selected={date === state.value}
                    aria-current={date === today ? 'date' : undefined}
                    onClick={() => choose(date)}
                  >
                    {parts(date).day}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
