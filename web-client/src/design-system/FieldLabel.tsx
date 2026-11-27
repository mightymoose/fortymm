import { Label } from 'react-aria-components'

// A field's label (fm-label), above its control. An optional field says so after the label, in
// the label's quieter style, so it is read out as part of the field's name.
export function FieldLabel({ label, isOptional }: { label: string; isOptional?: boolean }) {
  return (
    <Label className="fm-label">
      {label}
      {isOptional && (
        <>
          {' '}
          <span className="opt">(optional)</span>
        </>
      )}
    </Label>
  )
}
