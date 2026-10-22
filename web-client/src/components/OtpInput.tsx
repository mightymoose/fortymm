import {
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type SyntheticEvent,
} from 'react'
import { useFieldControl } from './fieldContext'

// Keeps the characters a code can hold (letters and digits) and cuts it to
// `length`, so a pasted "40-MM 12" fills the cells as "40MM12".
function toCode(text: string, length: number): string {
  return text.replace(/[^0-9a-z]/gi, '').slice(0, length)
}

// A one-time-code input: one <input> holding the whole code, laid
// transparently over a row of cells that show it one character each. Styled
// by `.otp` in styles/base.css. Inside a Field it's wired to the field's
// label, help text and state.
//
// While it's focused, the cell the next character goes into is active: the
// one holding the caret, or the next empty one. A filled cell the caret moves
// onto is selected, so typing replaces it. `activeIndex` shows a cell as
// active while the input isn't focused, e.g. to point at a character to
// correct.
export function OtpInput({
  length = 6,
  value,
  defaultValue,
  onChange,
  onFocus,
  onBlur,
  onSelect,
  onKeyDown,
  onClick,
  activeIndex,
  className,
  ...props
}: Omit<
  ComponentProps<'input'>,
  'value' | 'defaultValue' | 'maxLength' | 'type'
> & {
  length?: number
  value?: string
  defaultValue?: string
  activeIndex?: number
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const cellRefs = useRef<(HTMLSpanElement | null)[]>([])
  const [ownValue, setOwnValue] = useState(() =>
    toCode(defaultValue ?? '', length),
  )
  const code = toCode(value ?? ownValue, length)
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(0)

  // Puts the caret on cell `index`, at most the next empty one (or the end of
  // a full code): a filled cell's character is selected, so typing replaces
  // it.
  function moveTo(index: number) {
    const input = inputRef.current!
    const at = Math.max(0, Math.min(index, input.value.length))
    if (at < input.value.length) input.setSelectionRange(at, at + 1)
    else input.setSelectionRange(at, at)
    setCaret(at)
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const next = toCode(event.target.value, length)
    if (next !== event.target.value) event.target.value = next
    if (value === undefined) setOwnValue(next)
    onChange?.(event)
  }

  // Keeps the caret on a cell: a bare caret before a filled cell selects that
  // cell's character instead. A caret after a full code stays put, so typing
  // stops there.
  function handleSelect(event: SyntheticEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const start = input.selectionStart ?? 0
    const end = input.selectionEnd ?? 0
    if (start === end && start < input.value.length) moveTo(start)
    else setCaret(start)
    onSelect?.(event)
  }

  // The arrow keys step one cell at a time; natively they'd only collapse
  // the selection on a filled cell.
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.shiftKey || event.metaKey) return
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    moveTo((event.currentTarget.selectionStart ?? 0) + step)
  }

  // A click goes to the cell under the pointer, not to wherever the hidden
  // text's own glyphs put the caret.
  function handleClick(event: MouseEvent<HTMLInputElement>) {
    onClick?.(event)
    const index = cellRefs.current.findIndex(
      (cell) => cell && event.clientX < cell.getBoundingClientRect().right,
    )
    moveTo(index === -1 ? length : index)
  }

  // A caret after a full code is on its last cell.
  const active = focused ? Math.min(caret, length - 1) : activeIndex
  return (
    <div className={className ? `otp ${className}` : 'otp'}>
      <input
        ref={inputRef}
        className="otp-input"
        type="text"
        inputMode="text"
        autoComplete="one-time-code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        {...useFieldControl(props)}
        value={code}
        onChange={handleChange}
        onFocus={(event) => {
          setFocused(true)
          moveTo(event.currentTarget.value.length)
          onFocus?.(event)
        }}
        onBlur={(event) => {
          setFocused(false)
          onBlur?.(event)
        }}
        onSelect={handleSelect}
        onKeyDown={handleKeyDown}
        onClick={handleClick}
      />
      {Array.from({ length }, (_, index) => (
        <span
          key={index}
          ref={(cell) => {
            cellRefs.current[index] = cell
          }}
          className={
            index === active ? 'otp-cell otp-cell--active' : 'otp-cell'
          }
          aria-hidden="true"
        >
          {code[index]}
        </span>
      ))}
    </div>
  )
}
