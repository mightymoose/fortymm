import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { useField } from './fieldContext'

// What a RadioGroup shares with its Radios.
type RadioGroupContextValue = {
  name: string
  selected: string | undefined
  select: (value: string) => void
  invalid: boolean
  required: boolean
  disabled: boolean
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null)

// A group of Radios, one of which can be selected: a `.radio-group` with role
// radiogroup (styles/base.css). Its Radios share a `name` (generated if none
// is given), so the browser makes them mutually exclusive, moves the
// selection with the arrow keys and makes the group one Tab stop.
//
// `value`/`onChange` control the selected value; `defaultValue` sets it
// otherwise. `required` makes every Radio required, as the browser treats
// the whole group, and `aria-invalid` goes on every Radio, where it's
// announced and drawn. `disabled` disables every Radio that doesn't say
// otherwise.
//
// Name it with `aria-label` or `aria-labelledby`. Inside a Field it's named
// by the Field's Label, described by its FieldHelp, and takes the field's
// invalid, required and disabled state, its own props winning.
export function RadioGroup({
  name,
  value,
  defaultValue,
  onChange,
  required,
  disabled,
  'aria-invalid': ariaInvalid,
  className,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'onChange' | 'defaultValue'> & {
  name?: string
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  required?: boolean
  disabled?: boolean
  children: ReactNode
}) {
  const field = useField()
  const generatedName = useId()
  const [uncontrolled, setUncontrolled] = useState(defaultValue)
  const selected = value !== undefined ? value : uncontrolled
  const group = {
    name: name ?? generatedName,
    selected,
    select: (next: string) => {
      if (value === undefined) setUncontrolled(next)
      onChange?.(next)
    },
    invalid:
      ariaInvalid !== undefined
        ? ariaInvalid === true || ariaInvalid === 'true'
        : (field?.invalid ?? false),
    required: required ?? field?.required ?? false,
    disabled: disabled ?? field?.disabled ?? false,
  }
  return (
    <RadioGroupContext.Provider value={group}>
      <div
        role="radiogroup"
        aria-labelledby={field?.labelId}
        aria-describedby={field?.hasHelp ? field.helpId : undefined}
        className={className ? `radio-group ${className}` : 'radio-group'}
        {...props}
      >
        {children}
      </div>
    </RadioGroupContext.Provider>
  )
}

// One option of a RadioGroup, with its label: a real <input type="radio">,
// visually hidden, and a `.radio-dot` after it that draws its state, all
// inside a <label> with the label text (`children`). Styled by `.radio` in
// styles/base.css. `disabled` overrides the group's.
export function Radio({
  value,
  disabled,
  className,
  children,
  ...props
}: Omit<
  ComponentProps<'input'>,
  'type' | 'name' | 'value' | 'checked' | 'defaultChecked' | 'onChange'
> & {
  value: string
  children: ReactNode
}) {
  const group = useContext(RadioGroupContext)
  if (!group) throw new Error('A Radio must be inside a RadioGroup.')
  return (
    <label className={className ? `radio ${className}` : 'radio'}>
      <input
        className="radio-input visually-hidden"
        type="radio"
        name={group.name}
        value={value}
        checked={group.selected === value}
        onChange={() => group.select(value)}
        aria-invalid={group.invalid || undefined}
        required={group.required || undefined}
        disabled={(disabled ?? group.disabled) || undefined}
        {...props}
      />
      <span className="radio-dot" aria-hidden="true" />
      {children}
    </label>
  )
}
