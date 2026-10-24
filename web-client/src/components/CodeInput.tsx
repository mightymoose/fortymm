import { Fragment, useRef, type ClipboardEvent, type ComponentProps, type KeyboardEvent } from 'react'

// Uppercased, with everything but letters and digits dropped.
function clean(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// A code typed one character per box, such as a tournament's join code,
// styled by `.fm-code` in styles/kit.css, as kit.js's `data-code` draws it.
// Typing, pasting or autofill spreads the characters across the boxes.
// Backspace in an empty box steps back, and ← → move. It takes letters and
// digits only, uppercased. `onInput` gets the code on every edit, and
// `onComplete` once every box is filled. `split` puts a dash before that
// box. The boxes are uncontrolled, as in kit.js, so focus can move and
// select a box the moment its value is written.
export function CodeInput({
  length = 6,
  split = 0,
  invalid = false,
  disabled = false,
  describedBy,
  onInput,
  onComplete,
  ...props
}: Omit<ComponentProps<'div'>, 'onInput'> & {
  length?: number
  split?: number
  invalid?: boolean
  disabled?: boolean
  // The ids of the help and error each box is described by.
  describedBy?: string
  onInput?: (code: string) => void
  onComplete?: (code: string) => void
}) {
  const boxes = useRef<HTMLInputElement[]>([])

  function emit() {
    const code = boxes.current.map((box) => box.value).join('')
    onInput?.(code)
    if (code.length === length) onComplete?.(code)
  }

  // Writes `text` into the boxes from `from` on, then focuses the box
  // after the last one written.
  function fill(from: number, text: string) {
    let at = from
    for (const character of clean(text)) {
      if (at >= length) break
      boxes.current[at++].value = character
    }
    boxes.current[Math.min(at, length - 1)].focus()
    emit()
  }

  function onBoxInput(index: number, box: HTMLInputElement) {
    const value = clean(box.value)
    if (value.length > 1) {
      box.value = ''
      fill(index, value)
      return
    }
    box.value = value
    if (value && index < length - 1) boxes.current[index + 1].focus()
    emit()
  }

  function onKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    const previous = boxes.current[index - 1]
    const next = boxes.current[index + 1]
    if (event.key === 'Backspace' && !event.currentTarget.value && previous) {
      event.preventDefault()
      previous.value = ''
      previous.focus()
      emit()
    } else if (event.key === 'ArrowLeft' && previous) {
      event.preventDefault()
      previous.focus()
    } else if (event.key === 'ArrowRight' && next) {
      event.preventDefault()
      next.focus()
    }
  }

  function onPaste(index: number, event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault()
    fill(index, event.clipboardData.getData('text'))
  }

  return (
    <div className="fm-code" role="group" {...props}>
      {Array.from({ length }, (_, index) => (
        <Fragment key={index}>
          {split > 0 && index === split && <span className="fm-code__sep" aria-hidden="true" />}
          <input
            ref={(box) => {
              if (box) boxes.current[index] = box
            }}
            className="fm-input"
            maxLength={length}
            autoCapitalize="characters"
            autoComplete={index ? 'off' : 'one-time-code'}
            spellCheck={false}
            aria-label={`Character ${index + 1} of ${length}`}
            aria-invalid={invalid ? 'true' : undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => onBoxInput(index, event.currentTarget)}
            onKeyDown={(event) => onKeyDown(index, event)}
            onPaste={(event) => onPaste(index, event)}
          />
        </Fragment>
      ))}
    </div>
  )
}
