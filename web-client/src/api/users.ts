import { queryOptions, useQuery } from '@tanstack/react-query'
import { api, unwrap } from './client'
import type { components } from './schema'

export type UserProfile = components['schemas']['UserProfile']

export function userByIdQueryOptions(userId: string) {
  return queryOptions({
    queryKey: ['user', 'by-id', userId] as const,
    queryFn: async (): Promise<UserProfile> =>
      unwrap(
        'load user',
        await api.GET('/v1/users/{user_id}/profile', {
          params: { path: { user_id: userId } },
        }),
      ),
  })
}

export function useUserById(userId: string, options: { enabled?: boolean } = {}) {
  return useQuery({ ...userByIdQueryOptions(userId), ...options })
}

export function publicUserByUsernameQueryOptions(username: string) {
  return queryOptions({
    queryKey: ['user', 'public', username] as const,
    queryFn: async (): Promise<UserProfile> =>
      unwrap(
        'load public profile',
        await api.GET('/v1/p/users/{username}', {
          params: { path: { username } },
        }),
      ),
  })
}

export function usePublicUserByUsername(username: string) {
  return useQuery(publicUserByUsernameQueryOptions(username))
}
