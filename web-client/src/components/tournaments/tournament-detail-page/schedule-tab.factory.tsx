import { buildTournament } from '../data/seed.factory'
import type { ScheduleTabProps } from './schedule-tab'

/** Props for `ScheduleTab` — the seeded tournament with one scheduled pool. */
export function buildScheduleTabProps(
  overrides: Partial<ScheduleTabProps> = {},
): ScheduleTabProps {
  return { tournament: buildTournament(), ...overrides }
}
