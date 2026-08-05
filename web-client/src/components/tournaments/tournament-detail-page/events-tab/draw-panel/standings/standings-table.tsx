import type { ReactNode } from 'react'

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
import type { SwissStandingLine } from '../../../../data/swiss-standings'

/**
 * **Which table this is, and therefore which columns it has** — a closed sum type, not a
 * `showBuchholz` boolean beside a loosely-typed row list.
 *
 * The two are one decision. A boolean could be `true` over rows that carry no `buchholz`
 * (a header column with nothing under it) or `false` over rows that do (the one figure
 * that explains the order, silently dropped) — and neither is a state anyone would notice
 * in review. Tagging the table instead makes both unrepresentable: `swiss` **requires**
 * `SwissStandingLine[]`, and the header and the cells are both read off the same tag.
 */
export type StandingsTableRows =
  /** A round-robin pool's table. Every entrant in a pool faces the same opposition, so
   * strength of schedule carries no information and there is no Buchholz column. */
  | { format: 'pool'; rows: StandingLine[] }
  /** A swiss event's table, which shows the **Buchholz** figure that ordered it. */
  | { format: 'swiss'; rows: SwissStandingLine[] }

export type StandingsTableProps = {
  /** The table's accessible name — what a screen reader is told this table ranks. The
   * caller owns the wording because it owns the scope: a pool names itself ("Standings for
   * Pool A"), a swiss event names the event, and neither fact is knowable here. */
  ariaLabel: string
  /** Spacing from whatever sits above, which is the caller's to decide: a pool's table
   * follows an `<h4>` naming the pool and wants a gap, a swiss event's is the first thing
   * in its box and does not. The table owns no margin of its own for that reason. */
  className?: string
} & StandingsTableRows

/** One numeric column's header: a terse glyph on screen (`W`, `L`) and the full word for a
 * screen reader, which cannot guess what `W` abbreviates. Both channels carry the meaning;
 * neither is left to infer it. */
const NumHead = ({ short, full }: { short: string; full: string }) => (
  <TableHead className="text-right font-mono tabular-nums">
    <span aria-hidden="true">{short}</span>
    <span className="sr-only">{full}</span>
  </TableHead>
)

/** One numeric body cell, right-aligned and tabular so the column reads as a column. */
const NumCell = ({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) => (
  <TableCell className={cn('text-right font-mono tabular-nums', className)}>
    {children}
  </TableCell>
)

/**
 * One entrant's line: the columns **every** standings table shows, plus the Buchholz cell
 * when this table has that column.
 *
 * `buchholz` is `number | undefined` here rather than on the row, and the two arms of
 * `bodyRows` below are what supply it — so the cell exists exactly when the header does,
 * both decided by the one tag. A row type that carried an optional `buchholz` would let a
 * pool row wander in with one, or a swiss row arrive without.
 */
const StandingsLineRow = ({
  row,
  buchholz,
}: {
  row: StandingLine
  buchholz?: number
}) => (
  <TableRow data-testid={`standing-row-${row.entryId}`}>
    <NumCell className="text-[color:var(--fg-3)]">{row.rank}</NumCell>
    <TableCell className="text-[color:var(--fg-1)]">{row.name}</TableCell>
    <NumCell>{row.wins}</NumCell>
    <NumCell>{row.losses}</NumCell>
    {/* Above game difference, because that is where it sits in swiss's tiebreak chain
        (wins → head-to-head → **Buchholz** → game difference → games won). The columns run
        left-to-right in chain order, which is what lets a director read *why* two entrants
        level on wins are in the order they are in. */}
    {buchholz !== undefined && (
      <NumCell className="text-[color:var(--fg-2)]">{buchholz}</NumCell>
    )}
    {/* The sign is load-bearing — `+2` and `-2` are different standings, and a bare `2`
        would read as both. A screen reader hears "plus 2" / "minus 2" from the same glyph.
        Buchholz above takes no sign: it is a sum of win counts, so it is never negative and
        a `+` would suggest a margin it is not. */}
    <NumCell className="text-[color:var(--fg-2)]">
      {row.gameDifference > 0 ? `+${row.gameDifference}` : row.gameDifference}
    </NumCell>
    <NumCell>{row.gamesWon}</NumCell>
  </TableRow>
)

/**
 * The body, one arm per table format — a `switch` with a `never` default, so a third kind
 * of standings table is a **compile error here** until it says which columns it has.
 *
 * The `map` lives *inside* the switch on purpose: that is what narrows `rows` to the arm's
 * own row type, so the swiss arm reads `row.buchholz` with no cast and the pool arm cannot.
 */
const bodyRows = (table: StandingsTableRows) => {
  switch (table.format) {
    case 'pool':
      return table.rows.map((row) => (
        <StandingsLineRow key={row.entryId} row={row} />
      ))
    case 'swiss':
      return table.rows.map((row) => (
        <StandingsLineRow key={row.entryId} row={row} buchholz={row.buchholz} />
      ))
    default: {
      const exhaustive: never = table
      return exhaustive
    }
  }
}

/**
 * A **standings table** (ADR-0788): entrants in the server's finishing order, one row each,
 * with wins, losses, game difference and games won — and, for a swiss event, the
 * **Buchholz** figure that ordered them.
 *
 * **One table for every results shape that ranks players.** A round-robin pool
 * (`PoolStandingsTable`) and a pool-less swiss event (`SwissStandingsPanel`) share eight
 * columns computed the same way, so they render through this one component rather than two
 * that agree today. What differs is the *title*, the test hooks — both the caller's — and
 * the one extra column, which is `format`'s.
 *
 * **Nothing here re-sorts or recomputes.** The rows arrive in a total order decided on the
 * server (wins → head-to-head → *Buchholz, in swiss* → game difference → games won) and are
 * rendered in exactly that order — the order *is* the result. `gameDifference` is the
 * server's own figure, shown, not derived from the two counts beside it; `buchholz` likewise
 * — it is a sum over *other* rows and moves when an opponent wins a later match, so a
 * client-side re-derivation would be a second copy that disagrees within a round. The
 * view-model (`data/standings`, `data/swiss-standings`) has already joined each row's entry
 * id to a username; a row is never a raw uuid.
 *
 * A real `<table>`, not a grid of divs: standings are tabular data, and a screen reader reads
 * a `<th scope>`-headed table by column ("player.1, Wins 2, Losses 0") rather than as a wall
 * of numbers. The numeric headers say their full word to it (`NumHead`).
 */
export const StandingsTable = ({
  ariaLabel,
  className,
  ...table
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
        {/* Read off the SAME tag the cells are (`bodyRows`), so a header column can never
            appear without its cells or vice versa. */}
        {table.format === 'swiss' && <NumHead short="Buc" full="Buchholz" />}
        <NumHead short="Diff" full="Game difference" />
        <NumHead short="GW" full="Games won" />
      </TableRow>
    </TableHeader>
    <TableBody>{bodyRows(table)}</TableBody>
  </Table>
)
