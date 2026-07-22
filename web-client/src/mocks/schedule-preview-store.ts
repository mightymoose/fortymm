// The dev/test **schedule-preview** store (ADR "a schedule preview is a
// non-persistent solve over a synthetic field") — the ephemeral state plumbing
// behind the three preview endpoints. A preview persists NOTHING on the real
// server (it lives only in the RQ job result with a short TTL), so this store is
// deliberately its own tiny thing, separate from the stateful `tournaments-store`:
// a `Map` of in-flight jobs, thrown away on reset.
//
// The mock has no worker, so — like the solve sim — the job is walked forward BY
// THE READS: the first poll of a token answers `queued`, the next `running`, and
// the one after that `done` with the `PreviewResult`. Two polls is the streaming
// demo the modal (and its test) watch for. The pure wire-body builders are the
// shared `factories/tournaments/preview.factory.ts`; this module keeps only the
// per-token poll state around them.

import type { components } from '@/api/schema'

import {
  buildPreviewEnqueued,
  buildPreviewResult,
  buildRoundRobinFixtures,
  buildPreviewEventBreakdown,
  buildPreviewFieldSummary,
} from './factories/tournaments/preview.factory'

type PreviewEnqueued = components['schemas']['PreviewEnqueued']
type PreviewResult = components['schemas']['PreviewResult']
type PreviewJobState = components['schemas']['PreviewJobState']
type PreviewRequest = components['schemas']['PreviewRequest']

/** One enqueued preview job the mock is walking forward: how many times its token
 * has been polled, and the result the final `done` poll will carry. */
interface PreviewJob {
  polls: number
  result: PreviewResult
}

const jobs = new Map<string, PreviewJob>()
let tokenCounter = 0

/** The default synthetic field size for an event with no override — matches the
 * ADR's uncapped default's spirit (a modest, even field the round-robin draw
 * halves cleanly into pairings). */
const DEFAULT_FIELD_SIZE = 4

/** `n·(n-1)/2` — every pairing of an `n`-player round-robin pool, the drawn match
 * count for a single-pool event. */
function roundRobinMatchCount(n: number): number {
  return (n * (n - 1)) / 2
}

/**
 * Enqueue a preview: mint a token, synthesize a single-event field (sized by the
 * first override, or the default), draw its round-robin fixtures, and stash the
 * result the walk will resolve to. Returns the 202 body — the token plus the
 * instant structure (field sizes + fixtures) the modal renders a skeleton from.
 */
export function enqueuePreview(body: PreviewRequest | null): PreviewEnqueued {
  const overrides = body?.overrides ?? {}
  const overrideEntries = Object.entries(overrides)
  const eventId = overrideEntries[0]?.[0] ?? 'ev-1'
  const fieldSize = overrideEntries[0]?.[1] ?? DEFAULT_FIELD_SIZE

  tokenCounter += 1
  const token = `preview-token-${tokenCounter}`

  const fixtures = buildRoundRobinFixtures(fieldSize, { eventId })
  const matches = roundRobinMatchCount(fieldSize)
  // An odd field byes every player exactly once (one bye per round); an even
  // field byes nobody — the ADR's round-robin bye rule.
  const byes = fieldSize % 2 === 1 ? fieldSize : 0

  const enqueued = buildPreviewEnqueued({
    token,
    field_summaries: [buildPreviewFieldSummary({ event_id: eventId, field_size: fieldSize })],
    fixtures,
  })

  const result = buildPreviewResult({
    total_matches: matches,
    total_byes: byes,
    events: [
      buildPreviewEventBreakdown({ event_id: eventId, matches, byes }),
    ],
  })

  jobs.set(token, { polls: 0, result })
  return enqueued
}

/**
 * Read one poll of a token, walking it forward a step: poll 1 → `queued`, poll 2
 * → `running`, poll 3+ → `done` with the result. An unknown token answers
 * `failed` — the real server's "the job errored, was cancelled, or its short-TTL
 * result has already expired out of Redis" (a cancelled or expired preview reads
 * exactly this way).
 */
export function readPreview(token: string): PreviewJobState {
  const job = jobs.get(token)
  if (!job) {
    return {
      status: 'failed',
      result: null,
      error: 'This preview is no longer available.',
    }
  }
  job.polls += 1
  if (job.polls === 1) return { status: 'queued', result: null, error: null }
  if (job.polls === 2) return { status: 'running', result: null, error: null }
  return { status: 'done', result: job.result, error: null }
}

/** Best-effort cancel: drop the job so its token stops resolving (a later poll
 * then reads `failed`, exactly as a reclaimed slot would). Idempotent — cancelling
 * an unknown token is a no-op, like the real 204. */
export function cancelPreview(token: string): void {
  jobs.delete(token)
}

/** Wipe every in-flight preview — call between tests so a token minted in one
 * test cannot leak its poll count into the next. */
export function resetSchedulePreviewStore(): void {
  jobs.clear()
  tokenCounter = 0
}
