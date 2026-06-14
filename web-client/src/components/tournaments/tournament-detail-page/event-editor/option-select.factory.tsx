import type { OptionSelectProps } from './option-select'

/** Props for `OptionSelect` — a three-option format picker. */
export function buildOptionSelectProps(
  overrides: Partial<OptionSelectProps> = {},
): OptionSelectProps {
  return {
    value: 'singles',
    options: [
      { value: 'singles', label: 'Singles' },
      { value: 'doubles', label: 'Doubles' },
      { value: 'teams', label: 'Teams' },
    ],
    onChange: () => {},
    ariaLabel: 'Format',
    ...overrides,
  }
}
