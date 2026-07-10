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
  useDeleteScore,
  useMatch,
} from './matches'

/** A promise plus its externally-callable `resolve`. Lets a test hold a mocked
 * handler in flight and release it at an exact point, so timing is
 * test-controlled rather than dependent on when a handler body happens to run. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

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

type Game = MatchDetails['games'][number]

/**
 * Regression for #843: two per-game score saves for *different* games are in
 * flight at once (the scratch-pad saves are fire-and-forget). If the save for
 * game 1 settles *after* the save for game 2, game 1's whole-match response —
 * which was built from the DB *before* game 2's row was lazily inserted, so it
 * omits game 2's row entirely — wholesale-overwrites the cache and game 2
 * vanishes. The last-settling response must not drop a concurrently-saved game.
 */
it('does not drop a concurrently-saved game when an older save response settles last (#843)', async () => {
  const matchId = 'm-843-save'

  const game1: Game = {
    id: 'g-1',
    game_number: 1,
    score: {
      id: 's-1',
      side_1_points: 11,
      side_2_points: 5,
      winner_side_number: 1,
      version: 1,
    },
  }
  const game2: Game = {
    id: 'g-2',
    game_number: 2,
    score: {
      id: 's-2',
      side_1_points: 5,
      side_2_points: 11,
      winner_side_number: 2,
      version: 1,
    },
  }

  // Game 1's response predates game 2's insert — the server builds
  // `games` from DB rows, so a stale snapshot omits game 2's row entirely.
  const game1Response: MatchDetails = matchDetails({ id: matchId, games: [game1] })
  // Game 2's response is newer: game 1's row is already committed, so it
  // carries both.
  const game2Response: MatchDetails = matchDetails({
    id: matchId,
    games: [game1, game2],
  })

  // Hold game 1's response open until game 2's has fully settled, so game 1's
  // onSuccess runs last — the out-of-order clobber.
  let releaseGame1: () => void = () => {}
  const game1Gate = new Promise<void>((resolve) => {
    releaseGame1 = resolve
  })

  server.use(
    http.post(
      '*/v1/matches/:matchId/games/:gameNumber/scores/new',
      async ({ params }) => {
        if (params.gameNumber === '1') {
          await game1Gate
          return HttpResponse.json(game1Response)
        }
        return HttpResponse.json(game2Response)
      },
    ),
  )

  // Both fire against the empty cache, so each takes the POST (create) path.
  const p1 = fireScoreSave(queryClient, matchId, 1, {
    side_1_points: 11,
    side_2_points: 5,
  })
  const p2 = fireScoreSave(queryClient, matchId, 2, {
    side_1_points: 5,
    side_2_points: 11,
  })

  // Game 2 settles first: the cache now holds both games.
  await p2
  // Now let game 1's stale response land last.
  releaseGame1()
  await p1

  const cached = queryClient.getQueryData<MatchDetails>(matchQueryKey(matchId))
  const g2 = cached?.games.find((g) => g.game_number === 2)
  expect(g2).toBeDefined()
  expect(g2?.score?.side_2_points).toBe(11)
})

/**
 * Regression for #843 (delete path): `useDeleteScore` is a per-game write too.
 * A clear of game 1 whose response predates a
 * concurrent save of game 2 (so its snapshot omits game 2's row) must not wipe
 * game 2 from the cache when it settles last.
 */
it('does not drop a concurrently-saved game when a delete response settles last (#843)', async () => {
  const matchId = 'm-843-delete'

  const game1Nulled: Game = { id: 'g-1', game_number: 1, score: null }
  const game2: Game = {
    id: 'g-2',
    game_number: 2,
    score: {
      id: 's-2',
      side_1_points: 5,
      side_2_points: 11,
      winner_side_number: 2,
      version: 1,
    },
  }

  // The save of game 2 lands first with both rows present.
  const saveResponse: MatchDetails = matchDetails({
    id: matchId,
    games: [{ id: 'g-1', game_number: 1, score: null }, game2],
  })
  // The delete's response predates game 2's insert: game 1 nulled, no game 2.
  const deleteResponse: MatchDetails = matchDetails({
    id: matchId,
    games: [game1Nulled],
  })

  // Hold the delete open until the save has settled, so the delete's onSuccess
  // runs last.
  let releaseDelete: () => void = () => {}
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve
  })

  server.use(
    http.post('*/v1/matches/:matchId/games/:gameNumber/scores/new', () =>
      HttpResponse.json(saveResponse),
    ),
    http.delete(
      '*/v1/matches/:matchId/games/:gameNumber/scores',
      async () => {
        await deleteGate
        return HttpResponse.json(deleteResponse)
      },
    ),
  )

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const { result } = renderHook(() => useDeleteScore(matchId, 1), { wrapper })

  const savePromise = fireScoreSave(queryClient, matchId, 2, {
    side_1_points: 5,
    side_2_points: 11,
  })
  const deletePromise = result.current.mutateAsync().catch(() => undefined)

  // The save settles first: the cache now holds both games.
  await savePromise
  // Now let the stale delete response land last.
  releaseDelete()
  await deletePromise

  const cached = queryClient.getQueryData<MatchDetails>(matchQueryKey(matchId))
  const g2 = cached?.games.find((g) => g.game_number === 2)
  expect(g2).toBeDefined()
  expect(g2?.score?.side_2_points).toBe(11)
})

/**
 * Evidence for #843's *accepted residual* (work-order chore C3, option B).
 *
 * The C2 fix's success path fires `invalidateQueries(matchQueryKey)`, which — when
 * the query has an active observer — triggers a GET refetch that wholesale-replaces
 * the cache. The residual worry: if that GET reads server state *before* a concurrent
 * per-game write commits, its stale snapshot omits the just-saved game and the refetch
 * drops it again through the *query* path (the same bug, a different door).
 *
 * The claim we are probing is that React Query v5's `invalidateQueries` defaults to
 * `cancelRefetch: true` (`query-core` `queryClient.js:179`, reached via
 * `invalidateQueries`→`refetchQueries`), so a later invalidate cancels the earlier
 * in-flight refetch (`query.js:199-203`, gated on `state.data !== undefined`, which
 * holds here because the mutation upserts leave data in the cache) and only the
 * last-settling, freshest refetch lands — the cache self-heals.
 *
 * This test reproduces exactly that: two per-game saves fire; save 1's invalidate
 * starts refetch GET#1 and it is *held in flight*; save 2 commits, its invalidate
 * cancels GET#1 and starts GET#2; GET#2 is resolved with the FRESH snapshot (both
 * games); only then is GET#1 resolved with a STALE snapshot (game 1 only) — landing
 * into the already-cancelled fetch. We assert both refetches actually fired (so the
 * race was real, not skipped) and that the cache converges to the fresh both-games
 * snapshot, including a derived `games_won` the narrow upsert never writes — proving
 * the fresh *refetch*, not the mutation upsert, is the final writer.
 */
it('self-heals when a stale invalidate refetch races the second save (#843 refetch race)', async () => {
  const matchId = 'm-843-refetch'

  const game1: Game = {
    id: 'g-1',
    game_number: 1,
    score: {
      id: 's-1',
      side_1_points: 11,
      side_2_points: 5,
      winner_side_number: 1,
      version: 1,
    },
  }
  const game2: Game = {
    id: 'g-2',
    game_number: 2,
    score: {
      id: 's-2',
      side_1_points: 5,
      side_2_points: 11,
      winner_side_number: 2,
      version: 1,
    },
  }

  const sidesWith = (side1Won: number, side2Won: number): MatchDetails['sides'] => [
    {
      side_number: 1,
      players: [
        { user_id: 'u-me', username: 'rita.kovac', is_current_user: true },
      ],
      games_won: side1Won,
      won: null,
      is_current_user_side: true,
    },
    {
      side_number: 2,
      players: [
        { user_id: 'u-op', username: 'opponent', is_current_user: false },
      ],
      games_won: side2Won,
      won: null,
      is_current_user_side: false,
    },
  ]

  // Seed the cache BEFORE mounting the observer: with `staleTime: Infinity` and
  // data present, the mount fires no initial GET, so the *only* GETs are the two
  // invalidate refetches (an initial fetch would be a third GET and scramble the
  // stale/fresh sequencing). games_won starts 0-0; only a refetch can change it.
  const initial = matchDetails({ id: matchId, games: [], sides: sidesWith(0, 0) })
  queryClient.setQueryData(matchQueryKey(matchId), initial)

  // Each save's whole-match response reflects only what was committed at commit
  // time; the narrow upsert takes just that save's own game out of it.
  const save1Response = matchDetails({
    id: matchId,
    games: [game1],
    sides: sidesWith(1, 0),
  })
  const save2Response = matchDetails({
    id: matchId,
    games: [game1, game2],
    sides: sidesWith(1, 1),
  })

  // The FRESH refetch snapshot carries both games and the reconciled 1-1 tally.
  const freshSnapshot = save2Response
  // The STALE refetch snapshot predates game 2's commit: game 1 only. If this
  // ever lands last, game 2 vanishes and games_won reads 1-0.
  const staleSnapshot = matchDetails({
    id: matchId,
    games: [game1],
    sides: sidesWith(1, 0),
  })

  // Gate save 2's POST so save 1 fully settles (and its refetch is in flight)
  // before save 2 commits and cancels it.
  const save2Gate = deferred<void>()

  // Deferred, test-controlled refetch responses: GET#1 → stale, GET#2 → fresh.
  // `*Entered` resolve when each handler is reached, so the test can await the
  // fetch actually being in flight instead of polling.
  let getCount = 0
  const get1Entered = deferred<void>()
  const get2Entered = deferred<void>()
  const get1Body = deferred<MatchDetails>()
  const get2Body = deferred<MatchDetails>()

  server.use(
    http.post(
      '*/v1/matches/:matchId/games/:gameNumber/scores/new',
      async ({ params }) => {
        if (params.gameNumber === '2') {
          await save2Gate.promise
          return HttpResponse.json(save2Response)
        }
        return HttpResponse.json(save1Response)
      },
    ),
    http.get('*/v1/matches/:matchId', async () => {
      getCount += 1
      if (getCount === 1) {
        get1Entered.resolve()
        return HttpResponse.json(await get1Body.promise)
      }
      if (getCount === 2) get2Entered.resolve()
      return HttpResponse.json(await get2Body.promise)
    }),
  )

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  // Mount an active observer so `invalidateQueries` actually refetches (an
  // invalidate with no observer only marks stale — that's why the earlier #843
  // tests, which have no observer, never exercised this path).
  renderHook(() => useMatch(matchId), { wrapper })

  const p1 = fireScoreSave(queryClient, matchId, 1, {
    side_1_points: 11,
    side_2_points: 5,
  })
  const p2 = fireScoreSave(queryClient, matchId, 2, {
    side_1_points: 5,
    side_2_points: 11,
  })

  // Save 1 settles: its onSuccess upserts game 1 and invalidates → GET#1 starts.
  await p1
  await get1Entered.promise // GET#1 is now in flight (held on get1Body).

  // Let save 2 commit: its onSuccess upserts game 2 and invalidates → this
  // cancels the in-flight GET#1 (cancelRefetch: true) and starts GET#2.
  save2Gate.resolve()
  await p2
  await get2Entered.promise // GET#2 is now in flight (held on get2Body).

  // Grab GET#2's fetch promise, resolve it FRESH, and wait for it to land.
  const query = queryClient
    .getQueryCache()
    .find({ queryKey: matchQueryKey(matchId) })!
  const freshSettled = query.promise
  get2Body.resolve(freshSnapshot)
  await freshSettled

  // Only now release the STALE GET#1 — into the already-cancelled fetch. If
  // cancelRefetch did NOT discard it, this is where game 2 would be dropped.
  get1Body.resolve(staleSnapshot)
  await Promise.resolve()
  await Promise.resolve()

  // Both refetches fired — the race was real, not skipped (a zero-refetch run
  // would leave game 2 in the cache from the mutation upsert alone and prove
  // nothing).
  expect(getCount).toBe(2)

  const cached = queryClient.getQueryData<MatchDetails>(matchQueryKey(matchId))
  const g2 = cached?.games.find((g) => g.game_number === 2)
  expect(g2).toBeDefined()
  expect(g2?.score?.side_2_points).toBe(11)
  // games_won is 1-1 only in the fresh snapshot; the narrow upsert never writes
  // it (seed was 0-0). Reading 1-1 proves the fresh *refetch* was the final
  // writer and the stale one was discarded — the residual is self-healing here.
  expect(cached?.sides.find((s) => s.side_number === 1)?.games_won).toBe(1)
  expect(cached?.sides.find((s) => s.side_number === 2)?.games_won).toBe(1)
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
