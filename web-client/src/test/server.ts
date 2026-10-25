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

// The mock API for unit tests, started in setupTests.ts. Tests override a
// handler for themselves with `server.use()`.
export const server = setupServer(
  http.post(`${API_BASE_URL}/v1/session`, () =>
    HttpResponse.json(sessionResponse),
  ),
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

type AccountPlayer = components['schemas']['AccountPlayer']
type Answer = components['schemas']['Answer']

// Signs the mock API in as a verified account that manages `players`, and
// answers "Is this you?" as the API does. Returns the answers it received.
// `refuse` makes it answer that status instead, as when another tab
// answered first.
export function mockVerifiedAccount(
  players: AccountPlayer[],
  { refuse }: { refuse?: number } = {},
) {
  let current = players
  const answers: { playerId: string; answer: Answer }[] = []
  const self = () => current.find((player) => player.relationship === 'self')
  server.use(
    http.post(`${API_BASE_URL}/v1/session`, () =>
      HttpResponse.json<components['schemas']['SessionResponse']>({
        data: {
          account: {
            ...sessionResponse.data.account,
            kind: 'verified',
            email: 'ann@example.com',
            player: self() ?? null,
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
        current = current.flatMap((player) => {
          if (player.id !== params.playerId) return [player]
          if (answer === 'not_mine') return []
          const relationship = answer === 'yes' ? 'self' : player.relationship
          return [{ ...player, relationship, open_question: false }]
        })
        return HttpResponse.json<components['schemas']['AccountPlayersResponse']>({
          data: current,
        })
      },
    ),
  )
  return { answers }
}
