import {
  buildStandingRow,
  buildSwissStandingRow,
} from '../../../../data/seed.factory'
import type { StandingLine } from '../../../../data/standings'
import type { SwissStandingLine } from '../../../../data/swiss-standings'
import type { StandingsTableProps } from './standings-table'

/** One standings line, ready to render — a `StandingRow` with the username already joined
 * on (`data/standings`, `data/swiss-standings`). Defaults to `entry-1`, 1st, a clean 2–0. */
export function buildStandingLine(
  overrides: Partial<StandingLine> = {},
): StandingLine {
  return { ...buildStandingRow(), name: 'player.1', ...overrides }
}

/** One **swiss** standings line: the same, plus the `buchholz` figure that ordered it. */
export function buildSwissStandingLine(
  overrides: Partial<SwissStandingLine> = {},
): SwissStandingLine {
  return { ...buildSwissStandingRow(), name: 'player.1', ...overrides }
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
 * The one body, for the shared table (**both** arms below), and for the pool that wraps it
 * (`pool-standings-table.factory`) — copies of these nine figures would be fixtures free to
 * disagree about what "a pool" looks like, and a swiss table that differed from a pool one
 * by more than its Buchholz column would stop proving the two share a component.
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

/**
 * The three rows' Buchholz figures, in the same order.
 *
 * ⚠️ **8, 6, 7** — deliberately NOT descending with the rank, and deliberately colliding
 * with none of the other columns (wins 2/1/0, difference +3/0/−3, games won 4/3/1). A
 * Buchholz column reading the wrong field, or a fixture whose figures happened to march down
 * the table with everything else, could not be told from a correct one. Out of order is also
 * honest: Buchholz is the step *below* wins, so within a tier it is what decides — across
 * tiers it has no reason to be monotonic at all.
 */
const BUCHHOLZ = [8, 6, 7]

/** **Two builders, one per arm of `StandingsTableRows`** — the union cannot be built by one
 * `Partial<>`, and it should not be: which table this is decides which columns it has, so a
 * test picks the arm it means rather than half-specifying one. */

/** Props for a **pool** `StandingsTable` — the three-deep body above, named as a pool's
 * table, and no Buchholz column, because every entrant in a pool faces the same
 * opposition. */
export function buildPoolStandingsTableProps(
  overrides: Partial<Omit<StandingsTableProps, 'format' | 'rows'>> & {
    rows?: StandingLine[]
  } = {},
): StandingsTableProps {
  return {
    format: 'pool',
    ariaLabel: 'Standings for Pool A',
    rows: buildStandingLines(),
    ...overrides,
  }
}

/** Props for a **swiss** `StandingsTable` — the very same three rows, plus the `BUCHHOLZ`
 * figures above. The rows are the pool body with one column added and nothing else changed,
 * so the only difference a test can see between the two arms is the column `format` decides
 * on. */
export function buildSwissStandingsTableProps(
  overrides: Partial<Omit<StandingsTableProps, 'format' | 'rows'>> & {
    rows?: SwissStandingLine[]
  } = {},
): StandingsTableProps {
  return {
    format: 'swiss',
    ariaLabel: 'Standings for Swiss Singles',
    rows: buildStandingLines().map((row, index) =>
      buildSwissStandingLine({ ...row, buchholz: BUCHHOLZ[index] }),
    ),
    ...overrides,
  }
}
