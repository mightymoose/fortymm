import type { EmptyCardProps } from './empty-card'

/** Props for `EmptyCard` — the "not in a rated league yet" rating placeholder. */
export function buildEmptyCardProps(
  overrides: Partial<EmptyCardProps> = {},
): EmptyCardProps {
  return {
    overline: 'Current rating',
    body: 'Not in a rated league yet.',
    ...overrides,
  }
}
