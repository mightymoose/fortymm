import { Input } from '@/components/ui/input'

import type { FieldProps } from './field'

/** Props for `Field` — a required "Name" row wrapping a plain text input. */
export function buildFieldProps(overrides: Partial<FieldProps> = {}): FieldProps {
  return {
    label: 'Name',
    required: true,
    children: (id) => <Input id={id} defaultValue="" />,
    ...overrides,
  }
}
