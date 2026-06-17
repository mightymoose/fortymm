import { buildTables, buildTournament } from '../data/seed.factory'
import type { TablesTabProps } from './tables-tab'

/** Props for `TablesTab` — a tournament whose catalogue holds eight tables. */
export function buildTablesTabProps(
  overrides: Partial<TablesTabProps> = {},
): TablesTabProps {
  const catalogue = overrides.catalogue ?? buildTables(8)
  return {
    tournament: buildTournament({ tableIds: catalogue.map((t) => t.id) }),
    catalogue,
    canEdit: true,
    onChangeCatalogue: () => {},
    ...overrides,
  }
}
