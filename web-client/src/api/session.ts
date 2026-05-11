import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import type { components } from './schema'

export type Session = components['schemas']['SessionResponse']
export type SessionUser = components['schemas']['SessionUser']

export const SESSION_QUERY_KEY = ['session'] as const

export function useSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async (): Promise<Session> => {
      const { data, error } = await api.GET('/v1/session')
      if (error || !data) {
        throw new Error('Failed to load session')
      }
      return data
    },
    staleTime: 1000 * 60 * 5,
  })
}
