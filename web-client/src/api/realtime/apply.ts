import type { QueryClient } from '@tanstack/react-query'
import type { RealtimeEvent } from './events'
import { queryKeysToInvalidate } from './invalidation'

/**
 * Apply one decoded hint to the cache.
 *
 * The whole of "what a push does to the client" is here, and it is four lines,
 * because the stream carries no domain data: a hint names the caches it
 * invalidates (`./invalidation`) and React Query does the rest — an active
 * query refetches immediately through its normal authenticated read, an
 * inactive one is simply marked stale for whenever it is next mounted.
 *
 * Fire-and-forget on purpose. `invalidateQueries` resolves when the refetches
 * it triggered settle, and there is nothing useful to do with that: the query
 * that failed owns its own error UI, and awaiting it here would only stall the
 * reader loop behind the network.
 */
export function applyRealtimeEvent(
  queryClient: QueryClient,
  event: RealtimeEvent,
): void {
  for (const queryKey of queryKeysToInvalidate(event)) {
    void queryClient.invalidateQueries({ queryKey })
  }
}
