import type { PoolStandingsView, StandingLine } from '../../../../data/standings'
import type { PoolStandingsTableProps } from './pool-standings-table'

/** One standings line, joined to a name (`StandingLine`): `player.1`, 1st, 2–0, +3. The
 * view-model's output shape — a `StandingRow` plus the name join — so the table's tests
 * never re-run the join, they render the result of it. */
export function buildStandingLine(
  overrides: Partial<StandingLine> = {},
): StandingLine {
  return {
    entryId: 'entry-1',
    name: 'player.1',
    rank: 1,
    played: 2,
    wins: 2,
    losses: 0,
    gamesWon: 4,
    gamesLost: 1,
    gameDifference: 3,
    ...overrides,
  }
}

/** A complete three-player pool, in the server's finishing order: `player.1` (2–0) over
 * `player.4` (1–1) over `player.5` (0–2). The middle row's `gameDifference` is `0` and the
 * last is negative, so a test can prove the sign is rendered (`+3`, `0`, `-3`). Returned in
 * order, which the table renders untouched (ADR-0788). */
export function buildPoolStandingsView(
  overrides: Partial<PoolStandingsView> = {},
): PoolStandingsView {
  return {
    poolId: 'p-a',
    name: 'Pool A',
    complete: true,
    rows: [
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
    ],
    ...overrides,
  }
}

/** Props for `PoolStandingsTable`. */
export function buildPoolStandingsTableProps(
  overrides: Partial<PoolStandingsTableProps> = {},
): PoolStandingsTableProps {
  return { pool: buildPoolStandingsView(), ...overrides }
}
