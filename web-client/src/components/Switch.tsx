import { useState, type ComponentProps } from 'react'

// A setting that applies at once, styled by `.fm-switch` in styles/kit.css:
// a button with the switch role, whose fill and knob show whether it's on.
// A click turns it over and calls `onChange` with its new state. Never use
// one to filter a list.
export function Switch({
  defaultChecked = false,
  onChange,
  children,
  ...props
}: Omit<ComponentProps<'button'>, 'onChange' | 'role'> & {
  defaultChecked?: boolean
  onChange?: (checked: boolean) => void
}) {
  const [checked, setChecked] = useState(defaultChecked)
  return (
    <button
      type="button"
      className="fm-switch"
      role="switch"
      aria-checked={checked}
      onClick={() => {
        setChecked(!checked)
        onChange?.(!checked)
      }}
      {...props}
    >
      <span className="fm-switch__track"></span>
      {children}
    </button>
  )
}
