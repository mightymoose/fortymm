import { buildEvent } from '../../data/seed.factory'
import type { EligibilitySectionProps } from './eligibility-section'

/** Props for `EligibilitySection` — an open event (no rules), editable (the
 * creator's view). Pass `canEdit: false` for a viewer's read-only rendering. */
export function buildEligibilitySectionProps(
  overrides: Partial<EligibilitySectionProps> = {},
): EligibilitySectionProps {
  return {
    event: buildEvent({ predicates: [] }),
    canEdit: true,
    onChange: () => {},
    ...overrides,
  }
}
