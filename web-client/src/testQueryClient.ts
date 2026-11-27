import { QueryClient } from '@tanstack/react-query'

// A fresh client per render, so tests don't share a cache. No retries: a failing request shows
// its error state at once instead of after TanStack Query's backoff.
export function createTestQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}
