import { type ReactNode, useRef } from 'react'
import { useCheckbox } from 'react-aria'
import { useToggleState } from 'react-stately'

// A checkbox: React Aria's useCheckbox on kit.css's own markup, a native checkbox inside its label
// (fm-check), so kit.css draws the box on the input itself. isIndeterminate is for a checkbox that
// stands for several others when only some are checked, e.g. "All players (12 of 16)".
export function Checkbox({
  isIndeterminate,
  isDisabled,
  defaultSelected,
  onChange,
  children,
}: {
  isIndeterminate?: boolean
  isDisabled?: boolean
  defaultSelected?: boolean
  onChange?: (isSelected: boolean) => void
  children: ReactNode
}) {
  const props = { isIndeterminate, isDisabled, defaultSelected, onChange, children }
  const state = useToggleState(props)
  const ref = useRef<HTMLInputElement>(null)
  const { labelProps, inputProps } = useCheckbox(props, state, ref)
  return (
    <label {...labelProps} className="fm-check">
      <input {...inputProps} ref={ref} />
      {children}
    </label>
  )
}
