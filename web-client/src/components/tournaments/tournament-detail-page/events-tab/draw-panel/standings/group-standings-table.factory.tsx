import type { GroupStandingsView } from '../../../../data/standings'
import type { GroupStandingsTableProps } from './group-standings-table'
// The line factory and the three-row body belong to the table those rows are rendered by
// (`standings-table.factory`) — one definition, imported, rather than a second one here
// that happens to agree today. A group wrapper varies the group, not the standings.
import { buildStandingLines } from './standings-table.factory'

/** A complete three-player group, in the server's finishing order (`buildStandingLines`):
 * `player.1` (2–0) over `player.4` (1–1) over `player.5` (0–2). Returned in order, which
 * the table renders untouched (ADR-0788). */
export function buildGroupStandingsView(
  overrides: Partial<GroupStandingsView> = {},
): GroupStandingsView {
  return {
    groupId: 'grp-a',
    label: 'Group A',
    complete: true,
    rows: buildStandingLines(),
    ...overrides,
  }
}

/** Props for `GroupStandingsTable`. */
export function buildGroupStandingsTableProps(
  overrides: Partial<GroupStandingsTableProps> = {},
): GroupStandingsTableProps {
  return { group: buildGroupStandingsView(), ...overrides }
}
