import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from './client'
import type { components } from './schema'

export type Session = components['schemas']['SessionResponse']
export type SessionUser = components['schemas']['SessionUser']

export const SESSION_QUERY_KEY = ['session'] as const

export function useSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async (): Promise<Session> =>
      unwrap('load session', await api.GET('/v1/session')),
    staleTime: 1000 * 60 * 5,
  })
}
