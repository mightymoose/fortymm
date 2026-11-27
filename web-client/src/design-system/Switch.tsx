import { type ReactNode } from 'react'
import { Button as AriaButton } from 'react-aria-components'
import { useToggleState } from 'react-stately'

// A setting that takes effect immediately and stays; never for filtering or changing views. Drawn
// as kit.css's fm-switch, a button with role="switch", so it is React Aria's Button (press, hover
// and focus handling) holding toggle state, rather than useSwitch, which needs an input.
export function Switch({
  isDisabled,
  defaultSelected,
  onChange,
  children,
}: {
  isDisabled?: boolean
  defaultSelected?: boolean
  onChange?: (isSelected: boolean) => void
  children: ReactNode
}) {
  const state = useToggleState({ defaultSelected, onChange })
  return (
    <AriaButton
      className="fm-switch"
      isDisabled={isDisabled}
      onPress={state.toggle}
      render={(props) => <button {...props} role="switch" aria-checked={state.isSelected} />}
    >
      <span className="fm-switch__track" />
      {children}
    </AriaButton>
  )
}
