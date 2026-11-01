import { QueryClient, queryOptions } from '@tanstack/react-query'
import type { ApiClient } from './client'
import type { components } from './schema'
import { ApiError, ApiUnreachable, classifyFailure } from './errors'
import { forgetAccount, saveAccount, savedAccount, type SessionAccount } from './savedSession'

// Retries a network error or a 5xx only, which can pass. A 4xx comes back the
// same. A retry after a lost POST /v1/session response can leave one unused
// guest account, which is an accepted cost.
export function shouldRetry(failureCount: number, error: Error): boolean {
  return failureCount < 3 && (!(error instanceof ApiError) || error.status >= 500)
}

// openapi-fetch sends no Content-Type for a request with no body, and the
// API answers 415 to a write that isn't JSON. So a bodyless POST or DELETE
// sends this.
const JSON_HEADERS = { 'Content-Type': 'application/json' }

// Sends `request` and returns its body. Throws ApiUnreachable when no
// response came back, and ApiError when the API answered with an error.
async function send<Data>(
  request: string,
  sent: Promise<{ data?: Data; error?: unknown; response: Response }>,
): Promise<Data> {
  const { data, error, response } = await sent.catch((cause: unknown) => {
    throw new ApiUnreachable(request, { cause })
  })
  if (!response.ok) throw new ApiError(request, response, error)
  return data as Data
}

// The app's QueryClient. Tests make their own, with retries off.
export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } })
}

// How long a page load with a saved account waits for the session before it
// shows the saved account instead. A hall's weak signal can hold a request
// far longer than the connection takes to fail.
export const OFFLINE_AFTER_MS = 2000

const SESSION_KEY = ['v1', 'session'] as const

type SessionOutcome =
  | { kind: 'answered'; account: SessionAccount }
  | { kind: 'failed'; error: unknown }
  | { kind: 'slow' }

// The visitor's account, from resuming their session or starting a guest
// account. The `_authenticated` route's loader waits on it before showing a
// page. It runs once per page load: it never goes stale, so revisiting those
// pages doesn't start the session again.
//
// Each account it gets is saved. With a saved account, a load that can't
// reach the API, or waits OFFLINE_AFTER_MS for it, shows the saved account.
// The request goes on: its answer replaces the saved account, and a request
// that never got through starts again when the browser comes back online.
// Any other failure shows as before, and with nothing saved so does every
// failure.
export function sessionQuery(api: ApiClient) {
  return queryOptions({
    queryKey: SESSION_KEY,
    staleTime: Infinity,
    // The default mode pauses a fetch while TanStack thinks the browser is
    // offline, which would hold the loading screen up with nothing to show.
    networkMode: 'always',
    // No `signal`: aborting the request can't stop the API starting a guest
    // account, but it drops the response and its cookie. The query would
    // then start another account, e.g. when StrictMode remounts the layout.
    queryFn: async ({ client }) => {
      const request = send(
        'POST /v1/session',
        api.POST('/v1/session', { headers: JSON_HEADERS }),
      ).then(({ data }) => {
        saveAccount(data.account)
        return data.account
      })
      const saved = savedAccount()
      if (!saved) return request

      const refetchWhenOnline = () =>
        // TanStack's onlineManager starts online and changes only on an
        // `offline` event, so it never reports a page that loaded offline
        // coming back.
        window.addEventListener(
          'online',
          () => void client.refetchQueries({ queryKey: SESSION_KEY }),
          { once: true },
        )
      const unreachable = (error: unknown) => classifyFailure(error).kind === 'unreachable'

      const outcome = await raceSession(request)
      switch (outcome.kind) {
        case 'answered':
          return outcome.account
        case 'failed':
          if (!unreachable(outcome.error)) throw outcome.error
          refetchWhenOnline()
          return saved
        case 'slow':
          request.then(
            (account) => client.setQueryData(SESSION_KEY, account),
            (error: unknown) => {
              if (unreachable(error)) refetchWhenOnline()
            },
          )
          return saved
      }
    },
  })
}

function raceSession(request: Promise<SessionAccount>): Promise<SessionOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<SessionOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'slow' }), OFFLINE_AFTER_MS)
  })
  const settled = request.then(
    (account): SessionOutcome => ({ kind: 'answered', account }),
    (error: unknown): SessionOutcome => ({ kind: 'failed', error }),
  )
  return Promise.race([settled, slow]).finally(() => clearTimeout(timer))
}

// Ends the visitor's session, and returns the identity provider's logout
// page, which the browser follows to end the provider's session too. It
// forgets the saved account, so an offline load after it doesn't show the
// account that signed out.
export async function logout(api: ApiClient): Promise<string> {
  const data = await send(
    'POST /v1/auth/logout',
    api.POST('/v1/auth/logout', { headers: JSON_HEADERS }),
  )
  forgetAccount()
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
      const data = await send('GET /v1/account/players', api.GET('/v1/account/players', { signal }))
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
      const data = await send(
        'POST /v1/account/players/{player_id}/answer',
        api.POST('/v1/account/players/{player_id}/answer', {
          params: { path: { player_id: player.id } },
          body: reply,
        }),
      )
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

export type AdminPermission = components['schemas']['AdminPermission']
export type AdminRole = components['schemas']['AdminRole']
export type AdminAccount = components['schemas']['AdminAccount']
export type RoleDraft = components['schemas']['RoleRequest']
export type PermissionDraft = components['schemas']['NewPermissionRequest']

// Every admin list starts with this key, so one write can refresh them all.
const ADMIN_KEY = ['v1', 'admin'] as const

// Every permission, with how many roles grant it.
export function adminPermissionsQuery(api: ApiClient) {
  return queryOptions({
    queryKey: [...ADMIN_KEY, 'permissions'],
    queryFn: async ({ signal }) => {
      const data = await send(
        'GET /v1/admin/permissions',
        api.GET('/v1/admin/permissions', { signal }),
      )
      return data.data
    },
  })
}

// Every role, with its permissions and how many accounts hold it.
export function adminRolesQuery(api: ApiClient) {
  return queryOptions({
    queryKey: [...ADMIN_KEY, 'roles'],
    queryFn: async ({ signal }) => {
      const data = await send('GET /v1/admin/roles', api.GET('/v1/admin/roles', { signal }))
      return data.data
    },
  })
}

// The first 50 verified accounts whose email contains `email`, and whether
// more match.
export function adminAccountsQuery(api: ApiClient, email: string) {
  return queryOptions({
    queryKey: [...ADMIN_KEY, 'accounts', email],
    queryFn: async ({ signal }) => {
      const data = await send(
        'GET /v1/admin/accounts',
        api.GET('/v1/admin/accounts', {
          params: { query: email ? { email } : {} },
          signal,
        }),
      )
      return { accounts: data.data, hasMore: data.meta.has_more }
    },
  })
}

export async function createPermission(api: ApiClient, draft: PermissionDraft): Promise<void> {
  await send('POST /v1/admin/permissions', api.POST('/v1/admin/permissions', { body: draft }))
}

export async function updatePermission(
  api: ApiClient,
  { key, description }: PermissionDraft,
): Promise<void> {
  await send(
    'PUT /v1/admin/permissions/{key}',
    api.PUT('/v1/admin/permissions/{key}', {
      params: { path: { key } },
      body: { description },
    }),
  )
}

export async function deletePermission(api: ApiClient, key: string): Promise<void> {
  await send(
    'DELETE /v1/admin/permissions/{key}',
    api.DELETE('/v1/admin/permissions/{key}', {
      params: { path: { key } },
      headers: JSON_HEADERS,
    }),
  )
}

export async function createRole(api: ApiClient, draft: RoleDraft): Promise<void> {
  await send('POST /v1/admin/roles', api.POST('/v1/admin/roles', { body: draft }))
}

export async function updateRole(
  api: ApiClient,
  { id, ...draft }: RoleDraft & { id: string },
): Promise<void> {
  await send(
    'PUT /v1/admin/roles/{role_id}',
    api.PUT('/v1/admin/roles/{role_id}', { params: { path: { role_id: id } }, body: draft }),
  )
}

export async function deleteRole(api: ApiClient, id: string): Promise<void> {
  await send(
    'DELETE /v1/admin/roles/{role_id}',
    api.DELETE('/v1/admin/roles/{role_id}', {
      params: { path: { role_id: id } },
      headers: JSON_HEADERS,
    }),
  )
}

// Gives the account exactly the roles `roleIds` names.
export async function setAccountRoles(
  api: ApiClient,
  { accountId, roleIds }: { accountId: string; roleIds: string[] },
): Promise<void> {
  await send(
    'PUT /v1/admin/accounts/{account_id}/roles',
    api.PUT('/v1/admin/accounts/{account_id}/roles', {
      params: { path: { account_id: accountId } },
      body: { role_ids: roleIds },
    }),
  )
}

// After a write to roles, permissions or who holds them. Each list counts
// what the others hold, so all of them fetch again. The visitor's own
// permissions can change too, but the session never goes stale, so it
// fetches again here. A resumed session starts no guest account.
export async function refreshAfterAdminWrite(
  api: ApiClient,
  queryClient: QueryClient,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ADMIN_KEY }),
    queryClient.refetchQueries({ queryKey: sessionQuery(api).queryKey }),
  ])
}
