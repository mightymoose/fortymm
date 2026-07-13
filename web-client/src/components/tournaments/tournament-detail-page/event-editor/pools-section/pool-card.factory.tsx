import { buildPool, buildTables } from '../../../data/seed.factory'
import type { PoolCardProps } from './pool-card'

/** Props for `PoolCard` — Pool A with four of six tables selected, editable (the
 * creator's view), and removable. Pass `canEdit: false` for a viewer's read-only
 * rendering, or `removal: { kind: 'frozen', reasonId }` for a pool whose event has a
 * cut draw (ADR-0786): the trash button dies, and *nothing else does*. */
export function buildPoolCardProps(
  overrides: Partial<PoolCardProps> = {},
): PoolCardProps {
  return {
    pool: buildPool(),
    tables: buildTables(6),
    canEdit: true,
    removal: { kind: 'allowed' },
    onChange: () => {},
    onRemove: () => {},
    ...overrides,
  }
}
