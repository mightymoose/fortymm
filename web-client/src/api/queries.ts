import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from './client'

// The API's health check. The app's layout waits on it before showing a page
// (see routes/Root.tsx).
export function healthQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ['v1', 'health'],
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET('/v1/health', { signal })
      if (data === undefined) {
        throw new Error(`GET /v1/health answered ${response.status}`)
      }
      return data
    },
  })
}
