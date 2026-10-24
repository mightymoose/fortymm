import type { ReactNode } from 'react'
import { Icon } from './Icon'

// A field's error, styled by `.fm-error` in styles/kit.css: an icon and a
// sentence that says how to fix it. Give the field `aria-invalid` and
// describe it by this error's `id`.
export function FieldError({
  id,
  hidden,
  children,
}: {
  id: string
  hidden?: boolean
  children: ReactNode
}) {
  return (
    <p className="fm-error" id={id} hidden={hidden}>
      <Icon name="error" />
      <span>{children}</span>
    </p>
  )
}
