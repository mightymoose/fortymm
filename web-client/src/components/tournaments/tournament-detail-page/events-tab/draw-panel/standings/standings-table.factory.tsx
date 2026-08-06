import { buildStandingRow } from '../../../../data/seed.factory'
import type { StandingLine } from '../../../../data/standings'
import type { StandingsTableProps } from './standings-table'

/** One standings line, ready to render — a `StandingRow` with the username already joined
 * on (`data/standings`, `data/swiss-standings`). Defaults to `entry-1`, 1st, a clean 2–0. */
export function buildStandingLine(
  overrides: Partial<StandingLine> = {},
): StandingLine {
  return { ...buildStandingRow(), name: 'player.1', ...overrides }
}

/**
 * Three standings lines in finishing order — `player.1` (2–0) over `player.4` (1–1) over
 * `player.5` (0–2) — whose ranks, wins and game differences all descend together, so a
 * component that dropped a column or re-sorted a row shows a visibly different table.
 *
 * The middle row's difference is `0` and the last one's is **negative**, deliberately: the
 * sign is load-bearing (`+3`, `0`, `-3`), and a body of all-positive figures could not prove
 * it is rendered.
 *
 * The one body, for the shared table and for the pool that wraps it
 * (`pool-standings-table.factory`) — two copies of these nine figures would be two fixtures
 * free to disagree about what "a pool" looks like.
 */
export function buildStandingLines(): StandingLine[] {
  return [
    buildStandingLine({
      entryId: 'entry-1',
      name: 'player.1',
      rank: 1,
      wins: 2,
      losses: 0,
      gamesWon: 4,
      gamesLost: 1,
      gameDifference: 3,
    }),
    buildStandingLine({
      entryId: 'entry-4',
      name: 'player.4',
      rank: 2,
      wins: 1,
      losses: 1,
      gamesWon: 3,
      gamesLost: 3,
      gameDifference: 0,
    }),
    buildStandingLine({
      entryId: 'entry-5',
      name: 'player.5',
      rank: 3,
      wins: 0,
      losses: 2,
      gamesWon: 1,
      gamesLost: 4,
      gameDifference: -3,
    }),
  ]
}

/** Props for `StandingsTable`: the three-deep body above, named as a pool's table. */
export function buildStandingsTableProps(
  overrides: Partial<StandingsTableProps> = {},
): StandingsTableProps {
  return {
    ariaLabel: 'Standings for Pool A',
    rows: buildStandingLines(),
    ...overrides,
  }
}
