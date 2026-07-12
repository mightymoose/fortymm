import { buildEvent } from '../../data/seed.factory'
import type { BasicsSectionProps } from './basics-section'

/** Props for `BasicsSection` — the seeded Open Singles event, editable (the
 * creator's view). Pass `canEdit: false` for a viewer's read-only rendering. */
export function buildBasicsSectionProps(
  overrides: Partial<BasicsSectionProps> = {},
): BasicsSectionProps {
  return { event: buildEvent(), canEdit: true, onChange: () => {}, ...overrides }
}
