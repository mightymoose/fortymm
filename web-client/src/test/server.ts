import { act } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { components } from '../api/schema'

// The API's base URL in unit tests. Node's Request rejects the app's
// relative `/api`.
export const API_BASE_URL = 'http://localhost/api'

export const sessionResponse: components['schemas']['SessionResponse'] = {
  data: {
    account: {
      id: '0b9e3c1e-58f4-4c84-9a59-2d0b6f3f6a10',
      kind: 'guest',
      email: null,
      player: {
        id: 'c4a8f6a2-1f0e-4a63-8d2e-7f5b9e1c3d42',
        display_name: 'excited egret 387',
      },
      permissions: [],
    },
  },
}

export const logoutResponse: components['schemas']['LogoutResponse'] = {
  data: {
    logout_url:
      'https://fortymm.example/v2/logout?client_id=test&returnTo=http%3A%2F%2Flocalhost%2F',
  },
}

type RegisterKeyRequest = components['schemas']['RegisterKeyRequest']
// How the mock API answers a signing key registration: the key is the
// account's and live, the account's and revoked, or another account's.
export type KeyAnswer = 'live' | 'revoked' | 'taken'

function signingKeyResponse(answer: 'live' | 'revoked'): components['schemas']['SigningKeyResponse'] {
  return {
    data: {
      id: '77517e3498d560ace130b511db2f41114abccf80abb69e82ef0d343c39b26755',
      label: 'Web browser',
      created_at: '2026-11-02T09:30:00Z',
      signed_out_at: null,
      revoked_at: answer === 'revoked' ? '2026-11-02T09:31:00Z' : null,
    },
  }
}

type ApprovalRequest = components['schemas']['ApprovalRequest']

// The API's 201 to a result it recorded.
function approvalResponse(matchId: string): components['schemas']['ApprovalResponse'] {
  return {
    data: {
      hash: '9c1185a5c5e9fc54612808977ee8f548b2258d31f9c5c8a5bbbf3f0d0f0e0a7b',
      match_id: matchId,
      approvals: [],
      accepted_at: null,
    },
  }
}

// The mock API for unit tests, started in setupTests.ts. Tests override a
// handler for themselves with `server.use()`.
export const server = setupServer(
  http.post(`${API_BASE_URL}/v1/session`, () =>
    HttpResponse.json(sessionResponse),
  ),
  http.post(`${API_BASE_URL}/v1/auth/logout`, () => HttpResponse.json(logoutResponse)),
  http.post(`${API_BASE_URL}/v1/account/signing-keys`, () =>
    HttpResponse.json(signingKeyResponse('live')),
  ),
  http.get(`${API_BASE_URL}/v1/account/players`, () =>
    HttpResponse.json<components['schemas']['AccountPlayersResponse']>({ data: [] }),
  ),
  http.get(`${API_BASE_URL}/v1/matches/opponents`, () =>
    HttpResponse.json<components['schemas']['OpponentsResponse']>({ data: [] }),
  ),
  http.post<{ matchId: string }>(`${API_BASE_URL}/v1/matches/:matchId/approvals`, ({ params }) =>
    HttpResponse.json(approvalResponse(params.matchId), { status: 201 }),
  ),
  http.get(`${API_BASE_URL}/v1/admin/permissions`, () =>
    HttpResponse.json<components['schemas']['AdminPermissionsResponse']>({ data: [] }),
  ),
  http.get(`${API_BASE_URL}/v1/admin/roles`, () =>
    HttpResponse.json<components['schemas']['AdminRolesResponse']>({ data: [] }),
  ),
  http.get(`${API_BASE_URL}/v1/admin/accounts`, () =>
    HttpResponse.json<components['schemas']['AdminAccountsResponse']>({
      data: [],
      meta: { has_more: false },
    }),
  ),
  http.get(`${API_BASE_URL}/v1/admin/signing-keys`, () =>
    HttpResponse.json<components['schemas']['AdminSigningKeysResponse']>({
      data: [],
      meta: { has_more: false },
    }),
  ),
  http.get(`${API_BASE_URL}/v1/admin/players`, () =>
    HttpResponse.json<components['schemas']['AdminPlayersResponse']>({
      data: [],
      meta: { has_more: false },
    }),
  ),
)

// Records each signing key registration, and answers them with `answers` in
// order, then `live`. With `hold`, each answer waits until the test calls
// release().
export function mockSigningKeys(answers: KeyAnswer[] = [], { hold = false } = {}) {
  const registrations: RegisterKeyRequest[] = []
  const pending: (() => void)[] = []
  server.use(
    http.post<never, RegisterKeyRequest>(
      `${API_BASE_URL}/v1/account/signing-keys`,
      async ({ request }) => {
        registrations.push(await request.json())
        if (hold) await new Promise<void>((resolve) => pending.push(resolve))
        const answer = answers.shift() ?? 'live'
        if (answer === 'taken') {
          return HttpResponse.json(
            { errors: [{ status: '409', title: 'Another account registered this key' }] },
            { status: 409 },
          )
        }
        return HttpResponse.json(signingKeyResponse(answer))
      },
    ),
  )
  return {
    registrations,
    async release(): Promise<void> {
      await act(async () => pending.splice(0).forEach((resolve) => resolve()))
    },
  }
}

// How the mock API answers a result's approvals: they check out, it refuses
// them with this title (a 422), or no response comes back.
// A refusal answers 422 unless it names another status, such as 409.
export type ApprovalAnswer = 'accepted' | { refused: string; status?: number } | 'unreachable'

// Records each approval check, by match id and envelope, and answers with
// `answer`, which a test can change. With `hold`, each answer waits until
// the test calls release().
export function mockApprovals(answer: ApprovalAnswer = 'accepted', { hold = false } = {}) {
  const checks: { matchId: string; envelope: string }[] = []
  const pending: (() => void)[] = []
  const mock = {
    checks,
    answer,
    async release(): Promise<void> {
      await act(async () => pending.splice(0).forEach((resolve) => resolve()))
    },
  }
  server.use(
    http.post<{ matchId: string }, ApprovalRequest>(
      `${API_BASE_URL}/v1/matches/:matchId/approvals`,
      async ({ params, request }) => {
        const { envelope } = await request.json()
        checks.push({ matchId: params.matchId, envelope })
        if (hold) await new Promise<void>((resolve) => pending.push(resolve))
        if (mock.answer === 'unreachable') return HttpResponse.error()
        if (mock.answer === 'accepted') {
          return HttpResponse.json(approvalResponse(params.matchId), { status: 201 })
        }
        const status = mock.answer.status ?? 422
        return HttpResponse.json(
          { errors: [{ status: String(status), title: mock.answer.refused }] },
          { status },
        )
      },
    ),
  )
  return mock
}

// Holds the mock API's session responses until the test sends them.
export function holdSession() {
  const requests: Request[] = []
  const pending: ((response: Response) => void)[] = []
  server.use(
    http.post(`${API_BASE_URL}/v1/session`, ({ request }) => {
      requests.push(request)
      return new Promise<Response>((resolve) => pending.push(resolve))
    }),
  )
  return {
    requests,
    async respond(response: Response): Promise<void> {
      await act(async () => pending.shift()!(response))
    },
  }
}

// Answers the session with the default guest holding `permissions`.
export function grantSession(...permissions: string[]) {
  server.use(
    http.post(`${API_BASE_URL}/v1/session`, () =>
      HttpResponse.json<components['schemas']['SessionResponse']>({
        data: { account: { ...sessionResponse.data.account, permissions } },
      }),
    ),
  )
}

// Makes every session request fail with no response, as with no network.
export function failSession() {
  server.use(http.post(`${API_BASE_URL}/v1/session`, () => HttpResponse.error()))
}

// Holds the mock API's players responses until the test releases them. Then
// the handler set before this one answers, such as mockVerifiedAccount()'s.
export function holdPlayers() {
  const pending: (() => void)[] = []
  server.use(
    http.get(
      `${API_BASE_URL}/v1/account/players`,
      () => new Promise<undefined>((resolve) => pending.push(() => resolve(undefined))),
    ),
  )
  return {
    async release(): Promise<void> {
      await act(async () => pending.splice(0).forEach((resolve) => resolve()))
    },
  }
}

// Makes the mock API's next players request fail with `status`. The
// requests after it reach the handler set before this one.
export function failPlayersOnce(status: number) {
  server.use(
    http.get(
      `${API_BASE_URL}/v1/account/players`,
      () => HttpResponse.json({ errors: [{ status: String(status), title: 'Failed' }] }, { status }),
      { once: true },
    ),
  )
}

type AccountPlayer = components['schemas']['AccountPlayer']
type AnswerRequest = components['schemas']['AnswerRequest']
type AnswerMeta = components['schemas']['AnswerResponse']['meta']
type Refusal = { status: number; title: string }
const PLAYED_EACH_OTHER: Refusal = {
  status: 409,
  title: 'These players played each other, so they are two people',
}

// A player as the players list gives it, with no matches. `played_against`
// defaults to none.
export function listedPlayer(
  player: Pick<AccountPlayer, 'id' | 'display_name' | 'relationship' | 'open_question'> &
    Partial<Pick<AccountPlayer, 'played_against'>>,
): AccountPlayer {
  return { played_against: [], ...player, match_count: 0, recent_matches: [] }
}

// The self player that an answer gives an account it leaves with none.
export const STAND_IN = listedPlayer({
  id: '6d5c4b3a-2f1e-4d0c-8b9a-7f6e5d4c3b2a',
  display_name: 'calm crane 765',
  relationship: 'self',
  open_question: false,
})

// Signs the mock API in as a verified account that manages `players`, and
// answers "Is this you?" as the API does. Returns the answers it received,
// and answerInAnotherTab(), which answers without the page knowing. One of
// `players` is the account's self player, and they are in the order the API
// made them. So a merge keeps the first of the two, and it refuses two
// players who played each other. An answer that leaves the account no self
// player makes STAND_IN its self player, as the API does. `failAnswers`
// makes every answer fail with a 500. playersChange() replaces the players,
// as a match recorded meanwhile can.
export function mockVerifiedAccount(
  players: AccountPlayer[],
  { failAnswers = false }: { failAnswers?: boolean } = {},
) {
  let current = players
  const answers: ({ playerId: string } & AnswerRequest)[] = []
  const self = () => {
    const found = current.find((player) => player.relationship === 'self')
    if (!found) throw new Error('The account has no self player')
    return { id: found.id, display_name: found.display_name }
  }

  // The older player survives, takes the relationship of `into`, and plays
  // as both.
  function merge(player: AccountPlayer, into: AccountPlayer): AnswerMeta | Refusal {
    if (player.played_against.includes(into.id)) return PLAYED_EACH_OTHER
    const [survivor, merged] =
      current.indexOf(into) < current.indexOf(player) ? [into, player] : [player, into]
    const as = (id: string) => (id === merged.id ? survivor.id : id)
    current = current.flatMap((found) => {
      if (found === merged) return []
      const played_against = [...new Set(found.played_against.map(as))]
      if (found !== survivor) return [{ ...found, played_against }]
      return [
        {
          ...found,
          relationship: into.relationship,
          open_question: false,
          played_against: [...new Set([...played_against, ...merged.played_against])],
        },
      ]
    })
    return { outcome: 'merged', survivor: survivor.id, merged: merged.id }
  }

  // The API's answer: the outcome, or the status it refuses with.
  function answer(playerId: string, request: AnswerRequest): AnswerMeta | Refusal | 404 | 409 | 422 {
    const found = settle(playerId, request)
    if (!current.some((player) => player.relationship === 'self')) current = [...current, STAND_IN]
    return found
  }

  function settle(playerId: string, request: AnswerRequest): AnswerMeta | Refusal | 404 | 409 | 422 {
    if (request.answer === 'same_as' && request.player_id === playerId) return 422
    const answered = current.find((player) => player.id === playerId)
    if (!answered) return 404
    const target = current.find(
      (player) =>
        player.id === request.player_id &&
        player.relationship === 'managed' &&
        !player.open_question,
    )
    if (request.answer === 'same_as' && !target) return 404
    if (!answered.open_question) {
      return request.answer === 'not_mine' ? 409 : { outcome: 'already_answered' }
    }
    const close = (relationship: AccountPlayer['relationship']) => {
      current = current.map((player) =>
        player === answered ? { ...player, relationship, open_question: false } : player,
      )
    }
    const own = current.find((player) => player.relationship === 'self' && player !== answered)
    switch (request.answer) {
      case 'yes':
        if (own && !own.open_question) return merge(answered, own)
        // An own player whose question is open steps down, and keeps it.
        current = current.map((player) => (player === own ? { ...player, relationship: 'managed' } : player))
        close('self')
        return { outcome: 'self' }
      case 'no':
        close('managed')
        return { outcome: 'managed' }
      case 'not_mine':
        current = current.filter((player) => player !== answered)
        return { outcome: 'removed' }
      case 'same_as':
        return merge(answered, target!)
    }
  }

  server.use(
    http.post(`${API_BASE_URL}/v1/session`, () =>
      HttpResponse.json<components['schemas']['SessionResponse']>({
        data: {
          account: {
            ...sessionResponse.data.account,
            kind: 'verified',
            email: 'ann@example.com',
            player: self(),
          },
        },
      }),
    ),
    http.get(`${API_BASE_URL}/v1/account/players`, () =>
      HttpResponse.json<components['schemas']['AccountPlayersResponse']>({ data: current }),
    ),
    http.post<{ playerId: string }, AnswerRequest>(
      `${API_BASE_URL}/v1/account/players/:playerId/answer`,
      async ({ params, request }) => {
        const body = await request.json()
        answers.push({ playerId: params.playerId, ...body })
        let meta = failAnswers ? 500 : answer(params.playerId, body)
        if (typeof meta === 'number') meta = { status: meta, title: 'Refused' }
        if ('status' in meta) {
          return HttpResponse.json(
            { errors: [{ status: String(meta.status), title: meta.title }] },
            { status: meta.status },
          )
        }
        return HttpResponse.json<components['schemas']['AnswerResponse']>({ data: current, meta })
      },
    ),
  )
  return {
    answers,
    // Answers as another tab would, so the page still shows the players
    // from before.
    answerInAnotherTab(playerId: string, request: AnswerRequest): void {
      answer(playerId, request)
    },
    playersChange(players: AccountPlayer[]): void {
      current = players
    },
  }
}

type AdminPermission = components['schemas']['AdminPermission']
type AdminRole = components['schemas']['AdminRole']
type AdminAccount = components['schemas']['AdminAccount']
type AdminSigningKey = components['schemas']['AdminSigningKey']
type AdminPlayerDetail = components['schemas']['AdminPlayerDetail']
// The admin lists the mock API holds. It counts each permission's roles and
// each role's accounts itself.
export type AdminState = {
  permissions: Omit<AdminPermission, 'role_count'>[]
  roles: Omit<AdminRole, 'account_count'>[]
  accounts: AdminAccount[]
  signingKeys: AdminSigningKey[]
  // Every player, merged ones too, as its page shows it. The list leaves
  // out the merged ones, and counts each player's managers itself.
  players?: AdminPlayerDetail[]
}
// A list, or one account's or player's page, such as `accounts/<id>`.
export type AdminList =
  | 'permissions'
  | 'roles'
  | 'accounts'
  | 'signing-keys'
  | 'players'
  | `accounts/${string}`
  | `players/${string}`

// The built-in permissions, the Administrator role and the default role, as
// the migrations make them.
export const builtInPermissions: AdminState['permissions'] = [
  { key: 'account_roles.manage', description: 'Set which roles an account holds.', built_in: true },
  { key: 'admin.view', description: 'See the admin page.', built_in: true },
  { key: 'matches.create', description: 'Create a match.', built_in: true },
  { key: 'matches.view', description: 'See the matches page.', built_in: true },
  { key: 'players.view', description: 'See the players page.', built_in: true },
  { key: 'roles.manage', description: 'Edit roles and permissions.', built_in: true },
  { key: 'signing_keys.revoke', description: 'Revoke any account’s signing key.', built_in: true },
]
export const administrator: AdminState['roles'][number] = {
  id: 'a0d1f2e3-4b5c-4d6e-8f70-81920a1b2c3d',
  name: 'Administrator',
  description: 'Everything on the admin page.',
  permissions: [
    'account_roles.manage',
    'admin.view',
    'matches.create',
    'matches.view',
    'players.view',
    'roles.manage',
    'signing_keys.revoke',
  ],
  default: false,
}
export const userRole: AdminState['roles'][number] = {
  id: 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70',
  name: 'User',
  description: 'Every new account gets this role, guests too.',
  permissions: [],
  default: true,
}

// Signs the mock API in as the verified account `accounts[0]`, and answers the
// admin routes as the API does, from `state`, an account's page and the signing
// keys too. The accounts list keeps the state's order in every view. The
// session's permissions come from the account's roles, so a write can change
// them. Writes refuse as the API does: a taken name or key, a built-in
// permission, any change that leaves no account with `account_roles.manage`, a
// revoke without `signing_keys.revoke` or of an unknown key. Returns the state,
// which a test can change as another tab would, and the writes it received.
export function mockAdmin(initial: AdminState) {
  const state: AdminState = structuredClone(initial)
  const writes: { method: string; path: string; body: unknown }[] = []
  const self = () => state.accounts[0]
  const grants = (roleIds: readonly string[]) =>
    new Set(
      state.roles
        .filter((role) => roleIds.includes(role.id))
        .flatMap((role) => role.permissions),
    )
  const canGrantRoles = () =>
    state.accounts.some((account) => grants(account.role_ids).has('account_roles.manage'))
  const refuse = (status: number, title: string) =>
    HttpResponse.json({ errors: [{ status: String(status), title }] }, { status })
  const LAST_ADMINISTRATOR = 'At least one account must keep the permission to grant roles'

  // Applies `change`, or undoes it and refuses if no account could grant
  // roles after it.
  function guarded(change: () => void, answer: () => Response): Response {
    const before = structuredClone(state)
    change()
    if (canGrantRoles()) return answer()
    Object.assign(state, before)
    return refuse(409, LAST_ADMINISTRATOR)
  }
  const role = (id: string): AdminRole => {
    const found = state.roles.find((role) => role.id === id)!
    const holders = state.accounts.filter((account) => account.role_ids.includes(id))
    return { ...found, account_count: holders.length }
  }

  server.use(
    http.post(`${API_BASE_URL}/v1/session`, () =>
      HttpResponse.json<components['schemas']['SessionResponse']>({
        data: {
          account: {
            id: self().id,
            kind: 'verified',
            email: self().email,
            player: { id: sessionResponse.data.account.player.id, display_name: self().display_name! },
            permissions: [...grants(self().role_ids)].sort(),
          },
        },
      }),
    ),
    http.get(`${API_BASE_URL}/v1/admin/permissions`, () =>
      HttpResponse.json<components['schemas']['AdminPermissionsResponse']>({
        data: state.permissions.map((permission) => ({
          ...permission,
          role_count: state.roles.filter((role) => role.permissions.includes(permission.key)).length,
        })),
      }),
    ),
    http.get(`${API_BASE_URL}/v1/admin/roles`, () =>
      HttpResponse.json<components['schemas']['AdminRolesResponse']>({
        data: state.roles.map((found) => role(found.id)),
      }),
    ),
    http.get(`${API_BASE_URL}/v1/admin/accounts`, ({ request }) => {
      const params = new URL(request.url).searchParams
      const view = params.get('view') ?? 'verified'
      const search = params.get('search')?.trim().toLowerCase() ?? ''
      const found = state.accounts
        .filter((account) => view === 'all' || (view === 'guests') === (account.kind === 'guest'))
        .filter(({ email, display_name }) =>
          [email, display_name].some((text) => text?.toLowerCase().includes(search)),
        )
      return HttpResponse.json<components['schemas']['AdminAccountsResponse']>({
        data: found.slice(0, 50),
        meta: { has_more: found.length > 50 },
      })
    }),
    http.get<{ id: string }>(`${API_BASE_URL}/v1/admin/accounts/:id`, ({ params }) => {
      const account = state.accounts.find((found) => found.id === params.id)
      if (!account) return refuse(404, 'No account has this id')
      const { role_ids, ...fields } = account
      return HttpResponse.json<components['schemas']['AdminAccountDetailResponse']>({
        data: {
          ...fields,
          roles: state.roles
            .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
            .map(({ id, name, description }) => ({
              id,
              name,
              description,
              held: role_ids.includes(id),
            })),
        },
      })
    }),
    http.get(`${API_BASE_URL}/v1/admin/players`, ({ request }) => {
      const name = new URL(request.url).searchParams.get('name')?.trim().toLowerCase() ?? ''
      const found = (state.players ?? [])
        .filter((player) => player.merged_into === null)
        .filter((player) => player.display_name.toLowerCase().includes(name))
        .sort((a, b) => a.display_name.toLowerCase().localeCompare(b.display_name.toLowerCase()))
      return HttpResponse.json<components['schemas']['AdminPlayersResponse']>({
        data: found.slice(0, 50).map((player) => {
          const self = player.managers.find((manager) => manager.relationship === 'self')
          return {
            id: player.id,
            display_name: player.display_name,
            account_id: self?.id ?? null,
            account_email: self?.email ?? null,
            manager_count: player.managers.length,
          }
        }),
        meta: { has_more: found.length > 50 },
      })
    }),
    http.get<{ id: string }>(`${API_BASE_URL}/v1/admin/players/:id`, ({ params }) => {
      const player = state.players?.find((found) => found.id === params.id)
      if (!player) return refuse(404, 'No player has this id')
      return HttpResponse.json<components['schemas']['AdminPlayerDetailResponse']>({ data: player })
    }),
    // The API answers 415 to a write that isn't JSON, a bodyless DELETE too.
    http.all(`${API_BASE_URL}/v1/admin/*`, async ({ request }) => {
      if (request.method === 'GET') return
      const path = new URL(request.url).pathname.replace('/api', '')
      if (request.headers.get('Content-Type') !== 'application/json') {
        return refuse(415, 'The request body must be JSON')
      }
      const text = await request.clone().text()
      writes.push({ method: request.method, path, body: text ? JSON.parse(text) : null })
    }),
    http.get(`${API_BASE_URL}/v1/admin/signing-keys`, ({ request }) => {
      const search = new URL(request.url).searchParams.get('search')?.toLowerCase() ?? ''
      const found = state.signingKeys.filter(({ account }) =>
        [account.email, account.display_name].some((text) => text?.toLowerCase().includes(search)),
      )
      return HttpResponse.json<components['schemas']['AdminSigningKeysResponse']>({
        data: found.slice(0, 50),
        meta: { has_more: found.length > 50 },
      })
    }),
    http.post<{ id: string }>(
      `${API_BASE_URL}/v1/admin/signing-keys/:id/revoke`,
      ({ params }) => {
        if (!grants(self().role_ids).has('signing_keys.revoke')) {
          return refuse(403, "You don't have permission to do this")
        }
        const key = state.signingKeys.find((found) => found.id === params.id)
        if (!key) return refuse(404, 'No key has this id')
        if (key.state !== 'revoked') {
          Object.assign(key, {
            state: 'revoked',
            revoked_at: new Date().toISOString(),
            revoked_by: self().id,
            revoked_by_email: self().email,
          })
        }
        return HttpResponse.json<components['schemas']['AdminSigningKeyResponse']>({ data: key })
      },
    ),
    http.post<never, components['schemas']['NewPermissionRequest']>(
      `${API_BASE_URL}/v1/admin/permissions`,
      async ({ request }) => {
        const { key, description } = await request.json()
        if (state.permissions.some((permission) => permission.key === key)) {
          return refuse(409, 'Another permission has this key')
        }
        const permission = { key, description, built_in: false }
        state.permissions.push(permission)
        return HttpResponse.json({ data: { ...permission, role_count: 0 } }, { status: 201 })
      },
    ),
    http.put<{ key: string }, components['schemas']['PermissionRequest']>(
      `${API_BASE_URL}/v1/admin/permissions/:key`,
      async ({ params, request }) => {
        const { description } = await request.json()
        const permission = state.permissions.find((found) => found.key === params.key)
        if (!permission) return refuse(404, 'No permission has this key')
        permission.description = description
        return HttpResponse.json({ data: { ...permission, role_count: 0 } })
      },
    ),
    http.delete<{ key: string }>(`${API_BASE_URL}/v1/admin/permissions/:key`, ({ params }) => {
      const permission = state.permissions.find((found) => found.key === params.key)
      if (!permission) return refuse(404, 'No permission has this key')
      if (permission.built_in) return refuse(409, 'The code checks this permission, so it stays')
      state.permissions = state.permissions.filter((found) => found !== permission)
      for (const role of state.roles) {
        role.permissions = role.permissions.filter((key) => key !== params.key)
      }
      return new HttpResponse(null, { status: 204 })
    }),
    http.post<never, components['schemas']['RoleRequest']>(
      `${API_BASE_URL}/v1/admin/roles`,
      async ({ request }) => {
        const draft = await request.json()
        if (nameTaken(draft.name)) return refuse(409, 'Another role has this name')
        const id = crypto.randomUUID()
        state.roles.push({ id, ...draft, permissions: [...draft.permissions].sort(), default: false })
        return HttpResponse.json({ data: role(id) }, { status: 201 })
      },
    ),
    http.put<{ id: string }, components['schemas']['RoleRequest']>(
      `${API_BASE_URL}/v1/admin/roles/:id`,
      async ({ params, request }) => {
        const draft = await request.json()
        const index = state.roles.findIndex((found) => found.id === params.id)
        if (index === -1) return refuse(404, 'No role has this id')
        if (nameTaken(draft.name, params.id)) return refuse(409, 'Another role has this name')
        const { default: isDefault } = state.roles[index]
        return guarded(
          () => {
            state.roles[index] = {
              id: params.id,
              ...draft,
              permissions: [...draft.permissions].sort(),
              default: isDefault,
            }
          },
          () => HttpResponse.json({ data: role(params.id) }),
        )
      },
    ),
    http.delete<{ id: string }>(`${API_BASE_URL}/v1/admin/roles/:id`, ({ params }) => {
      const target = state.roles.find((role) => role.id === params.id)
      if (!target) return refuse(404, 'No role has this id')
      return guarded(
        () => {
          state.roles = state.roles.filter((found) => found.id !== params.id)
          for (const account of state.accounts) {
            account.role_ids = account.role_ids.filter((id) => id !== params.id)
          }
        },
        () => new HttpResponse(null, { status: 204 }),
      )
    }),
    http.put<{ id: string }, components['schemas']['AccountRolesRequest']>(
      `${API_BASE_URL}/v1/admin/accounts/:id/roles`,
      async ({ params, request }) => {
        const { role_ids } = await request.json()
        const account = state.accounts.find((found) => found.id === params.id)
        if (!account) return refuse(404, 'No account has this id')
        if (account.kind === 'guest') return refuse(404, 'No verified account has this id')
        return guarded(
          () => {
            account.role_ids = [...role_ids].sort()
          },
          () => HttpResponse.json({ data: account }),
        )
      },
    ),
  )

  function nameTaken(name: string, except?: string): boolean {
    return state.roles.some(
      (role) => role.id !== except && role.name.toLowerCase() === name.trim().toLowerCase(),
    )
  }

  return { state, writes }
}

// Holds the mock API's responses to `GET /v1/admin/<list>` until the test
// releases them. Then the handler set before this one answers.
export function holdAdmin(list: AdminList) {
  const pending: (() => void)[] = []
  server.use(
    http.get(
      `${API_BASE_URL}/v1/admin/${list}`,
      () => new Promise<undefined>((resolve) => pending.push(() => resolve(undefined))),
    ),
  )
  return {
    async release(): Promise<void> {
      await act(async () => pending.splice(0).forEach((resolve) => resolve()))
    },
  }
}

// Makes the mock API's next `GET /v1/admin/<list>` fail with `status`.
export function failAdminOnce(list: AdminList, status: number) {
  server.use(
    http.get(
      `${API_BASE_URL}/v1/admin/${list}`,
      () => HttpResponse.json({ errors: [{ status: String(status), title: 'Failed' }] }, { status }),
      { once: true },
    ),
  )
}

type Opponent = components['schemas']['Opponent']
type MatchRequest = components['schemas']['MatchRequest']

// How the mock API answers a new match: it makes it, refuses it with this
// title (a 422, or `status`), or no response comes back.
type CreateAnswer = 'created' | { refused: string; status?: number } | 'unreachable'

// The mock API's matches, for a session whose account holds
// `matches.create`. `recent` are the session's recent opponents, and
// a search finds the players of `everyone` whose name contains it. Each
// POST is recorded in `creates` and answered with `create`, which a test can
// change. A second create of one id answers 200. `recentFails` makes the
// recent opponents answer 500 while it's set. With `holdRecent`, they
// wait until the test calls release().
export function mockMatches({
  recent = [],
  everyone = recent,
  create = 'created',
  holdRecent = false,
}: {
  recent?: Opponent[]
  everyone?: Opponent[]
  create?: CreateAnswer
  holdRecent?: boolean
} = {}) {
  const pending: (() => void)[] = []
  const made = new Set<string>()
  const mock = {
    create,
    recentFails: false,
    creates: [] as MatchRequest[],
    searches: [] as string[],
    async release(): Promise<void> {
      await act(async () => pending.splice(0).forEach((resolve) => resolve()))
    },
  }
  const creator: components['schemas']['SessionResponse'] = {
    data: { account: { ...sessionResponse.data.account, permissions: ['matches.create'] } },
  }
  server.use(
    http.post(`${API_BASE_URL}/v1/session`, () => HttpResponse.json(creator)),
    http.get(`${API_BASE_URL}/v1/matches/opponents`, async ({ request }) => {
      const search = new URL(request.url).searchParams.get('search')?.trim() ?? ''
      if (search) {
        mock.searches.push(search)
        const found = everyone.filter((player) =>
          player.display_name.toLowerCase().includes(search.toLowerCase()),
        )
        return HttpResponse.json<components['schemas']['OpponentsResponse']>({ data: found })
      }
      if (holdRecent) await new Promise<void>((resolve) => pending.push(resolve))
      if (mock.recentFails) return new HttpResponse(null, { status: 500 })
      return HttpResponse.json<components['schemas']['OpponentsResponse']>({ data: recent })
    }),
    http.post<never, MatchRequest>(
      `${API_BASE_URL}/v1/matches`,
      async ({ request }) => {
        const body = await request.json()
        mock.creates.push(body)
        if (mock.create === 'unreachable') return HttpResponse.error()
        if (mock.create !== 'created') {
          const status = mock.create.status ?? 422
          return HttpResponse.json(
            { errors: [{ status: String(status), title: mock.create.refused }] },
            { status },
          )
        }
        const known = made.has(body.id)
        made.add(body.id)
        return HttpResponse.json<components['schemas']['MatchResponse']>(
          { data: { id: body.id } },
          { status: known ? 200 : 201 },
        )
      },
    ),
  )
  return mock
}

type MatchDetail = components['schemas']['MatchDetail']

// The mock API's reads of `matches`, newest first: the list, with
// `hasMore`, and each match by id, which answers 404 for an id it doesn't
// hold. `lists` counts the list requests and `reads` records each id read.
// While `hold` is set, each answer waits until the test calls release().
// While `fails` is set, each answers 500.
export function mockMatchReads(matches: MatchDetail[], { hasMore = false } = {}) {
  const pending: (() => void)[] = []
  const mock = {
    hold: false,
    fails: false,
    lists: 0,
    reads: [] as string[],
    async release(): Promise<void> {
      await act(async () => pending.splice(0).forEach((resolve) => resolve()))
    },
  }
  const answer = async (respond: () => Response) => {
    if (mock.hold) await new Promise<void>((resolve) => pending.push(resolve))
    if (mock.fails) {
      return HttpResponse.json({ errors: [{ status: '500', title: 'Failed' }] }, { status: 500 })
    }
    return respond()
  }
  server.use(
    http.get(`${API_BASE_URL}/v1/matches`, () => {
      mock.lists++
      return answer(() =>
        HttpResponse.json<components['schemas']['MatchesResponse']>({
          data: matches.map((m) => ({
            id: m.id,
            best_of: m.best_of,
            rated: m.rated,
            started_at: m.started_at,
            sides: m.sides,
            viewer_side: m.viewer_side,
            games: m.games,
            retired_by: m.retired_by,
            state: m.state,
          })),
          meta: { has_more: hasMore },
        }),
      )
    }),
    http.get<{ matchId: string }>(`${API_BASE_URL}/v1/matches/:matchId`, ({ params }) => {
      if (params.matchId === 'opponents') return undefined
      mock.reads.push(params.matchId)
      const match = matches.find((m) => m.id === params.matchId)
      return answer(() =>
        match
          ? HttpResponse.json<components['schemas']['MatchDetailResponse']>({ data: match })
          : HttpResponse.json(
              { errors: [{ status: '404', title: 'No match has this id' }] },
              { status: 404 },
            ),
      )
    }),
  )
  return mock
}
