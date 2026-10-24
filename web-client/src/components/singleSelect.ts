import { useRef, useState, type KeyboardEvent } from 'react'
import { useAnnounce } from './announceContext'

// The kinds of single-select group that kit.js runs (`data-select="single"`):
// a tablist's tabs, a radiogroup's radios, or plain buttons that stay
// pressed. Each kind marks the option that's on with its own attribute.
export type SingleSelectKind = 'tab' | 'radio' | 'pressed'

// The props that useSingleSelect() gives each option's <button>.
export type SingleSelectOptionProps = {
  ref: (button: HTMLButtonElement | null) => void
  onClick: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
  tabIndex?: number
  'aria-selected'?: boolean
  'aria-checked'?: boolean
  'aria-pressed'?: boolean
}

// The option that `key` moves a roving group to from option `index` of
// `count`: the arrows step and wrap, Home and End go to the ends. Null for
// any other key.
export function keyTarget(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

// A single-select group's state, as kit.js's FM.select keeps it: one option
// is always on, option `initial` (the first by default) to start with, and a
// click turns another on. Tabs
// and radios rove: only the option that's on is a tab stop, and the arrow
// keys, Home and End turn on another option and focus it. Pressed buttons
// are each a tab stop, and read out the option a click turns on.
// `optionProps(index)` gives the <button> of option `index` its state and
// handlers. `onChange` gets the label of the option turned on.
export function useSingleSelect(
  kind: SingleSelectKind,
  labels: readonly string[],
  onChange?: (label: string) => void,
  initial = 0,
): { selected: number; optionProps: (index: number) => SingleSelectOptionProps } {
  const [selected, setSelected] = useState(initial)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const announce = useAnnounce()

  const select = (index: number) => {
    setSelected(index)
    if (kind === 'pressed') announce(`${labels[index]}, selected`)
    onChange?.(labels[index])
  }

  const optionProps = (index: number): SingleSelectOptionProps => {
    const on = index === selected
    const props: SingleSelectOptionProps = {
      ref: (button) => {
        buttons.current[index] = button
      },
      onClick: () => select(index),
    }
    if (kind === 'pressed') return { ...props, 'aria-pressed': on }
    return {
      ...props,
      [kind === 'tab' ? 'aria-selected' : 'aria-checked']: on,
      tabIndex: on ? 0 : -1,
      onKeyDown: (event) => {
        const next = keyTarget(event.key, index, labels.length)
        if (next === null) return
        event.preventDefault()
        select(next)
        buttons.current[next]?.focus()
      },
    }
  }

  return { selected, optionProps }
}
