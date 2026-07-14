import { Trophy } from 'lucide-react'
import { useId } from 'react'

import { eventStandings } from '../../../../data/standings'
import type { TournamentEvent } from '../../../../data/types'
import { PoolStandingsTable } from './pool-standings-table'

export interface StandingsPanelProps {
  event: TournamentEvent
}

/**
 * An event's **results** on its card in the Events tab (ADR-0788): a standings table per
 * pool, and — once the event is decided — its champion.
 *
 * It renders **nothing** for an event with no results (`event.results === null`, so
 * `eventStandings` returns `null`): an uncut event, or a non-round-robin one, has no
 * standings to show, and an empty table would read as a played event with nobody in it.
 * That is why this can be dropped into the panel unconditionally — it is a designed data
 * state, not a gap.
 *
 * ## Live, with no machinery of its own
 *
 * The standings are just BFF data: they arrive on the tournament-detail payload, derived
 * live on the server from the fixtures' completed matches. As matches complete, the
 * completion hook re-derives them and the mutations that drive play invalidate the
 * tournament — so the table fills in on the next read with **no polling and no client
 * recompute** here. This component is a pure view over `event`; it never sorts a row or
 * computes a number (the order and the figures *are* the result — ADR-0788).
 *
 * ## The champion
 *
 * Shown only when the event is **complete** and has a single champion (a complete,
 * single-pool round-robin). A multi-pool event has no single champion without a knockout
 * stage to join its pool winners (a later slice), so `champion` is `null` there even when
 * complete, and the callout simply does not appear — the pool tables still do.
 */
export const StandingsPanel = ({ event }: StandingsPanelProps) => {
  const headingId = useId()
  const standings = eventStandings(event)

  // No results to stand: an uncut or non-round-robin event. Render nothing — a designed
  // data state, not a spinner and not a gap.
  if (standings === null) return null

  return (
    <section
      data-testid={`standings-panel-${event.id}`}
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
        <p
          data-testid={`standings-champion-${event.id}`}
          className="mt-1.5 flex items-center gap-1.5 rounded-[10px] border border-[color:rgba(255,122,26,0.3)] bg-[color:var(--bg-accent-soft)] px-3 py-2 text-[13px] font-medium text-[color:var(--fg-1)] [box-shadow:var(--shadow-glow)]"
        >
          <Trophy size={14} className="text-[color:var(--ball-500)]" />
          <span className="text-[color:var(--fg-3)]">Champion</span>
          <span className="text-[color:var(--ball-500)]">{standings.champion}</span>
        </p>
      )}

      <div className="mt-2 flex flex-col gap-2.5">
        {standings.pools.map((pool) => (
          <PoolStandingsTable key={pool.poolId} pool={pool} />
        ))}
      </div>
    </section>
  )
}
