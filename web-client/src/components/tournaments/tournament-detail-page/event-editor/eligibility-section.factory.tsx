import { buildEvent } from '../../data/seed.factory'
import type { TournamentEvent } from '../../data/types'

/** Harness inputs for `EligibilitySection` — the section now drives a
 * `useFieldArray` off the editor's form, so the test wraps it in a form seeded
 * from this `event` (see `eligibility-section.page`). An open event (no rules),
 * editable (the creator's view). Pass `canEdit: false` for a viewer's read-only
 * rendering. */
export interface EligibilityHarnessInputs {
  event: TournamentEvent
  canEdit: boolean
}

export function buildEligibilitySectionProps(
  overrides: Partial<EligibilityHarnessInputs> = {},
): EligibilityHarnessInputs {
  return {
    event: buildEvent({ predicates: [] }),
    canEdit: true,
    ...overrides,
  }
}
