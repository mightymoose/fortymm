import { type ReactNode, use, useRef } from 'react'
import { useRadio } from 'react-aria'
import { RadioGroupContext } from './RadioGroupContext.ts'

// One choice in a RadioGroup: React Aria's useRadio on kit.css's own markup, a native radio inside
// its label (fm-radio).
export function Radio({
  value,
  isDisabled,
  children,
}: {
  value: string
  isDisabled?: boolean
  children: ReactNode
}) {
  const state = use(RadioGroupContext)
  if (!state) throw new Error('A Radio must be inside a RadioGroup')
  const ref = useRef<HTMLInputElement>(null)
  const { labelProps, inputProps } = useRadio({ value, isDisabled, children }, state, ref)
  return (
    <label {...labelProps} className="fm-radio">
      <input {...inputProps} ref={ref} />
      {children}
    </label>
  )
}
