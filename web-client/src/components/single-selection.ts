import { useRef, useState, type KeyboardEvent } from 'react'

// One option of a single-select group (Tabs, SegmentedControl).
export type SelectableOption = { value: string; disabled?: boolean }

// What tabs and a segmented control share, as the design system's kit.js
// does it: one option is selected; clicking an option selects it; the group
// is one stop in the tab order (the selected option, or the first enabled one
// when none is), and inside it the arrow keys move to the next or previous
// enabled option, wrapping, Home and End to the first and last, selecting
// the option they land on.
export function useSingleSelection<Option extends SelectableOption>({
  options,
  defaultValue,
  onChange,
}: {
  options: Option[]
  defaultValue?: string
  onChange?: (value: string) => void
}) {
  const [selected, setSelected] = useState<string | undefined>(defaultValue)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const enabled = options.filter((option) => !option.disabled)
  const tabStop = enabled.some((option) => option.value === selected)
    ? selected
    : enabled[0]?.value

  function select(value: string) {
    setSelected(value)
    if (value !== selected) onChange?.(value)
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>, value: string) {
    const at = enabled.findIndex((option) => option.value === value)
    const next = {
      ArrowRight: enabled[(at + 1) % enabled.length],
      ArrowDown: enabled[(at + 1) % enabled.length],
      ArrowLeft: enabled[(at - 1 + enabled.length) % enabled.length],
      ArrowUp: enabled[(at - 1 + enabled.length) % enabled.length],
      Home: enabled[0],
      End: enabled[enabled.length - 1],
    }[event.key]
    if (at < 0 || !next) return
    event.preventDefault()
    select(next.value)
    buttons.current.get(next.value)?.focus()
  }

  // The props each option's button takes.
  function optionProps(option: Option) {
    return {
      ref: (button: HTMLButtonElement | null) => {
        if (button) buttons.current.set(option.value, button)
        else buttons.current.delete(option.value)
      },
      tabIndex: option.value === tabStop ? 0 : -1,
      disabled: option.disabled,
      onClick: () => select(option.value),
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
        keyDown(event, option.value),
    }
  }

  return { selected, optionProps }
}
