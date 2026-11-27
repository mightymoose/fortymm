import { Text } from 'react-aria-components'
import { Icon } from './Icon.tsx'

// The sentence below a field's control, which describes it: the error (fm-error, with an icon)
// when the field is invalid, otherwise the help (fm-help), if any. An error says how to fix it.
export function FieldMessage({
  description,
  errorMessage,
  isInvalid,
}: {
  description?: string
  errorMessage?: string
  isInvalid?: boolean
}) {
  if (isInvalid && errorMessage) {
    return (
      <Text slot="errorMessage" elementType="p" className="fm-error">
        <Icon name="circle-alert" />
        <span>{errorMessage}</span>
      </Text>
    )
  }
  if (description) {
    return (
      <Text slot="description" elementType="p" className="fm-help">
        {description}
      </Text>
    )
  }
  return null
}
