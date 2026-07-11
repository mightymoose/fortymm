import type { ReactNode } from 'react'

import { Input } from '@/components/ui/input'

import type { FieldBase, FieldProps } from './field'
import type { ReadOnlyValueContent } from './read-only-value'

/** Overrides for `buildFieldProps`. Flat, unlike `FieldProps` itself: a test may
 * name `readOnly` and `value` independently, and the factory reassembles them
 * into the union the component demands. */
export type FieldOverrides = Partial<FieldBase> & {
  readOnly?: boolean
  value?: ReadOnlyValueContent
  valueClassName?: string
  children?: (controlId: string) => ReactNode
}

/** Props for `Field` — a required "Name" row wrapping a plain text input.
 * Naming `readOnly` puts the row in the read-only-capable branch, where the
 * component requires a `value`; omitting it keeps the row an editor. */
export function buildFieldProps(overrides: FieldOverrides = {}): FieldProps {
  const { readOnly, value, valueClassName, ...rest } = overrides
  const editor = {
    label: 'Name',
    required: true,
    children: (id: string) => <Input id={id} defaultValue="" />,
    ...rest,
  }
  return readOnly === undefined
    ? editor
    : { ...editor, readOnly, value: value ?? null, valueClassName }
}
