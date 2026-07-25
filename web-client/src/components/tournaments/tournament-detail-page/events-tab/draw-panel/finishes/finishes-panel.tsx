import { Trophy } from 'lucide-react'
import { useId } from 'react'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { eventFinishes } from '../../../../data/finishes'
import type { TournamentEvent } from '../../../../data/types'
import { ChampionBanner } from '../champion-banner'

export interface FinishesPanelProps {
  event: TournamentEvent
}

/**
 * A single-elimination event's **results** as its **finishes** (ADR-0785): a placement list
 * — each entrant at the finishing position the server derived from the round it was
 * eliminated in — and, once the final is decided, its champion. The `finishes` twin of
 * `StandingsPanel`; the two are switched between by `ResultsPanel` on the results `kind`.
 *
 * It renders **nothing** when the event has no finishes (`eventFinishes` returns `null`: no
 * results, or a `standings` round-robin) — a designed data state, not a gap. `ResultsPanel`
 * only mounts it for the `finishes` arm, but the guard keeps it safe to render directly.
 *
 * ## Live, and never computed here
 *
 * The finishes are BFF data, derived live on the server from the bracket's completed
 * fixtures (never a snapshot), and arrive on the tournament-detail payload. A
 * partially-played bracket sends the placements **so far** — the losers eliminated to date,
 * tied by round — and this shows exactly that, filling in on the next read as matches
 * complete. The client never computes a placement or invents an order: **same-round losers
 * tie** (`T3`, `T5`), because single-elimination genuinely does not rank them against each
 * other (`eventFinishes` marks the tie; this only renders it).
 */
export const FinishesPanel = ({ event }: FinishesPanelProps) => {
  const headingId = useId()
  const finishes = eventFinishes(event)

  // No finishes to place: no results, or a round-robin (`standings`). Render nothing — a
  // designed data state, not a spinner and not a gap.
  if (finishes === null) return null

  return (
    <section
      data-testid={`finishes-panel-${event.id}`}
      aria-labelledby={headingId}
      className="mt-2.5"
    >
      <h3
        id={headingId}
        className="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase"
      >
        Finishes
      </h3>

      {/* The champion — the decided bracket's result, in the app's "featured" voice (same
          treatment as the standings champion). Shown only when the final is decided and
          there is a champion. */}
      {finishes.complete && finishes.champion !== null && (
        <ChampionBanner
          name={finishes.champion}
          testId={`finishes-champion-${event.id}`}
        />
      )}

      {/* A real `<table>`, like the standings: placement is tabular data (a position and a
          name per row), which a screen reader reads by column. */}
      <Table aria-label={`Finishes for ${event.name}`} className="mt-2 text-[13px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-12 text-right font-mono tabular-nums">
              <span aria-hidden="true">#</span>
              <span className="sr-only">Finishing position</span>
            </TableHead>
            <TableHead>Player</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {finishes.finishes.map((row) => (
            <TableRow key={row.entryId} data-testid={`finish-row-${row.entryId}`}>
              {/* The label read under the "Finishing position" column header (its full word
                  is on the header, like the standings `#`): `1st`, `2nd`, or a tie `T3`. */}
              <TableCell className="text-right font-mono tabular-nums text-[color:var(--fg-3)]">
                {row.positionLabel}
              </TableCell>
              <TableCell
                className={
                  row.isChampion
                    ? 'flex items-center gap-1.5 font-medium text-[color:var(--ball-500)]'
                    : 'text-[color:var(--fg-1)]'
                }
              >
                {row.isChampion && (
                  <Trophy
                    size={13}
                    aria-hidden="true"
                    className="text-[color:var(--ball-500)]"
                  />
                )}
                {row.name}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}
