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
