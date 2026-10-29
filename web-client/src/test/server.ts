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
    },
  },
}

export const logoutResponse: components['schemas']['LogoutResponse'] = {
  data: {
    logout_url:
      'https://fortymm.example/v2/logout?client_id=test&returnTo=http%3A%2F%2Flocalhost%2F',
  },
}

// The mock API for unit tests, started in setupTests.ts. Tests override a
// handler for themselves with `server.use()`.
export const server = setupServer(
  http.post(`${API_BASE_URL}/v1/session`, () =>
    HttpResponse.json(sessionResponse),
  ),
  http.post(`${API_BASE_URL}/v1/auth/logout`, () => HttpResponse.json(logoutResponse)),
  http.get(`${API_BASE_URL}/v1/account/players`, () =>
    HttpResponse.json<components['schemas']['AccountPlayersResponse']>({ data: [] }),
  ),
)

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
type Answer = components['schemas']['Answer']

// Signs the mock API in as a verified account that manages `players`, and
// answers "Is this you?" as the API does. Returns the answers it received.
// One of `players` is the account's self player, and they are in the order
// the API made them. So a "This is me" merges into the first of the two.
// `refuse` makes it answer that status instead, as when another tab
// answered first.
export function mockVerifiedAccount(
  players: AccountPlayer[],
  { refuse }: { refuse?: number } = {},
) {
  let current = players
  const answers: { playerId: string; answer: Answer }[] = []
  const self = () => {
    const found = current.find((player) => player.relationship === 'self')
    if (!found) throw new Error('The account has no self player')
    return { id: found.id, display_name: found.display_name }
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
    http.post<{ playerId: string }, components['schemas']['AnswerRequest']>(
      `${API_BASE_URL}/v1/account/players/:playerId/answer`,
      async ({ params, request }) => {
        const { answer } = await request.json()
        answers.push({ playerId: params.playerId, answer })
        if (refuse) {
          return HttpResponse.json(
            { errors: [{ status: String(refuse), title: 'Refused' }] },
            { status: refuse },
          )
        }
        const answered = current.find((player) => player.id === params.playerId)
        const own = current.find((player) => player.relationship === 'self')
        if (answer === 'yes' && answered?.open_question && own) {
          // A merge. The older player survives as the self player.
          const [survivor, merged] =
            current.indexOf(own) < current.indexOf(answered) ? [own, answered] : [answered, own]
          current = current.flatMap((player) => {
            if (player === merged) return []
            if (player !== survivor) return [player]
            return [{ ...player, relationship: 'self', open_question: false }]
          })
        } else {
          current = current.flatMap((player) => {
            if (player.id !== params.playerId) return [player]
            if (answer === 'not_mine') return []
            const relationship = answer === 'yes' ? 'self' : player.relationship
            return [{ ...player, relationship, open_question: false }]
          })
        }
        return HttpResponse.json<components['schemas']['AccountPlayersResponse']>({
          data: current,
        })
      },
    ),
  )
  return { answers }
}
