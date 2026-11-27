import { type CalendarDate, today as todayIn } from '@internationalized/date'
import { useState } from 'react'
import { Input, TextField as AriaTextField } from 'react-aria-components'
import { Button } from './Button.tsx'
import { Calendar } from './Calendar.tsx'
import { useDateFormat } from './dates.ts'
import { FieldLabel } from './FieldLabel.tsx'
import { FieldMessage } from './FieldMessage.tsx'
import { Icon } from './Icon.tsx'

// A date, typed or picked (fm-datefield): React Aria's TextField with a calendar button that drops
// a Calendar below it, in the user's language (see useDateFormat). Typed text is read when the
// field loses focus and written out in full; text it can't read, or a date before minValue, shows
// the error. Picking a day closes the calendar; so does Escape.
export function DateField({
  label,
  defaultValue = null,
  onChange,
  today,
  minValue,
  description,
}: {
  label: string
  defaultValue?: CalendarDate | null
  onChange?: (date: CalendarDate | null) => void
  today?: CalendarDate
  minValue?: CalendarDate
  description?: string
}) {
  const { formatDate, parseDate } = useDateFormat()
  const [date, setDate] = useState(defaultValue)
  const [text, setText] = useState(defaultValue ? formatDate(defaultValue) : '')
  const [error, setError] = useState<string | null>(null)
  const [isOpen, setOpen] = useState(false)

  function choose(next: CalendarDate | null) {
    setDate(next)
    setText(next ? formatDate(next) : '')
    setError(null)
    onChange?.(next)
  }

  function read() {
    if (!text.trim()) return choose(null)
    const typed = parseDate(text)
    if (!typed) return setError(`Enter a date like ${formatDate(today ?? todayIn('UTC'))}.`)
    if (minValue && typed.compare(minValue) < 0) {
      return setError(`Choose ${formatDate(minValue)} or later.`)
    }
    choose(typed)
  }

  return (
    <AriaTextField
      className="fm-field"
      value={text}
      onChange={setText}
      onBlur={read}
      isInvalid={error !== null}
    >
      <FieldLabel label={label} />
      <div
        className="fm-datefield"
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
      >
        <Input className="fm-input" />
        <Button
          variant="secondary"
          isIconOnly
          aria-label={isOpen ? 'Close calendar' : 'Open calendar'}
          onPress={() => setOpen(!isOpen)}
        >
          <Icon name="calendar" />
        </Button>
        {isOpen && (
          <Calendar
            variant="overlay"
            aria-label={label}
            value={date}
            today={today}
            minValue={minValue}
            autoFocus
            onChange={(next) => {
              choose(next)
              setOpen(false)
            }}
          />
        )}
      </div>
      <FieldMessage
        description={description}
        errorMessage={error ?? undefined}
        isInvalid={error !== null}
      />
    </AriaTextField>
  )
}
