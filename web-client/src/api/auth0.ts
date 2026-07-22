import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { z } from 'zod'
import { api, resolveBaseUrl, unwrap } from './client'

// Whether the current user has an Auth0 identity bound (see the `LinkStatus`
// schema). Both `GET /v1/auth0/link` and the `DELETE` reply with this shape, so
// a client updates the same cache entry either way.
const linkStatusSchema = z.object({ linked: z.boolean() })
export type Auth0LinkStatus = z.infer<typeof linkStatusSchema>

export const AUTH0_LINK_QUERY_KEY = ['auth0', 'link'] as const

/** The current user's Auth0 (agent-access) link status. Parsed at the boundary
 * so a malformed payload fails loudly rather than priming a bad cache entry. */
export function auth0LinkQueryOptions() {
  return queryOptions({
    queryKey: AUTH0_LINK_QUERY_KEY,
    queryFn: async (): Promise<Auth0LinkStatus> =>
      linkStatusSchema.parse(
        unwrap('load agent link status', await api.GET('/v1/auth0/link')),
      ),
  })
}

export function useAuth0LinkStatus() {
  return useQuery(auth0LinkQueryOptions())
}

/**
 * Drop the user's Auth0 identity binding. The 200 body is the freshly-cleared
 * status (`{ linked: false }`), so we seed the cache with it directly instead of
 * round-tripping a refetch — the section flips to "not connected" immediately.
 * Callers await via `mutateAsync` and surface their own errors.
 */
export function useUnlinkAuth0() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<Auth0LinkStatus> =>
      linkStatusSchema.parse(
        unwrap('unlink agent access', await api.DELETE('/v1/auth0/link')),
      ),
    onSuccess: (status) => {
      qc.setQueryData(AUTH0_LINK_QUERY_KEY, status)
    },
  })
}

/**
 * The full-navigation target that *begins* the Auth0 login/link redirect flow.
 * This is an OAuth redirect (a 302 from the API), not a fetch — the browser must
 * navigate to it. Built off the API base URL (nginx serves the API under `/api`,
 * and `VITE_API_URL` can override it), so the browser lands on the real endpoint
 * rather than the SPA router.
 */
export function auth0LinkStartUrl(): string {
  return `${resolveBaseUrl()}/v1/auth0/link/start`
}
