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

// A player as the players list gives it. No player has a match until games
// exist.
export function listedPlayer(
  player: Pick<AccountPlayer, 'id' | 'display_name' | 'relationship' | 'open_question'>,
): AccountPlayer {
  return { ...player, match_count: 0, recent_matches: [] }
}

// Signs the mock API in as a verified account that manages `players`, and
// answers "Is this you?" as the API does. Returns the answers it received,
// and answerInAnotherTab(), which answers without the page knowing. One of
// `players` is the account's self player, and they are in the order the API
// made them. So a merge keeps the first of the two. `failAnswers` makes
// every answer fail with a 500.
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

  // The older player survives, and takes the relationship of `into`.
  function merge(player: AccountPlayer, into: AccountPlayer): AnswerMeta {
    const [survivor, merged] =
      current.indexOf(into) < current.indexOf(player) ? [into, player] : [player, into]
    current = current.flatMap((found) => {
      if (found === merged) return []
      if (found !== survivor) return [found]
      return [{ ...found, relationship: into.relationship, open_question: false }]
    })
    return { outcome: 'merged', survivor: survivor.id, merged: merged.id }
  }

  // The API's answer: the outcome, or the status it refuses with.
  function answer(playerId: string, request: AnswerRequest): AnswerMeta | 404 | 409 | 422 {
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
    const own = current.find((player) => player.relationship === 'self')
    switch (request.answer) {
      case 'yes':
        if (own) return merge(answered, own)
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
        const meta = failAnswers ? 500 : answer(params.playerId, body)
        if (typeof meta === 'number') {
          return HttpResponse.json(
            { errors: [{ status: String(meta), title: 'Refused' }] },
            { status: meta },
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
  }
}

type AdminPermission = components['schemas']['AdminPermission']
type AdminRole = components['schemas']['AdminRole']
type AdminAccount = components['schemas']['AdminAccount']
type AdminSigningKey = components['schemas']['AdminSigningKey']
// The admin lists the mock API holds. It counts each permission's roles and
// each role's accounts itself.
export type AdminState = {
  permissions: Omit<AdminPermission, 'role_count'>[]
  roles: Omit<AdminRole, 'account_count'>[]
  accounts: AdminAccount[]
  signingKeys: AdminSigningKey[]
}
// A list, or one account's page, such as `accounts/<id>`.
export type AdminList =
  | 'permissions'
  | 'roles'
  | 'accounts'
  | 'signing-keys'
  | `accounts/${string}`

// The built-in permissions and the Administrator role, as the migration
// makes them.
export const builtInPermissions: AdminState['permissions'] = [
  { key: 'account_roles.manage', description: 'Set which roles an account holds.', built_in: true },
  { key: 'admin.view', description: 'See the admin page.', built_in: true },
  { key: 'roles.manage', description: 'Edit roles and permissions.', built_in: true },
  { key: 'signing_keys.revoke', description: 'Revoke any account’s signing key.', built_in: true },
]
export const administrator: AdminState['roles'][number] = {
  id: 'a0d1f2e3-4b5c-4d6e-8f70-81920a1b2c3d',
  name: 'Administrator',
  description: 'Everything on the admin page.',
  permissions: ['account_roles.manage', 'admin.view', 'roles.manage', 'signing_keys.revoke'],
}

// Signs the mock API in as the verified account `accounts[0]`, and answers
// the admin routes as the API does, from `state`, an account's page and the
// signing keys too. The session's permissions come from the account's roles,
// so a write can change them. Writes refuse as the API does: a taken name or
// key, a built-in permission, any change that leaves no account with
// `account_roles.manage`, and a revoke without `signing_keys.revoke` or of an
// unknown key. Returns the state, which a test can change as another tab
// would, and the writes it received.
export function mockAdmin(initial: AdminState) {
  const state: AdminState = structuredClone(initial)
  const writes: { method: string; path: string; body: unknown }[] = []
  const self = () => state.accounts[0]
  const grants = (roleIds: readonly string[]) =>
    new Set(
      state.roles.filter((role) => roleIds.includes(role.id)).flatMap((role) => role.permissions),
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
      const email = new URL(request.url).searchParams.get('email')?.toLowerCase() ?? ''
      const found = state.accounts.filter((account) => account.email.includes(email))
      return HttpResponse.json<components['schemas']['AdminAccountsResponse']>({
        data: found.slice(0, 50),
        meta: { has_more: found.length > 50 },
      })
    }),
    http.get<{ id: string }>(`${API_BASE_URL}/v1/admin/accounts/:id`, ({ params }) => {
      const account = state.accounts.find((found) => found.id === params.id)
      if (!account) return refuse(404, 'No verified account has this id')
      return HttpResponse.json<components['schemas']['AdminAccountDetailResponse']>({
        data: {
          id: account.id,
          email: account.email,
          display_name: account.display_name,
          created_at: '2026-03-14T09:30:00Z',
          last_seen_at: '2026-10-31T18:05:00Z',
          roles: [...state.roles]
            .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
            .map(({ id, name, description }) => ({
              id,
              name,
              description,
              held: account.role_ids.includes(id),
            })),
        },
      })
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
        state.roles.push({ id, ...draft, permissions: [...draft.permissions].sort() })
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
        return guarded(
          () => {
            state.roles[index] = { id: params.id, ...draft, permissions: [...draft.permissions].sort() }
          },
          () => HttpResponse.json({ data: role(params.id) }),
        )
      },
    ),
    http.delete<{ id: string }>(`${API_BASE_URL}/v1/admin/roles/:id`, ({ params }) => {
      if (!state.roles.some((found) => found.id === params.id)) {
        return refuse(404, 'No role has this id')
      }
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
        if (!account) return refuse(404, 'No verified account has this id')
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
