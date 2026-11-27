import { Input, TextField as AriaTextField } from 'react-aria-components'
import { FieldLabel } from './FieldLabel.tsx'
import { FieldMessage } from './FieldMessage.tsx'

// A one-line text field: React Aria's TextField drawn with kit.css's fm-field, label above and
// help or error below (see FieldMessage). An invalid field keeps its red edge, icon and error
// while focused. isNumeric is for numbers: tabular figures and a number keypad.
export function TextField({
  label,
  description,
  errorMessage,
  isOptional,
  isInvalid,
  isDisabled,
  isNumeric,
  placeholder,
  defaultValue,
}: {
  label: string
  description?: string
  errorMessage?: string
  isOptional?: boolean
  isInvalid?: boolean
  isDisabled?: boolean
  isNumeric?: boolean
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
      <Input
        className={isNumeric ? 'fm-input fm-input--num' : 'fm-input'}
        inputMode={isNumeric ? 'numeric' : undefined}
        placeholder={placeholder}
      />
      <FieldMessage description={description} errorMessage={errorMessage} isInvalid={isInvalid} />
    </AriaTextField>
  )
}
