import { poolSetFreeze, type EditFreeze } from '../../data/draw'
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
  /** Whether the event's pool SET may still change (ADR-0786) — derived from the event
   * by default, see below. */
  freeze: EditFreeze
  /** What is wrong with each pool's **name**, keyed by pool id (`poolNameIssues`).
   * `undefined` by default, because that is the state a card is normally in: the editor
   * says nothing in red until the organizer has actually tried to save. */
  nameIssues?: Record<string, string>
}

export function buildPoolsSectionProps(
  overrides: Partial<PoolsHarnessInputs> = {},
): PoolsHarnessInputs {
  // Derived from the event, exactly as the editor derives it (`event-editor.tsx`) —
  // never defaulted to `open`. Seed `buildDrawnEvent()` and the section is frozen here
  // for the same reason it is frozen in the app: the event has fixtures. A default of
  // `open` would let a test hand a cut draw to an unfrozen pools editor — a state the
  // app cannot produce — and then assert happily against it.
  const event = overrides.event ?? buildEvent()
  return {
    event,
    tables: buildTables(12),
    canEdit: true,
    freeze: poolSetFreeze(event),
    ...overrides,
  }
}
