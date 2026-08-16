import { useId } from 'react'

import type { StandingsView } from '../../../../data/standings'
import { ChampionBanner } from '../champion-banner'
import { GroupStandingsTable } from './group-standings-table'

export interface StandingsPanelProps {
  /** The event the standings belong to — its id is what the panel's own test hooks hang
   * off (`standings-panel-…`, `standings-champion-…`), so a card showing more than one
   * results block still names each one. */
  eventId: string
  /** The standings to render, already selected and joined to names (`eventStandings`).
   * **Never null**: whether an event *has* standings is the caller's decision, not this
   * panel's — see the note above. */
  standings: StandingsView
}

/**
 * A **standings block** on an event's card in the Events tab (ADR-0788): a standings table
 * per group, and — once the event is decided — its champion.
 *
 * ## It renders what it is handed
 *
 * It takes its standings as a prop instead of reading them off an event and deciding
 * whether they apply. The switch on the results shape lives in exactly one place
 * (`ResultsPanel`), so this block can be shown for any event that *has* a standings block,
 * whatever the rest of its results look like — a plain round-robin today, one stage of a
 * multi-stage event tomorrow. A panel that re-checked `results.kind` would silently render
 * nothing the moment it met a shape it did not recognise.
 *
 * ## Live, with no machinery of its own
 *
 * The standings are just BFF data: they arrive on the tournament-detail payload, derived
 * live on the server from the fixtures' completed matches. As matches complete, the
 * completion hook re-derives them and the mutations that drive play invalidate the
 * tournament — so the table fills in on the next read with **no polling and no client
 * recompute** here. This component is a pure view over its props; it never sorts a row or
 * computes a number (the order and the figures *are* the result — ADR-0788).
 *
 * ## The champion
 *
 * Shown only when the event is **complete** and has a single champion (a complete,
 * single-group round-robin). A multi-group event has no single champion without a
 * knockout stage to join its group winners (a later slice), so `champion` is `null` there
 * even when complete, and the callout simply does not appear — the group tables still do.
 */
export const StandingsPanel = ({ eventId, standings }: StandingsPanelProps) => {
  const headingId = useId()

  return (
    <section
      data-testid={`standings-panel-${eventId}`}
      aria-labelledby={headingId}
      className="mt-2.5"
    >
      <h3
        id={headingId}
        className="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase"
      >
        Standings
      </h3>

      {/* The champion — a decided event's result, in the app's "featured" voice
          (`web-client/CLAUDE.md`, design system: the `--ball-500` tint + glow). Not an
          Alert: it is not the app talking back to an action and it does not dismiss, it is
          a fact about the finished event. Shown only when there IS one champion. */}
      {standings.complete && standings.champion !== null && (
        <ChampionBanner
          name={standings.champion}
          testId={`standings-champion-${eventId}`}
        />
      )}

      <div className="mt-2 flex flex-col gap-2.5">
        {standings.groups.map((group) => (
          <GroupStandingsTable key={group.groupId} group={group} />
        ))}
      </div>
    </section>
  )
}
