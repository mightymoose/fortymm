import { queryOptions } from '@tanstack/react-query'
import { ApiError, ApiUnreachable } from '../../api/errors'
import { samplePlayers, type Player } from './samplePlayers'
import type { DetailScenario, ListScenario, Scenario } from './scenarios'

// Long enough to see the skeleton, short enough for a test's findBy.
const ANSWER_AFTER_MS = 300

function answer<T>(request: string, scenario: Scenario, value: () => T): Promise<T> {
  if (scenario === 'loading') return new Promise(() => {})
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const failure = failureFor(request, scenario)
      if (failure) reject(failure)
      else {
        try {
          resolve(value())
        } catch (error) {
          reject(error)
        }
      }
    }, ANSWER_AFTER_MS)
  })
}

function failureFor(request: string, scenario: Scenario): Error | null {
  switch (scenario) {
    case 'error':
      return new ApiError(request, new Response(null, { status: 500 }))
    case 'not-found':
      return new ApiError(request, new Response(null, { status: 404 }))
    case 'rate-limited':
      return new ApiError(
        request,
        new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
      )
    case 'unreachable':
      return new ApiUnreachable(request, { cause: new TypeError('Failed to fetch') })
    default:
      return null
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}

// The mock queries never retry, so an error scenario shows its error at once
// rather than after the app's backoff.
export function playersQuery(scenario: ListScenario) {
  return queryOptions({
    queryKey: ['mockup', 'players', scenario],
    queryFn: () =>
      answer('GET /v1/players', scenario, () => (scenario === 'empty' ? [] : samplePlayers)),
    retry: false,
  })
}

export function playerQuery(playerId: string, scenario: DetailScenario) {
  const request = `GET /v1/players/${playerId}`
  return queryOptions({
    queryKey: ['mockup', 'player', playerId, scenario],
    queryFn: () =>
      answer(request, scenario, (): Player => {
        const player = samplePlayers.find((p) => p.id === playerId)
        if (!player) throw new ApiError(request, new Response(null, { status: 404 }))
        return player
      }),
    retry: false,
  })
}
