import { buildEvent } from '../../data/seed.factory'
import type { BasicsSectionProps } from './basics-section'

/** Props for `BasicsSection` — the seeded Open Singles event. */
export function buildBasicsSectionProps(
  overrides: Partial<BasicsSectionProps> = {},
): BasicsSectionProps {
  return { event: buildEvent(), onChange: () => {}, ...overrides }
}
