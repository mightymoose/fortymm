import { DASHBOARD_QUERY_KEY } from '../dashboard'
import { UNKNOWN_EVENT_KIND, type DecodedEventKind, type RealtimeEvent } from './events'

/**
 * What a pushed hint invalidates.
 *
 * The stream never carries domain data — a hint says only *that* something
 * changed, and the client refetches the endpoint it already reads (see the
 * dashboard-invalidation ADR). So the entire client-side meaning of an event
 * lives in this one table.
 *
 * It is a **map, not a chain of `if`s**, because the next slice adds publishers
 * and this is where they land: a new kind is one row, and the `satisfies`
 * below makes the compiler demand that row rather than letting the kind fall
 * silently through to the fallback.
 *
 * Pure and table-tested, the same way `scheduleRefetchInterval` and
 * `previewPollInterval` are — a refresh policy is easier to trust as a function
 * of an event than as a behaviour of a subscription.
 */

type QueryKey = readonly unknown[]

const KEYS_BY_KIND = {
  /** Something the dashboard shows moved. */
  'dashboard.changed': [DASHBOARD_QUERY_KEY],
  /** Sent on connect. Whatever was missed while disconnected is recovered by
   * refetching, which is exactly what an idempotent hint already does — so
   * resync is not a special case, it is the same case. */
  resync: [DASHBOARD_QUERY_KEY],
  /** A kind from a newer server. Handled **coarsely**: refresh everything this
   * build knows how to refresh, because a hint we can't read is still evidence
   * that something moved. Doing nothing would silently reintroduce the staleness
   * the stream exists to remove. */
  [UNKNOWN_EVENT_KIND]: [DASHBOARD_QUERY_KEY],
} satisfies Record<DecodedEventKind, readonly QueryKey[]>

/**
 * The query keys to invalidate for one decoded event.
 *
 * Keys come from each query's own key factory — never spelled here — so there
 * stays exactly one source of truth per cache.
 */
export function queryKeysToInvalidate(event: RealtimeEvent): readonly QueryKey[] {
  return KEYS_BY_KIND[event.kind]
}
