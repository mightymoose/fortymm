import { drawTypeFreeze } from '../../data/draw'
import { buildEvent } from '../../data/seed.factory'
import type { BasicsSectionProps } from './basics-section'

/** Props for `BasicsSection` — the seeded Open Singles event, editable (the
 * creator's view). Pass `canEdit: false` for a viewer's read-only rendering.
 *
 * `drawTypeFreeze` is **derived from the event**, exactly as the editor derives it
 * (`event-editor.tsx`), rather than defaulting to `open`: seed an event whose draw is
 * cut (`buildDrawnEvent`) and its draw type is frozen here too, with no second prop to
 * remember. A fixture that could hand a drawn event to an unfrozen control would seed a
 * state the app never produces — and a test written against it would prove nothing. */
export function buildBasicsSectionProps(
  overrides: Partial<BasicsSectionProps> = {},
): BasicsSectionProps {
  const event = overrides.event ?? buildEvent()
  return {
    event,
    canEdit: true,
    drawTypeFreeze: drawTypeFreeze(event),
    onChange: () => {},
    ...overrides,
  }
}
