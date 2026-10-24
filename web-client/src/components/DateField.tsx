import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from './Button'
import { Calendar, type CalendarHandle } from './Calendar'
import { useCalendar, type CalendarConfig } from './calendarState'
import { dateFromIso, isoDate, longDate, parseDate, type IsoDate } from './dates'
import { FieldError } from './FieldError'
import { Icon } from './Icon'

// A date field with a calendar popup, styled by `.fm-datefield` in
// styles/kit.css, as kit.js's date picker draws it. A typed date is checked
// when the field changes and loses focus, or on Enter, then shown in full;
// a date it can't read, or one before `min`, shows an error. Alt+↓ opens
// the calendar, and Esc closes it and puts focus back on its button.
export function DateField({
  label,
  help,
  config,
  onChange,
  'data-testid': testId,
}: {
  label: string
  help: string
  config: CalendarConfig
  onChange?: (date: IsoDate) => void
  'data-testid'?: string
}) {
  const inputId = useId()
  const helpId = useId()
  const errorId = useId()
  const calendar = useCalendar(config)
  const { state, dispatch } = calendar
  const [text, setText] = useState(() =>
    state.selected ? longDate(dateFromIso(state.selected)) : '',
  )
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const field = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const grid = useRef<CalendarHandle>(null)
  // The text when the field took focus, so leaving it checks the text only
  // if it changed, as the native change event does.
  const textOnFocus = useRef(text)

  function check() {
    const typed = text.trim()
    if (!typed) {
      dispatch({ type: 'type', date: null })
      setError(null)
      return
    }
    const date = parseDate(typed, dateFromIso(state.month).getFullYear())
    if (!date) {
      setError('Enter a date like 11 April 2026 or 11/4/2026.')
      return
    }
    if (config.min && isoDate(date) < config.min) {
      setError(`Pick ${longDate(dateFromIso(config.min))} or later.`)
      return
    }
    dispatch({ type: 'type', date })
    setText(longDate(date))
    setError(null)
    onChange?.(isoDate(date))
  }

  function openCalendar() {
    setOpen(true)
    grid.current?.focusDay()
  }

  function closeCalendar(returnFocus: boolean) {
    setOpen(false)
    if (returnFocus) button.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!field.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      check()
    }
    if (event.key === 'ArrowDown' && event.altKey) {
      event.preventDefault()
      openCalendar()
    }
    if (event.key === 'Escape' && open) closeCalendar(true)
  }

  return (
    <div className="fm-field">
      <label className="fm-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="fm-datefield" ref={field} data-testid={testId}>
        <input
          id={inputId}
          className="fm-input"
          aria-describedby={`${helpId} ${errorId}`}
          aria-invalid={error ? 'true' : undefined}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => {
            textOnFocus.current = text
          }}
          onBlur={() => {
            if (text !== textOnFocus.current) check()
          }}
          onKeyDown={onKeyDown}
        />
        <Button
          ref={button}
          variant="secondary"
          icon
          aria-label="Open calendar"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? closeCalendar(true) : openCalendar())}
        >
          <Icon name="calendar" />
        </Button>
        <Calendar
          ref={grid}
          calendar={calendar}
          config={config}
          hidden={!open}
          onPick={(date) => {
            setText(longDate(date))
            setError(null)
            onChange?.(isoDate(date))
            closeCalendar(true)
          }}
          onEscape={() => closeCalendar(true)}
        />
      </div>
      <p className="fm-help" id={helpId}>
        {help}
      </p>
      <FieldError id={errorId} hidden={!error}>
        {error}
      </FieldError>
    </div>
  )
}
