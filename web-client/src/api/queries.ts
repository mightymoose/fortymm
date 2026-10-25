import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from './client'
import { ApiError, ApiUnreachable } from './errors'

// The API's health check. AuthenticatedLayout waits on it before showing a
// page. It runs once per page load: it never goes stale, so revisiting those
// pages doesn't check it again.
export function healthQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ['v1', 'health'],
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const request = 'GET /v1/health'
      const { data, response } = await api
        .GET('/v1/health', { signal })
        .catch((cause: unknown) => {
          // A cancelled query rejects too. TanStack Query expects that error.
          if (signal.aborted) throw cause
          throw new ApiUnreachable(request, { cause })
        })
      if (data === undefined) throw new ApiError(request, response)
      return data
    },
  })
}
