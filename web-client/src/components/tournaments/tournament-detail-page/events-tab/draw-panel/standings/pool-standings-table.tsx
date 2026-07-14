import { useId } from 'react'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import type { PoolStandingsView } from '../../../../data/standings'

export interface PoolStandingsTableProps {
  pool: PoolStandingsView
}

/** One numeric column's header: a terse glyph on screen (`W`, `L`) and the full word for a
 * screen reader, which cannot guess what `W` abbreviates. Both channels carry the meaning;
 * neither is left to infer it. */
const NumHead = ({ short, full }: { short: string; full: string }) => (
  <TableHead className="text-right font-mono tabular-nums">
    <span aria-hidden="true">{short}</span>
    <span className="sr-only">{full}</span>
  </TableHead>
)

/**
 * One **pool's standings** as a table (ADR-0788): the entrants in the server's finishing
 * order, one row each, with wins, losses, game difference and games won.
 *
 * **Nothing here re-sorts or recomputes.** The rows arrive in the pool's total order (wins
 * → two-way head-to-head → game difference → games won, decided on the server) and are
 * rendered in exactly that order — the order *is* the result. `game_difference` is the
 * server's own figure, shown, not derived from the two counts beside it (which would be a
 * second copy that could disagree). The view-model (`data/standings`) has already joined
 * each row's entry id to a username; a row is never a raw uuid.
 *
 * A real `<table>`, not a grid of divs: standings are tabular data, and a screen reader
 * reads a `<th scope>`-headed table by column ("player.1, Wins 2, Losses 0") rather than
 * as a wall of numbers. The numeric headers say their full word to it (`NumHead`).
 */
export const PoolStandingsTable = ({ pool }: PoolStandingsTableProps) => {
  const captionId = useId()

  return (
    <section
      data-testid={`pool-standings-${pool.poolId}`}
      aria-labelledby={captionId}
      className="rounded-[10px] border border-[color:var(--border-subtle)] p-3"
    >
      <h4
        id={captionId}
        className="text-[13px] font-semibold text-[color:var(--fg-1)]"
      >
        {pool.name}
      </h4>

      <Table
        aria-label={`Standings for ${pool.name}`}
        className="mt-2 text-[13px]"
      >
        <TableHeader>
          <TableRow>
            <TableHead className="w-8 text-right font-mono tabular-nums">
              <span aria-hidden="true">#</span>
              <span className="sr-only">Rank</span>
            </TableHead>
            <TableHead>Player</TableHead>
            <NumHead short="W" full="Wins" />
            <NumHead short="L" full="Losses" />
            <NumHead short="Diff" full="Game difference" />
            <NumHead short="GW" full="Games won" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {pool.rows.map((row) => (
            <TableRow
              key={row.entryId}
              data-testid={`standing-row-${row.entryId}`}
            >
              <TableCell className="text-right font-mono tabular-nums text-[color:var(--fg-3)]">
                {row.rank}
              </TableCell>
              <TableCell className="text-[color:var(--fg-1)]">
                {row.name}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {row.wins}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {row.losses}
              </TableCell>
              {/* The sign is load-bearing — `+2` and `-2` are different standings, and a
                  bare `2` would read as both. A screen reader hears "plus 2" / "minus 2"
                  from the same glyph. */}
              <TableCell className="text-right font-mono tabular-nums text-[color:var(--fg-2)]">
                {row.gameDifference > 0 ? `+${row.gameDifference}` : row.gameDifference}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {row.gamesWon}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}
