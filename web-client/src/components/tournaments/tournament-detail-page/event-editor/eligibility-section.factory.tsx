import { buildEvent } from '../../data/seed.factory'
import type { EligibilitySectionProps } from './eligibility-section'

/** Props for `EligibilitySection` — an open event (no rules) by default. */
export function buildEligibilitySectionProps(
  overrides: Partial<EligibilitySectionProps> = {},
): EligibilitySectionProps {
  return {
    event: buildEvent({ predicates: [] }),
    onChange: () => {},
    ...overrides,
  }
}
