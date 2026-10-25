import { QueryClient, queryOptions } from '@tanstack/react-query'
import type { ApiClient } from './client'
import type { components } from './schema'
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

export type AccountPlayer = components['schemas']['AccountPlayer']
export type Answer = components['schemas']['Answer']

// The players the account manages, each with whether it still waits for the
// "Is this you?" answer. A guest account never has a question, so pages ask
// only for a verified account.
export function accountPlayersQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ['v1', 'account', 'players'],
    queryFn: async () => {
      const request = 'GET /v1/account/players'
      const { data, response } = await api.GET('/v1/account/players').catch((cause: unknown) => {
        throw new ApiUnreachable(request, { cause })
      })
      if (data === undefined) throw new ApiError(request, response)
      return data.data
    },
  })
}

// Answers "Is this you?" for one player. The API returns the account's
// players after the answer, so the players query takes them as they are. A
// "Yes" gives the account its own player, so the session's account takes it
// too, for the topbar's avatar. Refetching the session would start it again.
export function answerQuestionMutation(api: ApiClient, queryClient: QueryClient) {
  return {
    mutationFn: async ({ player, answer }: { player: AccountPlayer; answer: Answer }) => {
      const request = 'POST /v1/account/players/{player_id}/answer'
      const { data, response } = await api
        .POST('/v1/account/players/{player_id}/answer', {
          params: { path: { player_id: player.id } },
          body: { answer },
        })
        .catch((cause: unknown) => {
          throw new ApiUnreachable(request, { cause })
        })
      if (data === undefined) throw new ApiError(request, response)
      return data.data
    },
    onSuccess: (players: AccountPlayer[]) => {
      queryClient.setQueryData(accountPlayersQuery(api).queryKey, players)
      const self = players.find((player) => player.relationship === 'self')
      if (!self) return
      queryClient.setQueryData(sessionQuery(api).queryKey, (account) =>
        account && { ...account, player: { id: self.id, display_name: self.display_name } },
      )
    },
  }
}
