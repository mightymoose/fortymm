import { buildEvent, buildTables } from '../../data/seed.factory'
import type { PoolsSectionProps } from './pools-section'

/** Props for `PoolsSection` — the seeded one-pool event with 12 tables. */
export function buildPoolsSectionProps(
  overrides: Partial<PoolsSectionProps> = {},
): PoolsSectionProps {
  return {
    event: buildEvent(),
    tables: buildTables(12),
    onChange: () => {},
    ...overrides,
  }
}
