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
// account. The `_authenticated` route's loader waits on it before showing a
// page. It runs once per page load: it never goes stale, so revisiting those
// pages doesn't start the session again.
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

// Ends the visitor's session, and returns the identity provider's logout
// page, which the browser follows to end the provider's session too.
export async function logout(api: ApiClient): Promise<string> {
  const request = 'POST /v1/auth/logout'
  // The API answers 415 to a POST that isn't JSON, as for the session.
  const { data, response } = await api
    .POST('/v1/auth/logout', { headers: { 'Content-Type': 'application/json' } })
    .catch((cause: unknown) => {
      throw new ApiUnreachable(request, { cause })
    })
  if (data === undefined) throw new ApiError(request, response)
  return data.data.logout_url
}

export type AccountPlayer = components['schemas']['AccountPlayer']
// An answer to "Is this you?". `same_as` names the managed player that the
// answered player is.
export type Reply =
  | { answer: Exclude<components['schemas']['Answer'], 'same_as'> }
  | { answer: 'same_as'; player_id: string }
// What an answer did. A merge names the player that survived and the one
// that merged into it.
export type AnswerMeta = components['schemas']['AnswerResponse']['meta']

// The players the account manages, each with whether it still waits for the
// "Is this you?" answer. A guest account never has a question, so pages ask
// only for a verified account.
export function accountPlayersQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ['v1', 'account', 'players'],
    queryFn: async ({ signal }) => {
      const request = 'GET /v1/account/players'
      const { data, response } = await api
        .GET('/v1/account/players', { signal })
        .catch((cause: unknown) => {
          throw new ApiUnreachable(request, { cause })
        })
      if (data === undefined) throw new ApiError(request, response)
      return data.data
    },
  })
}

// Answers "Is this you?" for one player. The API returns what the answer did
// and the account's players after it, so the players query takes them as
// they are. When the answer changes the account's self player, the session's
// account takes it too, for the topbar's avatar. Refetching the session would
// start it again. A players request already in flight read the list from
// before the answer, so the answer cancels it first.
export function answerQuestionMutation(api: ApiClient, queryClient: QueryClient) {
  return {
    onMutate: () => queryClient.cancelQueries({ queryKey: accountPlayersQuery(api).queryKey }),
    mutationFn: async ({ player, reply }: { player: AccountPlayer; reply: Reply }) => {
      const request = 'POST /v1/account/players/{player_id}/answer'
      const { data, response } = await api
        .POST('/v1/account/players/{player_id}/answer', {
          params: { path: { player_id: player.id } },
          body: reply,
        })
        .catch((cause: unknown) => {
          throw new ApiUnreachable(request, { cause })
        })
      if (data === undefined) throw new ApiError(request, response)
      return { players: data.data, meta: data.meta }
    },
    onSuccess: ({ players, meta }: { players: AccountPlayer[]; meta: AnswerMeta }) => {
      queryClient.setQueryData(accountPlayersQuery(api).queryKey, players)
      const self = players.find((player) => player.relationship === 'self')
      const selfChanged =
        meta.outcome === 'self' || (meta.outcome === 'merged' && meta.survivor === self?.id)
      if (!self || !selfChanged) return
      queryClient.setQueryData(sessionQuery(api).queryKey, (account) =>
        account && { ...account, player: { id: self.id, display_name: self.display_name } },
      )
    },
  }
}
