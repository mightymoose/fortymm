import { type ReactNode, useId, useRef, useState } from 'react'
import { Group, Input } from 'react-aria-components'
import { Icon } from './Icon.tsx'

// Letters and numbers only; everything else is dropped.
function clean(text: string) {
  return text.replace(/[^a-z0-9]/gi, '').toUpperCase()
}

// What was typed into a box that held `old`: a box that already held a character gets just the new
// one, whichever side of the old one the caret was on.
function newCharacters(typed: string, old: string) {
  return old && typed.length === 2 ? typed.replace(old, '') : typed
}

// A short code typed one character per box (fm-code), e.g. the organizer's 6-character tournament
// code: React Aria's Group and Inputs on kit.css's markup, with a gap halfway. Letters and numbers
// only, shown in capitals. Typing moves to the next box, Backspace on an empty box to the previous
// one, and a pasted or autofilled code spreads across the boxes. Below the boxes: the error when
// invalid, otherwise the help, and then any children (e.g. a notice naming the tournament found).
export function CodeInput({
  label,
  length = 6,
  defaultValue = '',
  onChange,
  description,
  errorMessage,
  isInvalid,
  isDisabled,
  children,
}: {
  label: string
  length?: number
  defaultValue?: string
  onChange?: (code: string) => void
  description?: string
  errorMessage?: string
  isInvalid?: boolean
  isDisabled?: boolean
  children?: ReactNode
}) {
  const labelId = useId()
  const messageId = useId()
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const [chars, setChars] = useState(() =>
    Array.from({ length }, (_, i) => clean(defaultValue)[i] ?? ''),
  )

  function focusBox(index: number) {
    inputs.current[Math.max(0, Math.min(length - 1, index))]?.focus()
  }

  // Text typed or pasted into a box fills it and the boxes after it.
  function enter(index: number, text: string) {
    const fresh = newCharacters(clean(text), chars[index])
    const next = [...chars]
    if (!fresh) {
      next[index] = ''
    } else {
      fresh
        .slice(0, length - index)
        .split('')
        .forEach((char, offset) => (next[index + offset] = char))
      focusBox(index + fresh.length)
    }
    setChars(next)
    onChange?.(next.join(''))
  }

  const hasError = isInvalid && errorMessage
  const message = hasError ? (
    <p className="fm-error" id={messageId}>
      <Icon name="circle-alert" />
      <span>{errorMessage}</span>
    </p>
  ) : description ? (
    <p className="fm-help" id={messageId}>
      {description}
    </p>
  ) : null

  const boxes = chars.map((char, index) => (
    <Input
      key={index}
      ref={(el) => {
        inputs.current[index] = el
      }}
      className="fm-input"
      value={char}
      aria-label={`Character ${index + 1} of ${length}`}
      aria-invalid={isInvalid || undefined}
      disabled={isDisabled}
      autoComplete={index === 0 ? 'one-time-code' : 'off'}
      autoCapitalize="characters"
      spellCheck={false}
      onChange={(e) => enter(index, e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Backspace' && !char) {
          e.preventDefault()
          focusBox(index - 1)
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          focusBox(index - 1)
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          focusBox(index + 1)
        }
      }}
    />
  ))
  const half = Math.ceil(length / 2)

  return (
    <div className="fm-field">
      <span className="fm-label" id={labelId}>
        {label}
      </span>
      <Group
        className="fm-code"
        aria-labelledby={labelId}
        aria-describedby={message ? messageId : undefined}
        isDisabled={isDisabled}
        isInvalid={isInvalid}
      >
        {boxes.slice(0, half)}
        <span className="fm-code__sep" aria-hidden="true" />
        {boxes.slice(half)}
      </Group>
      {message}
      {children}
    </div>
  )
}
