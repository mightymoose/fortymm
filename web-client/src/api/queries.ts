import { QueryClient, queryOptions } from '@tanstack/react-query'
import type { ApiClient } from './client'
import { ApiError, ApiUnreachable } from './errors'

// Retries a network error or a 5xx only, which can pass. A 4xx comes back the
// same. A retry after a lost POST /v1/session response can leave one unused
// guest account, which is an accepted cost.
export function shouldRetry(failureCount: number, error: Error): boolean {
  return failureCount < 3 && (!(error instanceof ApiError) || error.status >= 500)
}

// The app's QueryClient. Tests make their own, with retries off.
export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } })
}

// The visitor's account, from resuming their session or starting a guest
// account. AuthenticatedLayout waits on it before showing a page. It runs
// once per page load: it never goes stale, so revisiting those pages doesn't
// start the session again.
export function sessionQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ['v1', 'session'],
    staleTime: Infinity,
    // No `signal`: aborting the request can't stop the API starting a guest
    // account, but it drops the response and its cookie. The query would
    // then start another account, e.g. when StrictMode remounts the layout.
    queryFn: async () => {
      const request = 'POST /v1/session'
      // openapi-fetch sends no Content-Type without a body, and the API
      // answers 415 to a POST that isn't JSON.
      const { data, response } = await api
        .POST('/v1/session', { headers: { 'Content-Type': 'application/json' } })
        .catch((cause: unknown) => {
          throw new ApiUnreachable(request, { cause })
        })
      if (data === undefined) throw new ApiError(request, response)
      return data.data.account
    },
  })
}
