import { buildTables, buildTournament } from '../data/seed.factory'
import type { TablesTabProps } from './tables-tab'

/** Props for `TablesTab` — a tournament with 8 of 12 tables assigned. */
export function buildTablesTabProps(
  overrides: Partial<TablesTabProps> = {},
): TablesTabProps {
  return {
    tournament: buildTournament({
      tableIds: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
    }),
    allTables: buildTables(12),
    onUpdate: () => {},
    ...overrides,
  }
}
