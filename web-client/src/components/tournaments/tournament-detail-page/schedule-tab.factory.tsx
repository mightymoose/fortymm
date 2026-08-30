import {
  buildDrawnEvent,
  buildTables,
  buildTournament,
} from '../data/seed.factory'
import type { ScheduleTabProps } from './schedule-tab'

/** Props for `ScheduleTab` — a tournament with a cut draw (real fixtures, all awaiting a
 * placement by default) plus the full table catalogue the placements resolve against. A
 * test that wants placed matches overrides the events' fixtures with `tableId` /
 * `scheduledStart` set. */
export function buildScheduleTabProps(
  overrides: Partial<ScheduleTabProps> = {},
): ScheduleTabProps {
  return {
    tournament: buildTournament({ events: [buildDrawnEvent()] }),
    tournamentDetailUpdatedAt: 1,
    tables: buildTables(),
    ...overrides,
  }
}
