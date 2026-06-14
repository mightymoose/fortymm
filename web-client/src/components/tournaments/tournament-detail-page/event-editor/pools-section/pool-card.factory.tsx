import { buildPool, buildTables } from '../../../data/seed.factory'
import type { PoolCardProps } from './pool-card'

/** Props for `PoolCard` — Pool A with four of six tables selected. */
export function buildPoolCardProps(
  overrides: Partial<PoolCardProps> = {},
): PoolCardProps {
  return {
    pool: buildPool(),
    tables: buildTables(6),
    onChange: () => {},
    onRemove: () => {},
    ...overrides,
  }
}
