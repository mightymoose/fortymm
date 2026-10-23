import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from './client'

// The API's health check. AuthenticatedLayout waits on it before showing a
// page. It runs once per page load: it never goes stale, so revisiting those
// pages doesn't check it again.
export function healthQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ['v1', 'health'],
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET('/v1/health', { signal })
      if (data === undefined) {
        throw new Error(`GET /v1/health answered ${response.status}`)
      }
      return data
    },
  })
}
