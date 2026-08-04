import type { components } from '@/api/schema'
import {
  buildAdminScheduleSolveRead,
  buildPlayerConflictRead,
  buildTableConflictRead,
} from '@/mocks/factories/tournaments/tournament.factory'

type AdminScheduleSolveRead = components['schemas']['AdminScheduleSolveRead']

export { buildAdminScheduleSolveRead, buildTableConflictRead, buildPlayerConflictRead }

/**
 * The variety page: one row per designed outcome — including all THREE terminal
 * not-a-plan outcomes, which read as three different things (ADR "a time-capped
 * solve is its own outcome, not a failure") — newest first, the seed the
 * rendering tests read every column off. Two tournaments so the
 * link/filter cells have something to disagree about.
 */
export function buildLedgerVariety(): AdminScheduleSolveRead[] {
  return [
    buildAdminScheduleSolveRead({
      id: 'sv-queued',
      status: 'queued',
      trigger: 'go_live',
      verdict: null,
      requested_at: '2026-07-15T10:59:00Z',
      started_at: null,
      finished_at: null,
      wall_time_ms: null,
      fixtures_placed: null,
      fixtures_pinned: null,
    }),
    buildAdminScheduleSolveRead({
      id: 'sv-running',
      status: 'running',
      trigger: 'match_completed',
      verdict: null,
      requested_at: '2026-07-15T10:58:00Z',
      finished_at: null,
      wall_time_ms: null,
      fixtures_placed: null,
      fixtures_pinned: null,
      rerun_requested: true,
      tournament_id: 'summer-slam-2026',
      tournament_name: 'Summer Slam 2026',
    }),
    buildAdminScheduleSolveRead({
      id: 'sv-failed',
      status: 'failed',
      trigger: 'settings_changed',
      verdict: null,
      requested_at: '2026-07-15T10:57:00Z',
      wall_time_ms: null,
      fixtures_placed: null,
      fixtures_pinned: null,
      error: 'worker crashed: out of memory in CP-SAT presolve',
      input_fingerprint: 'deadbeef'.repeat(8),
    }),
    buildAdminScheduleSolveRead({
      id: 'sv-infeasible',
      status: 'infeasible',
      trigger: 'pin_tick',
      verdict: 'infeasible',
      requested_at: '2026-07-15T10:56:00Z',
      fixtures_placed: null,
      fixtures_pinned: null,
      tournament_id: 'summer-slam-2026',
      tournament_name: 'Summer Slam 2026',
      // The resolved causes the day doesn't fit — three arms, so the expansion
      // proves it renders each reason's sentence + remedy (the same list the
      // Schedule-tab strip shows), including the one that names a *human*
      // (`player_over_subscribed`) rather than a pool or a fixture.
      infeasibility_reasons: [
        {
          kind: 'window_too_short_for_match',
          pool_name: 'Pool A',
          window_start: '09:00',
          window_end: '10:00',
          best_of: 5,
          needed_min: 75,
          window_span_min: 60,
        },
        {
          kind: 'player_over_subscribed',
          player_name: 'spiked-frigatebird',
          pool_name: 'Pool A',
          window_start: '09:00',
          window_end: '10:30',
          match_count: 4,
          required_min: 150,
          window_span_min: 90,
        },
        {
          kind: 'no_single_cause',
          required_min: 420,
          available_min: 480,
        },
      ],
    }),
    buildAdminScheduleSolveRead({
      id: 'sv-timed-out',
      status: 'timed_out',
      trigger: 'rerun',
      // No verdict at all: the cap ran out before the solver reached one (ADR
      // "a time-capped solve is its own outcome, not a failure"). The error is
      // the cap's own sentence — detail for an operator, never a discriminator.
      verdict: null,
      requested_at: '2026-07-15T10:56:30Z',
      wall_time_ms: 30_000,
      fixtures_placed: null,
      fixtures_pinned: null,
      error: 'time cap exhausted without a solution',
      input_fingerprint: 'cafebabe'.repeat(8),
    }),
    buildAdminScheduleSolveRead({
      id: 'sv-succeeded',
      status: 'succeeded',
      trigger: 'manual',
      verdict: 'optimal',
      requested_at: '2026-07-15T10:55:00Z',
      wall_time_ms: 850,
      fixtures_placed: 9,
      fixtures_pinned: 2,
    }),
  ]
}

/** `count` succeeded rows, newest first, alternating across two tournaments —
 * for the cases that care how MANY rows the ledger has (pagination), not what
 * happened in them. */
export function buildLedgerRows(count: number): AdminScheduleSolveRead[] {
  return Array.from({ length: count }, (_, i) =>
    buildAdminScheduleSolveRead({
      id: `sv-${i + 1}`,
      requested_at: `2026-07-15T${String(23 - Math.floor(i / 60)).padStart(2, '0')}:${String(
        59 - (i % 60),
      ).padStart(2, '0')}:00Z`,
      tournament_id: i % 2 === 0 ? 'bay-area-open-2026' : 'summer-slam-2026',
      tournament_name: i % 2 === 0 ? 'Bay Area Open 2026' : 'Summer Slam 2026',
    }),
  )
}
