import type { FormChipsProps } from './form-chips'
import type { FormChipsView } from '../rating-panel-query'

/** Ten results, newest first — the profile's full form window. */
export function buildFormChipsView(
  overrides: Partial<FormChipsView> = {},
): FormChipsView {
  const results = overrides.results ?? [
    'W',
    'W',
    'L',
    'W',
    'L',
    'L',
    'W',
    'W',
    'L',
    'W',
  ]
  return {
    results,
    label: `Last ${results.length}: ${results.join(' ')}`,
    ...overrides,
  }
}

/** Props for `FormChips`. */
export function buildFormChipsProps(
  overrides: Partial<FormChipsProps> = {},
): FormChipsProps {
  return { form: buildFormChipsView(), ...overrides }
}
