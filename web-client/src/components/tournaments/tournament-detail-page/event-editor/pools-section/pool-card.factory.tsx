import { buildPool, buildTables } from '../../../data/seed.factory'
import type { PoolCardProps } from './pool-card'

/** Props for `PoolCard` — Pool A with four of six tables selected, editable (the
 * creator's view). Pass `canEdit: false` for a viewer's read-only rendering. */
export function buildPoolCardProps(
  overrides: Partial<PoolCardProps> = {},
): PoolCardProps {
  return {
    pool: buildPool(),
    tables: buildTables(6),
    canEdit: true,
    onChange: () => {},
    onRemove: () => {},
    ...overrides,
  }
}
