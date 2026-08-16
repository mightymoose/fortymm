import type { UnscheduledFixture } from '../../data/timeline'
import type { UnscheduledRailProps } from './unscheduled-rail'

/** One wholly-unplaced fixture — no table, no time, no match yet. */
export function buildUnscheduledFixture(
  overrides: Partial<UnscheduledFixture> = {},
): UnscheduledFixture {
  return {
    fixtureId: 'fx-b-1',
    eventName: 'U1200 Singles',
    groupLabel: 'Group B',
    label: 'player.2 vs player.3',
    tableLabel: null,
    statusLabel: 'Not started',
    ...overrides,
  }
}

/** Props for `UnscheduledRail` — a single unplaced fixture (the ordinary
 * pre-solve state). Pass `items: []` for the everything-placed case, which
 * renders nothing. */
export function buildUnscheduledRailProps(
  overrides: Partial<UnscheduledRailProps> = {},
): UnscheduledRailProps {
  return { items: [buildUnscheduledFixture()], ...overrides }
}
