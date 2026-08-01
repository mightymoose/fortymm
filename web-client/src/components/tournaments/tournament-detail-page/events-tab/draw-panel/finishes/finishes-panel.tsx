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

import type { FinishesView } from '../../../../data/finishes'
import { ChampionBanner } from '../champion-banner'

export interface FinishesPanelProps {
  /** The event the finishes belong to — its id is what the panel's own test hooks hang off
   * (`finishes-panel-…`, `finishes-champion-…`), so a card showing more than one results
   * block still names each one. */
  eventId: string
  /** The event's name, for the table's accessible label ("Finishes for …") — a screen
   * reader meets the table out of context and needs to know whose finishes these are. */
  eventName: string
  /** The finishes to render, already selected and joined to names (`eventFinishes`).
   * **Never null**: whether an event *has* finishes is the caller's decision, not this
   * panel's — see the note above. */
  finishes: FinishesView
}

/**
 * A **finishes block** on an event's card in the Events tab (ADR-0785): a placement list —
 * each entrant at the finishing position the server derived from the round it was
 * eliminated in — and, once the final is decided, its champion. The `finishes` twin of
 * `StandingsPanel`; which of the two is shown is decided in one place, `ResultsPanel`,
 * switching on the results `kind`.
 *
 * ## It renders what it is handed
 *
 * Like its twin, it takes its finishes as a prop instead of reading them off an event and
 * deciding whether they apply — so it can be shown for any event that *has* a finishes
 * block, whatever the rest of its results look like (a plain single-elimination bracket
 * today, the knockout stage of a multi-stage event tomorrow). A panel that re-checked
 * `results.kind` would silently render nothing the moment it met a shape it did not know.
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
export const FinishesPanel = ({
  eventId,
  eventName,
  finishes,
}: FinishesPanelProps) => {
  const headingId = useId()

  return (
    <section
      data-testid={`finishes-panel-${eventId}`}
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
          testId={`finishes-champion-${eventId}`}
        />
      )}

      {/* A real `<table>`, like the standings: placement is tabular data (a position and a
          name per row), which a screen reader reads by column. */}
      <Table aria-label={`Finishes for ${eventName}`} className="mt-2 text-[13px]">
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
