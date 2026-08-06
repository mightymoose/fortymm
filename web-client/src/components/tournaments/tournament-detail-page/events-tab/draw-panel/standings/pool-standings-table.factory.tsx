import type { PoolStandingsView } from '../../../../data/standings'
import type { PoolStandingsTableProps } from './pool-standings-table'
// The line factory and the three-row body belong to the table those rows are rendered by
// (`standings-table.factory`) — one definition, imported, rather than a second one here
// that happens to agree today. A pool wrapper varies the pool, not the standings.
import { buildStandingLines } from './standings-table.factory'

/** A complete three-player pool, in the server's finishing order (`buildStandingLines`):
 * `player.1` (2–0) over `player.4` (1–1) over `player.5` (0–2). Returned in order, which
 * the table renders untouched (ADR-0788). */
export function buildPoolStandingsView(
  overrides: Partial<PoolStandingsView> = {},
): PoolStandingsView {
  return {
    poolId: 'p-a',
    name: 'Pool A',
    complete: true,
    rows: buildStandingLines(),
    ...overrides,
  }
}

/** Props for `PoolStandingsTable`. */
export function buildPoolStandingsTableProps(
  overrides: Partial<PoolStandingsTableProps> = {},
): PoolStandingsTableProps {
  return { pool: buildPoolStandingsView(), ...overrides }
}
