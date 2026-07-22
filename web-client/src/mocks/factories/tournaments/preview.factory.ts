// The **schedule-preview** factory (ADR "a schedule preview is a non-persistent
// solve over a synthetic field") — the pure, generated-schema-typed builders for
// the three ephemeral preview endpoints' wire bodies, shared by the MSW store
// (`src/mocks/schedule-preview-store.ts`) and the data-layer vitest test alike.
//
// Like `./tournament.factory.ts` and `./solver-sim.ts`, this module stays
// dependency-light — schema TYPES only, no MSW, nothing that cannot load in a
// bare Node context — so both the browser/vitest MSW world and any Node consumer
// can build the same plausible preview.

import type { components } from '@/api/schema'

type PreviewEnqueued = components['schemas']['PreviewEnqueued']
type PreviewFieldSummary = components['schemas']['PreviewFieldSummary']
type PreviewFixture = components['schemas']['PreviewFixture']
type PreviewResult = components['schemas']['PreviewResult']
type PreviewEventBreakdown = components['schemas']['PreviewEventBreakdown']
type PreviewJobState = components['schemas']['PreviewJobState']
type PoolHasNoTablesRead = components['schemas']['PoolHasNoTablesRead']

/** One event's synthetic field size on the wire. */
export function buildPreviewFieldSummary(
  overrides: Partial<PreviewFieldSummary> = {},
): PreviewFieldSummary {
  return { event_id: 'ev-1', field_size: 4, ...overrides }
}

/** One drawn synthetic pairing on the wire — both sides always known (the pool
 * stage of a round-robin draw). */
export function buildPreviewFixture(
  overrides: Partial<PreviewFixture> = {},
): PreviewFixture {
  return {
    fixture_id: 'pfx-1',
    event_id: 'ev-1',
    // The namespaced `{event_id}:{pool_id}` composite the solver keys by, plus the
    // human `pool_name` the grid actually heads a column with.
    pool_id: 'ev-1:pool-1',
    pool_name: 'Pool A',
    player_a_id: 'placeholder-1',
    player_b_id: 'placeholder-2',
    ...overrides,
  }
}

/** The round-robin fixtures of a single pool of `n` synthetic players (every
 * pairing once — `n·(n-1)/2` of them), so a factory can hand the enqueue body a
 * grid skeleton whose match count matches its field size. */
export function buildRoundRobinFixtures(
  n: number,
  opts: { eventId?: string; poolId?: string; poolName?: string } = {},
): PreviewFixture[] {
  const eventId = opts.eventId ?? 'ev-1'
  // The solver's namespaced composite (`{event_id}:{pool_id}`), plus the human
  // pool name the grid heads its column with — a realistic pair so a card renders
  // "Pool A", never the raw composite.
  const poolId = opts.poolId ?? `${eventId}:pool-1`
  const poolName = opts.poolName ?? 'Pool A'
  const fixtures: PreviewFixture[] = []
  for (let a = 1; a <= n; a += 1) {
    for (let b = a + 1; b <= n; b += 1) {
      fixtures.push(
        buildPreviewFixture({
          fixture_id: `pfx-${eventId}-${a}-${b}`,
          event_id: eventId,
          pool_id: poolId,
          pool_name: poolName,
          player_a_id: `placeholder-${a}`,
          player_b_id: `placeholder-${b}`,
        }),
      )
    }
  }
  return fixtures
}

/** The enqueue verb's 202 body — by default one event, a four-player field, and
 * its six round-robin fixtures (the instant structure the modal renders a
 * skeleton from before the solve returns). */
export function buildPreviewEnqueued(
  overrides: Partial<PreviewEnqueued> = {},
): PreviewEnqueued {
  return {
    token: 'preview-token-1',
    field_summaries: [buildPreviewFieldSummary()],
    fixtures: buildRoundRobinFixtures(4),
    ...overrides,
  }
}

/** One event's contribution to the summary on the wire. */
export function buildPreviewEventBreakdown(
  overrides: Partial<PreviewEventBreakdown> = {},
): PreviewEventBreakdown {
  return {
    event_id: 'ev-1',
    name: 'Open Singles',
    matches: 6,
    byes: 0,
    duration_min: 180,
    ...overrides,
  }
}

/** An infeasibility reason on the wire — the `pool_has_no_tables` arm, the
 * simplest resolved cause, for the infeasible-preview case. */
export function buildPoolHasNoTablesRead(
  overrides: Partial<PoolHasNoTablesRead> = {},
): PoolHasNoTablesRead {
  return { kind: 'pool_has_no_tables', pool_name: 'Pool A', ...overrides }
}

/** A schedule preview's whole answer on the wire — by default a *fitting* day: an
 * `optimal` verdict, a three-hour makespan, six matches on two of four tables, and
 * the always-present honest-notes strip (the disjoint-field caveat + the assumed
 * field size). `fits` moves with the verdict. Override `verdict`/`fits` +
 * `infeasibility_reasons` for the doesn't-fit case. */
export function buildPreviewResult(
  overrides: Partial<PreviewResult> = {},
): PreviewResult {
  return {
    verdict: 'optimal',
    fits: true,
    estimated_duration_min: 180,
    estimated_finish: '2026-06-13T12:00:00',
    total_matches: 6,
    total_byes: 0,
    peak_concurrent_tables: 2,
    table_utilization: 0.5,
    events: [buildPreviewEventBreakdown()],
    infeasibility_reasons: [],
    notes: [
      'Fake fields are disjoint across events, so this estimate is optimistic.',
      'Assumed 4 players in Open Singles.',
    ],
    ...overrides,
  }
}

/** An **infeasible** preview result — the day the engine PROVED cannot fit, with
 * one resolved reason. `estimated_duration_min`/`estimated_finish` null (no plan
 * to span), `fits` false. */
export function buildInfeasiblePreviewResult(
  overrides: Partial<PreviewResult> = {},
): PreviewResult {
  return buildPreviewResult({
    verdict: 'infeasible',
    fits: false,
    estimated_duration_min: null,
    estimated_finish: null,
    infeasibility_reasons: [buildPoolHasNoTablesRead()],
    events: [buildPreviewEventBreakdown({ duration_min: null })],
    ...overrides,
  })
}

/** A single poll read on the wire. `result` rides only a `done` state and `error`
 * only a `failed` one, exactly as the server constructs it. */
export function buildPreviewJobState(
  overrides: Partial<PreviewJobState> = {},
): PreviewJobState {
  return { status: 'queued', result: null, error: null, ...overrides }
}
