import { createContext, useContext } from 'react'

// What a Field shares with its parts: the ids that tie the label, control and
// help text together, and the field's state.
export type FieldContextValue = {
  controlId: string
  // The Label's id, for a control that can't be named by `<label for>`
  // (e.g. a RadioGroup, named with aria-labelledby).
  labelId: string
  helpId: string
  // Whether a FieldHelp is rendered, so the control is only described by
  // help text that exists.
  hasHelp: boolean
  setHasHelp: (hasHelp: boolean) => void
  invalid: boolean
  required: boolean
  disabled: boolean
}

export const FieldContext = createContext<FieldContextValue | null>(null)

export function useField(): FieldContextValue | null {
  return useContext(FieldContext)
}

type ControlProps = {
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling'
  required?: boolean
  disabled?: boolean
}

// Merges the enclosing Field's wiring (id, description, invalid, required,
// disabled) into a form control's props, with the control's own props
// winning. Outside a Field the props come back as they are.
export function useFieldControl<P extends ControlProps>(props: P): P {
  const field = useField()
  if (!field) return props
  return {
    id: field.controlId,
    'aria-describedby': field.hasHelp ? field.helpId : undefined,
    'aria-invalid': field.invalid || undefined,
    required: field.required || undefined,
    disabled: field.disabled || undefined,
    ...props,
  }
}
