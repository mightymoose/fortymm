import { buildEvent, buildTables } from '../../data/seed.factory'
import type { TournamentEvent, TournamentTable } from '../../data/types'

/** Harness inputs for `PoolsSection` — the section now drives a `useFieldArray`
 * off the editor's form, so the test wraps it in a form seeded from this
 * `event` (see `pools-section.page`). The seeded one-pool event with 12 tables,
 * editable (the creator's view). Pass `canEdit: false` for a viewer's read-only
 * list. */
export interface PoolsHarnessInputs {
  event: TournamentEvent
  tables: TournamentTable[]
  canEdit: boolean
}

export function buildPoolsSectionProps(
  overrides: Partial<PoolsHarnessInputs> = {},
): PoolsHarnessInputs {
  return {
    event: buildEvent(),
    tables: buildTables(12),
    canEdit: true,
    ...overrides,
  }
}
