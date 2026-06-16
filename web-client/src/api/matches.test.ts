import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient } from '@tanstack/react-query'

import { server } from '@/mocks/server'
import { matchDetails } from '@/test/factories'
import {
  type MatchDetails,
  fireScoreSave,
  matchQueryKey,
  matchQueryOptions,
  scoreMutationKey,
} from './matches'

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient({
    // A long staleTime means a re-read only refetches if something explicitly
    // invalidates the query — so the #564 test proves the error path is what
    // re-syncs the cache, not an incidental "stale by default" refetch.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
})

afterEach(() => {
  queryClient.clear()
  vi.restoreAllMocks()
})

/**
 * Regression for #564: when a per-game score save loses a server-side race to
 * a concurrent conflicting write, the server rejects it and the mutation lands
 * in `error`. The match detail query must be re-synced to server truth so the
 * "Games won" counter reconciles without a manual reload — while the failed
 * mutation's scratch state survives to drive the failure banner / retry UI.
 */
it('re-syncs the match detail query after a rejected score save (#564)', async () => {
  const matchId = 'm-564'
  // Stale local view the losing client is staring at: it thinks it's up 1-0.
  const stale: MatchDetails = matchDetails({
    id: matchId,
    sides: [
      {
        side_number: 1,
        players: [
          { user_id: 'u-me', username: 'rita.kovac', is_current_user: true },
        ],
        games_won: 1,
        won: null,
        is_current_user_side: true,
      },
      {
        side_number: 2,
        players: [
          { user_id: 'u-op', username: 'opponent', is_current_user: false },
        ],
        games_won: 0,
        won: null,
        is_current_user_side: false,
      },
    ],
  })
  queryClient.setQueryData(matchQueryKey(matchId), stale)

  // Server truth: the opponent's conflicting write won — it's actually 1-1.
  const serverTruth: MatchDetails = matchDetails({
    id: matchId,
    sides: [
      { ...stale.sides[0], games_won: 1 },
      { ...stale.sides[1], games_won: 1 },
    ],
  })

  server.use(
    // Our conflicting save is rejected by the server.
    http.post(
      '*/v1/matches/:matchId/games/:gameNumber/scores/new',
      () => HttpResponse.json({ detail: 'Conflicting score.' }, { status: 422 }),
    ),
    // The re-sync refetch returns server truth.
    http.get('*/v1/matches/:matchId', () =>
      HttpResponse.json(serverTruth),
    ),
  )

  await fireScoreSave(queryClient, matchId, 1, {
    side_1_points: 11,
    side_2_points: 9,
  })

  // The failed-save scratch state survives so the banner / cell can drive retry.
  const failed = queryClient
    .getMutationCache()
    .findAll({ mutationKey: scoreMutationKey(matchId, 1), exact: true })
  expect(failed).toHaveLength(1)
  expect(failed[0].state.status).toBe('error')

  // Sanity: the options/queryKey wiring matches what the mutation invalidates.
  expect(matchQueryOptions(matchId).queryKey).toEqual(matchQueryKey(matchId))
  // The match detail query was invalidated, so the next read reconciles to
  // server truth (the opponent's win counts: now 1-1, not the stale 1-0).
  const synced = await queryClient.fetchQuery(matchQueryOptions(matchId))
  expect(synced.sides[1].games_won).toBe(1)
})

it('marks the match detail query stale on a rejected save (#564)', async () => {
  const matchId = 'm-564b'
  // Seed an active (fetched, fresh) query so we can observe it being invalidated.
  await queryClient.fetchQuery(matchQueryOptions(matchId)).catch(() => undefined)

  server.use(
    http.post(
      '*/v1/matches/:matchId/games/:gameNumber/scores/new',
      () => HttpResponse.json({ detail: 'Conflicting score.' }, { status: 422 }),
    ),
  )

  const invalidations: unknown[] = []
  const spy = vi
    .spyOn(queryClient, 'invalidateQueries')
    .mockImplementation((filters) => {
      invalidations.push(filters?.queryKey)
      return Promise.resolve()
    })

  await fireScoreSave(queryClient, matchId, 1, {
    side_1_points: 11,
    side_2_points: 9,
  })

  spy.mockRestore()
  // The error path invalidated the canonical match query key.
  expect(invalidations).toContainEqual(matchQueryKey(matchId))
})
