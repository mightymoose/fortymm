import type { ReadOnlyValueProps } from './read-only-value'

/** Props for `ReadOnlyValue` — a set value, as a viewer sees a field the
 * organizer filled in. */
export function buildReadOnlyValueProps(
  overrides: Partial<ReadOnlyValueProps> = {},
): ReadOnlyValueProps {
  return {
    children: 'Open Singles',
    ...overrides,
  }
}
