import { type ReactNode } from 'react'
import { useRadioGroup } from 'react-aria'
import { useRadioGroupState } from 'react-stately'
import { RadioGroupContext } from './RadioGroupContext.ts'

// Pick one of a few choices: React Aria's useRadioGroup on kit.css's own markup, a fieldset
// (fm-choices) named by its legend. Holds Radios; arrow keys move between them.
export function RadioGroup({
  label,
  defaultValue,
  onChange,
  isDisabled,
  children,
}: {
  label: string
  defaultValue?: string
  onChange?: (value: string) => void
  isDisabled?: boolean
  children: ReactNode
}) {
  const state = useRadioGroupState({ label, defaultValue, onChange, isDisabled })
  const { radioGroupProps, labelProps } = useRadioGroup({ label, isDisabled }, state)
  return (
    <fieldset {...radioGroupProps} className="fm-choices">
      <legend {...labelProps}>{label}</legend>
      <RadioGroupContext value={state}>{children}</RadioGroupContext>
    </fieldset>
  )
}
