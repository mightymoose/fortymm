import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { cn } from '@/lib/utils'

import type { StandingLine } from '../../../../data/standings'

export interface StandingsTableProps {
  /** The table's accessible name — what a screen reader is told this table ranks. The
   * caller owns the wording because it owns the scope: a pool names itself ("Standings for
   * Pool A"), a swiss event names the event, and neither fact is knowable here. */
  ariaLabel: string
  /** The rows in the **server's finishing order**, already joined to usernames. Rendered in
   * exactly that order — see below. */
  rows: StandingLine[]
  /** Spacing from whatever sits above, which is the caller's to decide: a pool's table
   * follows an `<h4>` naming the pool and wants a gap, a swiss event's is the first thing
   * in its box and does not. The table owns no margin of its own for that reason. */
  className?: string
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
 * A **standings table** (ADR-0788): entrants in the server's finishing order, one row each,
 * with wins, losses, game difference and games won.
 *
 * **One table for every results shape that ranks players.** A round-robin pool
 * (`PoolStandingsTable`) and a pool-less swiss event (`SwissStandingsPanel`) show the same
 * columns computed the same way, so they render through this one component rather than two
 * that agree today. What differs between them is what *titles* the table and what scopes its
 * test hooks — both of which belong to the caller, which is why this takes only an accessible
 * name and rows.
 *
 * **Nothing here re-sorts or recomputes.** The rows arrive in a total order decided on the
 * server (wins → head-to-head → game difference → games won) and are rendered in exactly
 * that order — the order *is* the result. `gameDifference` is the server's own figure,
 * shown, not derived from the two counts beside it (which would be a second copy that could
 * disagree). The view-model (`data/standings`, `data/swiss-standings`) has already joined
 * each row's entry id to a username; a row is never a raw uuid.
 *
 * A real `<table>`, not a grid of divs: standings are tabular data, and a screen reader reads
 * a `<th scope>`-headed table by column ("player.1, Wins 2, Losses 0") rather than as a wall
 * of numbers. The numeric headers say their full word to it (`NumHead`).
 */
export const StandingsTable = ({
  ariaLabel,
  rows,
  className,
}: StandingsTableProps) => (
  // `className` FIRST, unusually — it is spacing from whatever sits above, and putting it
  // ahead of the table's own type scale keeps the emitted class string byte-identical to
  // the one `PoolStandingsTable` rendered before this component was extracted. The
  // standings panel carries a whole-DOM inline snapshot guard, which is what makes "this
  // extraction is DOM-preserving" a measured fact rather than an intention.
  <Table aria-label={ariaLabel} className={cn(className, 'text-[13px]')}>
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
      {rows.map((row) => (
        <TableRow key={row.entryId} data-testid={`standing-row-${row.entryId}`}>
          <TableCell className="text-right font-mono tabular-nums text-[color:var(--fg-3)]">
            {row.rank}
          </TableCell>
          <TableCell className="text-[color:var(--fg-1)]">{row.name}</TableCell>
          <TableCell className="text-right font-mono tabular-nums">
            {row.wins}
          </TableCell>
          <TableCell className="text-right font-mono tabular-nums">
            {row.losses}
          </TableCell>
          {/* The sign is load-bearing — `+2` and `-2` are different standings, and a bare
              `2` would read as both. A screen reader hears "plus 2" / "minus 2" from the
              same glyph. */}
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
)
