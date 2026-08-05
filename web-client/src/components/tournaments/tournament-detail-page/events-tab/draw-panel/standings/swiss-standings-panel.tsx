import { useId } from 'react'

import type { SwissStandingsView } from '../../../../data/swiss-standings'
import { ChampionBanner } from '../champion-banner'
import { StandingsTable } from './standings-table'

export interface SwissStandingsPanelProps {
  /** The event the standings belong to — its id is what the panel's test hooks hang off
   * (`swiss-standings-panel-…`, `swiss-champion-…`), so a card showing more than one results
   * block still names each one. */
  eventId: string
  /** The event's name, used as the table's accessible name. A swiss table ranks the whole
   * field, so the event is what it is "standings for" — there is no pool to name. */
  eventName: string
  /** The standings to render, already selected and joined to names (`eventSwissStandings`).
   * **Never null**: whether an event *has* standings is the caller's decision, not this
   * panel's. */
  standings: SwissStandingsView
}

/**
 * A **swiss event's standings** on its card in the Events tab (ADR "swiss pre-cuts every
 * round and pairs each one on advance"): **one table over the whole field**, and — once
 * every round is decided — the leader.
 *
 * ## One table, because swiss has no pools
 *
 * That is the only thing separating this from `StandingsPanel`: everybody is ranked against
 * everybody, which is what pairing by score is for. The table is the very `StandingsTable` a
 * pool renders, so the columns, the order and the withdrawn-entrant label are structurally
 * the same and not two implementations agreeing.
 *
 * ## It renders what it is handed
 *
 * It takes its standings as a prop instead of reading them off an event and deciding whether
 * they apply. The switch on the results shape lives in exactly one place (`ResultsPanel`). A
 * panel that re-checked `results.kind` would silently render nothing the moment it met a
 * shape it did not recognise.
 *
 * ## Live, with no machinery of its own
 *
 * The standings are just BFF data, derived live on the server from the fixtures' completed
 * matches. As matches land, the mutations that drive play invalidate the tournament and the
 * table fills in on the next read — **no polling and no client recompute** here. In swiss
 * that also covers the rounds that were cut up front with their sides unknown: they
 * contribute nothing until they are paired and played, which needs no special case.
 */
export const SwissStandingsPanel = ({
  eventId,
  eventName,
  standings,
}: SwissStandingsPanelProps) => {
  const headingId = useId()

  return (
    <section
      data-testid={`swiss-standings-panel-${eventId}`}
      aria-labelledby={headingId}
      className="mt-2.5"
    >
      <h3
        id={headingId}
        className="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase"
      >
        Standings
      </h3>

      {/* The leader of a decided event, in the app's "featured" voice (`web-client/CLAUDE.md`,
          design system). Not an Alert: it is not the app talking back to an action and it does
          not dismiss, it is a fact about the finished event. A swiss ranks its whole field, so
          a complete event always has one — but the `null` check stays, because `champion` is
          the SERVER's answer and this panel does not crown anybody by reading the top row. */}
      {standings.complete && standings.champion !== null && (
        <ChampionBanner
          name={standings.champion}
          testId={`swiss-champion-${eventId}`}
        />
      )}

      {/* The bordered box a pool's table sits in, minus the `<h4>` — there is no pool to
          name, and the section's own heading already says "Standings". The table therefore
          takes no top margin here: it is the first thing in the box, not something
          following a heading. */}
      <div className="mt-2 rounded-[10px] border border-[color:var(--border-subtle)] p-3">
        <StandingsTable
          ariaLabel={`Standings for ${eventName}`}
          rows={standings.rows}
        />
      </div>
    </section>
  )
}
