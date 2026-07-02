import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'

import { server } from '@/mocks/server'
import { matchDetails } from '@/test/factories'
import {
  type MatchDetails,
  fireScoreSave,
  matchQueryKey,
  matchQueryOptions,
  scoreMutationKey,
  useCreateMatch,
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

it('primes the cache with the committed score from a conflict 409 (so a follow-up Replace reads the fresh version)', async () => {
  const matchId = 'm-conflict'
  // The client last read this game's score at version 1.
  const seeded: MatchDetails = matchDetails({
    id: matchId,
    games: [
      {
        id: 'g-1',
        game_number: 1,
        score: {
          id: 's-1',
          side_1_points: 11,
          side_2_points: 5,
          winner_side_number: 1,
          version: 1,
        },
      },
    ],
  })
  queryClient.setQueryData(matchQueryKey(matchId), seeded)

  server.use(
    // The conditional PUT loses the race: 409 carrying the committed score at
    // its new version 2.
    http.put('*/v1/matches/:matchId/games/:gameNumber/scores', () =>
      HttpResponse.json(
        {
          detail: {
            message: 'This game was saved by someone else.',
            committed_score: {
              id: 's-1',
              side_1_points: 11,
              side_2_points: 5,
              winner_side_number: 1,
              version: 2,
            },
          },
        },
        { status: 409 },
      ),
    ),
    // The re-sync refetch never settles — so this test proves the cache holds
    // the committed version from the 409 *body*, not from a refetch.
    http.get('*/v1/matches/:matchId', () => new Promise<Response>(() => {})),
  )

  await fireScoreSave(queryClient, matchId, 1, {
    side_1_points: 7,
    side_2_points: 11,
  })

  // The committed score (and its new version 2) was spliced into the cache by
  // onError — so a subsequent "Replace with my score" PUTs expected_version 2,
  // not the stale 1 it would otherwise read while the refetch is in flight.
  const patched = queryClient.getQueryData<MatchDetails>(matchQueryKey(matchId))
  const score = patched?.games.find((g) => g.game_number === 1)?.score
  expect(score?.version).toBe(2)
  expect(score?.side_2_points).toBe(5)
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

describe('useCreateMatch', () => {
  it('invalidates the matches-list and dashboard caches on success (#761)', async () => {
    const created = matchDetails({ id: 'm-new' })
    server.use(
      http.post('*/v1/matches', () => HttpResponse.json(created, { status: 201 })),
    )

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useCreateMatch(), { wrapper })
    result.current.mutate({
      opponent_user_id: 'u-op',
      best_of: 5,
      rated: false,
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['matches', 'list'],
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['dashboard'],
    })
  })
})
