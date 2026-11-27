import { TextArea as AriaTextArea, TextField as AriaTextField } from 'react-aria-components'
import { FieldLabel } from './FieldLabel.tsx'
import { FieldMessage } from './FieldMessage.tsx'

// A multi-line text field: a TextField (see TextField.tsx) whose control is a textarea
// (fm-textarea), at least four lines tall and resizable in height.
export function TextArea({
  label,
  description,
  errorMessage,
  isOptional,
  isInvalid,
  isDisabled,
  placeholder,
  defaultValue,
}: {
  label: string
  description?: string
  errorMessage?: string
  isOptional?: boolean
  isInvalid?: boolean
  isDisabled?: boolean
  placeholder?: string
  defaultValue?: string
}) {
  return (
    <AriaTextField
      className="fm-field"
      isInvalid={isInvalid}
      isDisabled={isDisabled}
      defaultValue={defaultValue}
    >
      <FieldLabel label={label} isOptional={isOptional} />
      <AriaTextArea className="fm-textarea" placeholder={placeholder} />
      <FieldMessage description={description} errorMessage={errorMessage} isInvalid={isInvalid} />
    </AriaTextField>
  )
}
