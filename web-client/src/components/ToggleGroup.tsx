import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useField } from './fieldContext'

// What a ToggleGroup shares with its items.
type ToggleGroupContextValue = {
  selected: string | undefined
  // The item that's the group's one Tab stop when none is chosen.
  firstEnabled: string | undefined
  select: (value: string) => void
  disabled: boolean
}

const ToggleGroupContext = createContext<ToggleGroupContextValue | null>(null)

const nextKeys = ['ArrowRight', 'ArrowDown']
const previousKeys = ['ArrowLeft', 'ArrowUp']

// A row of ToggleGroupItems, one of which can be chosen: a `.toggle-group`
// with role radiogroup (styles/base.css), its items radios, as in the
// WAI-ARIA radio group pattern. It's one Tab stop, on the chosen item or,
// with none chosen, the first enabled one. The arrow keys move the focus and
// the choice to the next or previous enabled item, wrapping.
//
// `value`/`onValueChange` control the chosen value; `defaultValue` sets it
// otherwise. Once an item is chosen, one always is: pressing the chosen item
// keeps it, and onValueChange only fires when the value changes. `disabled`
// disables every item that doesn't say otherwise.
//
// Name it with `aria-label` or `aria-labelledby`. Inside a Field it's named
// by the Field's Label, described by its FieldHelp, and takes the field's
// disabled state, its own props winning.
export function ToggleGroup({
  value,
  defaultValue,
  onValueChange,
  disabled,
  className,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'ref' | 'defaultValue' | 'role'> & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  children: ReactNode
}) {
  const field = useField()
  const ref = useRef<HTMLDivElement>(null)
  const [uncontrolled, setUncontrolled] = useState(defaultValue)
  const [firstEnabled, setFirstEnabled] = useState<string>()
  const selected = value !== undefined ? value : uncontrolled
  const groupDisabled = disabled ?? field?.disabled ?? false
  // Which item is first enabled is only known from the rendered items,
  // which change with the children and the group's disabled state.
  useLayoutEffect(() => {
    const item = ref.current?.querySelector<HTMLButtonElement>(
      '[role="radio"]:not(:disabled)',
    )
    setFirstEnabled(item?.value)
  }, [children, groupDisabled])
  const group = {
    selected,
    firstEnabled,
    select: (next: string) => {
      if (next === selected) return
      if (value === undefined) setUncontrolled(next)
      onValueChange?.(next)
    },
    disabled: groupDisabled,
  }
  return (
    <ToggleGroupContext.Provider value={group}>
      <div
        ref={ref}
        role="radiogroup"
        aria-labelledby={field?.labelId}
        aria-describedby={field?.hasHelp ? field.helpId : undefined}
        className={className ? `toggle-group ${className}` : 'toggle-group'}
        {...props}
      >
        {children}
      </div>
    </ToggleGroupContext.Provider>
  )
}

// One item of a ToggleGroup: a `.toggle` <button> with role radio, labelled
// by its text (`children`). `disabled` overrides the group's.
export function ToggleGroupItem({
  value,
  disabled,
  className,
  ...props
}: Omit<
  ComponentProps<'button'>,
  'type' | 'role' | 'value' | 'tabIndex' | 'onClick' | 'onKeyDown'
> & {
  value: string
}) {
  const group = useContext(ToggleGroupContext)
  if (!group) throw new Error('A ToggleGroupItem must be inside a ToggleGroup.')
  const { select } = group
  const chosen = group.selected === value
  const tabStop =
    group.selected === undefined ? group.firstEnabled === value : chosen

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const step = nextKeys.includes(event.key)
      ? 1
      : previousKeys.includes(event.key)
        ? -1
        : 0
    if (step === 0) return
    event.preventDefault()
    const items = Array.from(
      event.currentTarget
        .closest('[role="radiogroup"]')!
        .querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'),
    )
    const index = items.indexOf(event.currentTarget)
    const target = items[(index + step + items.length) % items.length]
    target.focus()
    select(target.value)
  }

  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      value={value}
      tabIndex={tabStop ? 0 : -1}
      disabled={(disabled ?? group.disabled) || undefined}
      className={className ? `toggle ${className}` : 'toggle'}
      onClick={() => select(value)}
      onKeyDown={onKeyDown}
      {...props}
    />
  )
}
