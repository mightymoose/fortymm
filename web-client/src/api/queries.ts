import { QueryClient, queryOptions } from '@tanstack/react-query'
import type { ApiClient } from './client'
import type { components } from './schema'
import { ApiError, ApiUnreachable, classifyFailure } from './errors'
import { forgetAccount, saveAccount, savedAccount, type SessionAccount } from './savedSession'
import type {
  GameScore,
  MatchDetail,
  MatchRecord,
  MatchStatus,
  Side,
} from '../pages/matches/browse/match'
import { hex } from '../signing/bytes'
import { registerDeviceKey, takeKey } from '../signing/deviceKey'

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
export async function send<Data>(
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

// Each client's session request on its way. A run that ended as `slow`
// leaves its request going, and a refetch joins it rather than sending
// another, which could start a second guest account.
const sessionsInFlight = new WeakMap<ApiClient, Promise<SessionAccount>>()

function startSession(api: ApiClient): Promise<SessionAccount> {
  const inFlight = sessionsInFlight.get(api)
  if (inFlight) return inFlight
  const request = send('POST /v1/session', api.POST('/v1/session', { headers: JSON_HEADERS })).then(({ data }) => {
    saveAccount(data.account)
    // Not awaited, so the key never holds up the loading screen.
    void registerDeviceKey(api, data.account.id)
    return data.account
  })
  sessionsInFlight.set(api, request)
  const settle = () => {
    if (sessionsInFlight.get(api) === request) sessionsInFlight.delete(api)
  }
  request.then(settle, settle)
  return request
}

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
      const request = startSession(api)
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
// deletes this browser's signing key and signs it out on the API, so the
// next account gets a new one. A failed logout puts the key back. It
// forgets the saved account, so an offline load after it doesn't show the
// account that signed out.
export async function logout(api: ApiClient): Promise<string> {
  const key = await takeKey()
  const data = await send(
    'POST /v1/auth/logout',
    api.POST(
      '/v1/auth/logout',
      key.id ? { body: { signing_key_id: key.id } } : { headers: JSON_HEADERS },
    ),
  ).catch(async (error: unknown) => {
    await key.restore()
    throw error
  })
  await key.release()
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
// only for a verified account. Each fetch gives the session the list's self
// player, which another tab's answer can change.
export function accountPlayersQuery(api: ApiClient) {
  return queryOptions({
    queryKey: ['v1', 'account', 'players'],
    queryFn: async ({ signal, client }) => {
      const data = await send('GET /v1/account/players', api.GET('/v1/account/players', { signal }))
      takeSelfPlayer(api, client, data.data)
      return data.data
    },
  })
}

// Gives the session's account the self player of `players`, the account's
// players as the API just listed them, for the topbar's avatar and New
// match. It saves the account too, so an offline load shows that player.
// Refetching the session would start it again, and needs the network.
function takeSelfPlayer(api: ApiClient, queryClient: QueryClient, players: readonly AccountPlayer[]) {
  const self = players.find((player) => player.relationship === 'self')
  const account = queryClient.getQueryData(sessionQuery(api).queryKey)
  if (!self || !account || account.player.id === self.id) return
  const taken = { ...account, player: { id: self.id, display_name: self.display_name } }
  queryClient.setQueryData(sessionQuery(api).queryKey, taken)
  saveAccount(taken)
}

// Answers "Is this you?" for one player. The API returns what the answer did
// and the account's players after it, so the players query takes them as
// they are, and the session's account takes their self player. Any answer,
// even one another tab got to first, can change it. A players request
// already in flight read the list from before the answer, so the answer
// cancels it first.
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
    onSuccess: ({ players }: { players: AccountPlayer[] }) => {
      queryClient.setQueryData(accountPlayersQuery(api).queryKey, players)
      takeSelfPlayer(api, queryClient, players)
    },
  }
}

// The statuses whose title is FortyMM's reason for refusing a result.
// A 403 is an account without `matches.score`, which more tries won't fix.
const REFUSAL_STATUSES = new Set([403, 404, 409, 422])

// What FortyMM said of an approved result: it checked out, or it refused
// the result, with the API's reason.
export type ApprovalVerdict = { kind: 'accepted' } | { kind: 'refused'; title: string }

// Sends an approved result to FortyMM, which checks it and records it. The
// same envelope again is a retry that FortyMM answers the same, so it is a
// query keyed by the envelope, and a reload of an approved link sends it
// again. `matchId` is the payload's match. A 403, 404, 409 or 422 with a
// title is a verdict, the 404 for a match FortyMM doesn't know. Anything else,
// such as no network, throws to the boundary.
export function approvalCheckQuery(api: ApiClient, matchId: string, envelope: Uint8Array<ArrayBuffer>) {
  const envelopeHex = hex(envelope)
  return queryOptions({
    queryKey: ['v1', 'matches', matchId, 'approvals', envelopeHex],
    staleTime: Infinity,
    // Offline, the check fails and shows Try again rather than pausing.
    networkMode: 'always',
    queryFn: async (): Promise<ApprovalVerdict> => {
      try {
        await send(
          'POST /v1/matches/{match_id}/approvals',
          api.POST('/v1/matches/{match_id}/approvals', {
            params: { path: { match_id: matchId } },
            body: { envelope: envelopeHex },
          }),
        )
        return { kind: 'accepted' }
      } catch (error) {
        if (error instanceof ApiError && REFUSAL_STATUSES.has(error.status) && error.title) {
          return { kind: 'refused', title: error.title }
        }
        throw error
      }
    },
  })
}

export type AdminPermission = components['schemas']['AdminPermission']
export type AdminRole = components['schemas']['AdminRole']
export type AdminAccount = components['schemas']['AdminAccount']
export type AdminAccountDetail = components['schemas']['AdminAccountDetail']
export type AccountView = components['schemas']['AccountView']
export type AdminSigningKey = components['schemas']['AdminSigningKey']
export type AdminPlayer = components['schemas']['AdminPlayer']
export type AdminPlayerDetail = components['schemas']['AdminPlayerDetail']
export type RoleDraft = components['schemas']['RoleRequest']
export type PermissionDraft = components['schemas']['NewPermissionRequest']

export type Verified<T extends { kind: string; email: string | null }> = T & {
  kind: 'verified'
  email: string
}

// A verified account always has an email, which the schema can't say.
export function isVerified<T extends { kind: string; email: string | null }>(
  account: T,
): account is Verified<T> {
  return account.kind === 'verified'
}

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

// The first 50 of the view's accounts whose email or player name contains
// `search`, and whether more match.
export function adminAccountsQuery(api: ApiClient, view: AccountView, search: string) {
  return queryOptions({
    queryKey: [...ADMIN_KEY, 'accounts', { view, search }],
    queryFn: async ({ signal }) => {
      const data = await send(
        'GET /v1/admin/accounts',
        api.GET('/v1/admin/accounts', {
          params: { query: search ? { view, search } : { view } },
          signal,
        }),
      )
      return { accounts: data.data, hasMore: data.meta.has_more }
    },
  })
}

// One account for its admin page, a guest's too, with every role and whether
// it holds each. Null if no account has the id, such as an adopted one's.
export function adminAccountQuery(api: ApiClient, id: string) {
  return queryOptions({
    queryKey: [...ADMIN_KEY, 'accounts', 'detail', id],
    queryFn: async ({ signal }): Promise<AdminAccountDetail | null> => {
      try {
        const data = await send(
          'GET /v1/admin/accounts/{account_id}',
          api.GET('/v1/admin/accounts/{account_id}', {
            params: { path: { account_id: id } },
            signal,
          }),
        )
        return data.data
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 422)) return null
        throw error
      }
    },
  })
}

// The first 50 players whose display name contains `name`, and whether more
// match. A merged player isn't listed.
export function adminPlayersQuery(api: ApiClient, name: string) {
  return queryOptions({
    queryKey: [...ADMIN_KEY, 'players', name],
    queryFn: async ({ signal }) => {
      const data = await send(
        'GET /v1/admin/players',
        api.GET('/v1/admin/players', {
          params: { query: name ? { name } : {} },
          signal,
        }),
      )
      return { players: data.data, hasMore: data.meta.has_more }
    },
  })
}

// One player for its admin page, merged or not, with its managers and
// leagues. Null if no player has the id.
export function adminPlayerQuery(api: ApiClient, id: string) {
  return queryOptions({
    queryKey: [...ADMIN_KEY, 'players', 'detail', id],
    queryFn: async ({ signal }): Promise<AdminPlayerDetail | null> => {
      try {
        const data = await send(
          'GET /v1/admin/players/{player_id}',
          api.GET('/v1/admin/players/{player_id}', {
            params: { path: { player_id: id } },
            signal,
          }),
        )
        return data.data
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 422)) return null
        throw error
      }
    },
  })
}

export function adminSigningKeysQuery(api: ApiClient, search: string) {
  return queryOptions({
    queryKey: [...ADMIN_KEY, 'signing-keys', search],
    queryFn: async ({ signal }) => {
      const data = await send(
        'GET /v1/admin/signing-keys',
        api.GET('/v1/admin/signing-keys', {
          params: { query: search ? { search } : {} },
          signal,
        }),
      )
      return { keys: data.data, hasMore: data.meta.has_more }
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

export async function revokeSigningKey(api: ApiClient, id: string): Promise<void> {
  await send(
    'POST /v1/admin/signing-keys/{key_id}/revoke',
    api.POST('/v1/admin/signing-keys/{key_id}/revoke', {
      params: { path: { key_id: id } },
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

// After an admin write. Each list counts what the others hold, so all of
// them fetch again. The visitor's own
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

export type MatchRequest = components['schemas']['MatchRequest']
export type Opponent = components['schemas']['Opponent']

const MATCHES_KEY = ['v1', 'matches'] as const
// Every opponents list starts with this key, so a new match can refresh them.
export const OPPONENTS_KEY = [...MATCHES_KEY, 'opponents'] as const

// The players the account can pick to play. With no search, its recent
// opponents, most recent first. With a search, the players whose name
// contains it.
export function opponentsQuery(api: ApiClient, search: string) {
  return queryOptions({
    queryKey: [...OPPONENTS_KEY, search],
    // The lists change only when the account makes a match, which refreshes them.
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const data = await send(
        'GET /v1/matches/opponents',
        api.GET('/v1/matches/opponents', { params: { query: search ? { search } : {} }, signal }),
      )
      return data.data
    },
  })
}

type MatchSummary = components['schemas']['MatchSummary']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const gameScores = (games: number[][]): GameScore[] => games.map(([a, b]) => [a, b])

function parseStatus(state: MatchSummary['state']): MatchStatus {
  switch (state.kind) {
    case 'not_started':
      return { kind: 'new' }
    case 'live':
      return { kind: 'live' }
    case 'awaiting':
      return { kind: 'awaiting', signedBy: state.signed_by, signedAt: state.signed_at }
    case 'disputed':
      return {
        kind: 'disputed',
        signedBy: state.signed_by,
        signedAt: state.signed_at,
        theirGames: gameScores(state.their_games),
      }
    case 'final':
      return {
        kind: 'final',
        acceptedAt: state.accepted_at,
        approvedBy: state.approved_by,
        overrideReason: state.override_reason,
      }
  }
}

// A match as the pages show it. Each side shows its first player, because
// every match is singles so far.
function parseMatch(match: MatchSummary): MatchRecord {
  const player = (side: Side) => ({
    name: match.sides[side].players[0].display_name,
    you: match.viewer_side === side,
  })
  return {
    id: match.id,
    bestOf: match.best_of,
    rated: match.rated,
    players: [player(0), player(1)],
    games: gameScores(match.games),
    retiredBy: match.retired_by,
    startedAt: match.started_at,
    status: parseStatus(match.state),
  }
}

// The 50 newest matches, everyone's, and whether more exist.
export function matchesQuery(api: ApiClient) {
  return queryOptions({
    queryKey: [...MATCHES_KEY, 'list'],
    queryFn: async ({ signal }) => {
      const data = await send('GET /v1/matches', api.GET('/v1/matches', { signal }))
      return { matches: data.data.map(parseMatch), hasMore: data.meta.has_more }
    },
  })
}

// One match with its history, or null if no match has the id. An id that
// isn't a uuid can't be one, so it sends nothing.
export function matchQuery(api: ApiClient, id: string) {
  return queryOptions({
    queryKey: [...MATCHES_KEY, 'detail', id],
    queryFn: async ({ signal }): Promise<MatchDetail | null> => {
      if (!UUID.test(id)) return null
      try {
        const { data } = await send(
          'GET /v1/matches/{match_id}',
          api.GET('/v1/matches/{match_id}', { params: { path: { match_id: id } }, signal }),
        )
        return {
          ...parseMatch(data),
          history: data.history.map((event) => ({ ...event, games: gameScores(event.games ?? []) })),
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null
        throw error
      }
    },
    // A spectator follows the score until the result counts. A hidden tab
    // doesn't refetch (TanStack's default).
    refetchInterval: (query) => (query.state.data && query.state.data.status.kind !== 'final' ? 10_000 : false),
  })
}

// Makes the match. Its id is made on the client, so the same request
// again finds the match it made and answers it the same.
export async function createMatch(api: ApiClient, request: MatchRequest): Promise<void> {
  await send('POST /v1/matches', api.POST('/v1/matches', { body: request }))
}
