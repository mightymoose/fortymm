import { groupSetFreeze, type EditFreeze } from '../../data/draw'
import { buildEvent, buildTables } from '../../data/seed.factory'
import type { DrawType, TournamentEvent, TournamentTable } from '../../data/types'

/** Harness inputs for `ReservationsSection` — the section now drives a
 * `useFieldArray` off the editor's form, so the test wraps it in a form seeded from
 * this `event` (see `reservations-section.page`). The seeded one-reservation event
 * with 12 tables, editable (the creator's view). Pass `canEdit: false` for a viewer's
 * read-only list. */
export interface ReservationsHarnessInputs {
  event: TournamentEvent
  tables: TournamentTable[]
  canEdit: boolean
  /** Whether the event's group SET may still change (ADR-0786) — derived from the event
   * by default, see below. */
  freeze: EditFreeze
  /** What is wrong with each reservation's **name**, keyed by reservation id
   * (`reservationNameIssues`). `undefined` by default, because that is the state a card
   * is normally in: the editor says nothing in red until the organizer has actually
   * tried to save. */
  nameIssues?: Record<string, string>
  /** What is wrong with each reservation's **window**, keyed by reservation id
   * (`reservationWindowIssues`). `undefined` by default, for the same reason
   * `nameIssues` is: the editor says nothing in red until the organizer has tried to
   * save. */
  windowIssues?: Record<string, string>
  /** Seeds the FORM's `drawType` at a value that DIVERGES from `event.drawType` —
   * #1482's reservation cap reads the form's watched draw type, never the stored
   * event's, and this is how a test proves that without driving a live Basics-tab
   * pick: the harness's form starts here instead of at `event.drawType`, the way a
   * director's in-progress (unsaved) type flip would leave it. `undefined` leaves the
   * form seeded from `event` exactly as before. */
  formDrawType?: DrawType
}

export function buildReservationsSectionProps(
  overrides: Partial<ReservationsHarnessInputs> = {},
): ReservationsHarnessInputs {
  // Derived from the event, exactly as the editor derives it (`event-editor.tsx`) —
  // never defaulted to `open`. Seed `buildDrawnEvent()` and the section is frozen here
  // for the same reason it is frozen in the app: the event has fixtures. A default of
  // `open` would let a test hand a cut draw to an unfrozen reservations editor — a state
  // the app cannot produce — and then assert happily against it.
  const event = overrides.event ?? buildEvent()
  return {
    event,
    tables: buildTables(12),
    canEdit: true,
    freeze: groupSetFreeze(event),
    ...overrides,
  }
}
