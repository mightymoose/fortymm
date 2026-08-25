import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { Component, createElement, type ReactNode } from 'react'

import { server } from '@/mocks/server'
import { matchDetails, matchListResponse, matchListRow } from '@/test/factories'
import {
  type MatchDetails,
  type MatchListParams,
  fireScoreSave,
  matchListQueryKey,
  matchListQueryOptions,
  matchQueryKey,
  matchQueryOptions,
  scoreMutationKey,
  useCreateMatch,
  useDeleteScore,
  useMatch,
  useProposeResult,
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

  // Warm the cache with an observer-free empty snapshot. The scoring screen
  // always has a mounted `useMatch`, so the match cache is warm during play;
  // since #870 a cold cache is left unseeded (the wholesale `return data` seed
  // that would clobber a concurrent game is gone), so this composition test must
  // seed a present `prev` to exercise the narrow-upsert path it's about. It
  // stays observer-free so no refetch fires — the refetch-heal path is covered
  // separately (#843 refetch race).
  queryClient.setQueryData(matchQueryKey(matchId), matchDetails({ id: matchId, games: [] }))

  // Both fire against the (empty-`games`) cache; the row is absent so each takes
  // the POST (create) path.
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

  // Warm the cache (empty `games`) so both per-game writes take the
  // upsert-on-present path — since #870 a cold cache is left unseeded, so this
  // composition test seeds a present `prev` (matching the always-warm scoring
  // screen). Observer-free: no refetch fires here.
  queryClient.setQueryData(matchQueryKey(matchId), matchDetails({ id: matchId, games: [] }))

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
 * Regression for #870: the match query has the default 5-minute `gcTime` and is
 * dropped once it has no observer. If it's been garbage-collected and a per-game
 * save then settles, the write must NOT wholesale-seed the cold cache from its
 * own whole-match snapshot — that snapshot is built from the DB at *this* save's
 * commit time and can omit a concurrent cross-game save's row, reintroducing the
 * #843 clobber through a GC'd cache. The cold-cache branch leaves the entry
 * unseeded (a valid `MatchDetails` can't be reconstructed from a lone game row);
 * `invalidateMatchViews` runs after, and once an observer remounts its refetch
 * repopulates from a fresh GET. With no observer here, `invalidateQueries`
 * (default `refetchType: 'active'`) fires nothing, so the entry stays undefined.
 */
it('does not wholesale-seed a garbage-collected match cache from a stale save snapshot (#870)', async () => {
  const matchId = 'm-870'

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
  // This save's whole-match snapshot — as if built before a concurrent game 2
  // save committed, so it omits game 2. Seeding it wholesale would drop game 2.
  const saveResponse: MatchDetails = matchDetails({ id: matchId, games: [game1] })

  server.use(
    http.post('*/v1/matches/:matchId/games/:gameNumber/scores/new', () =>
      HttpResponse.json(saveResponse),
    ),
  )

  // Cold cache: no `matchQueryKey` entry (GC'd), and no observer — exactly the
  // #870 scenario. `getQueryData` is undefined before the save.
  expect(queryClient.getQueryData(matchQueryKey(matchId))).toBeUndefined()

  await fireScoreSave(queryClient, matchId, 1, {
    side_1_points: 11,
    side_2_points: 5,
  })

  // The stale whole-match snapshot was NOT installed — the cold cache stays
  // unseeded rather than clobbering with a snapshot that could omit a concurrent
  // game. It self-heals from a fresh GET once an observer remounts.
  expect(queryClient.getQueryData(matchQueryKey(matchId))).toBeUndefined()
})

/**
 * The complement of the #870 cold-cache case: when the match cache *is* present,
 * a per-game save still upserts just its own game row (composing with concurrent
 * cross-game writes) rather than replacing the whole snapshot. This is the path
 * the fix leaves untouched.
 */
it('upserts only the written game into a present match cache (#870 warm path)', async () => {
  const matchId = 'm-870-warm'

  const game1Present: Game = {
    id: 'g-1',
    game_number: 1,
    score: {
      id: 's-1',
      side_1_points: 11,
      side_2_points: 8,
      winner_side_number: 1,
      version: 1,
    },
  }
  const game2Existing: Game = {
    id: 'g-2',
    game_number: 2,
    score: {
      id: 's-2',
      side_1_points: 4,
      side_2_points: 11,
      winner_side_number: 2,
      version: 1,
    },
  }
  // Warm cache already holds game 2 (e.g. a concurrent save landed it).
  queryClient.setQueryData(
    matchQueryKey(matchId),
    matchDetails({ id: matchId, games: [game2Existing] }),
  )

  // Game 1's save response is a stale whole-match snapshot that omits game 2.
  const saveResponse: MatchDetails = matchDetails({
    id: matchId,
    games: [game1Present],
  })
  server.use(
    http.post('*/v1/matches/:matchId/games/:gameNumber/scores/new', () =>
      HttpResponse.json(saveResponse),
    ),
  )

  await fireScoreSave(queryClient, matchId, 1, {
    side_1_points: 11,
    side_2_points: 8,
  })

  // Only game 1 was upserted; game 2 survived (the write did not wholesale
  // replace with the snapshot that omits it).
  const cached = queryClient.getQueryData<MatchDetails>(matchQueryKey(matchId))
  expect(cached?.games.find((g) => g.game_number === 1)?.score?.side_1_points).toBe(11)
  expect(cached?.games.find((g) => g.game_number === 2)?.score?.side_2_points).toBe(11)
})

/**
 * Regression for #872: `applyGameWriteCache` folds a save's response into the
 * cache by upserting the row for the game it just wrote. That row is present
 * today by an API-side invariant nothing on the client enforces (a save always
 * returns the game's row; DELETE nulls the score but keeps the row). If the
 * response ever omits that row the upsert silently no-ops and the UI shows the
 * pre-write value until the refetch heals it, with nothing to point at. Make
 * the boundary violation loud: `console.error` at its source. We still leave
 * the cache untouched (no throw) so a live scoring screen survives the glitch.
 */
it('logs loudly and leaves the cache untouched when the save response omits the written game (#872)', async () => {
  const matchId = 'm-872'
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

  const game1Present: Game = {
    id: 'g-1',
    game_number: 1,
    score: {
      id: 's-1',
      side_1_points: 11,
      side_2_points: 8,
      winner_side_number: 1,
      version: 1,
    },
  }
  // Warm cache holds game 1's pre-write value.
  queryClient.setQueryData(
    matchQueryKey(matchId),
    matchDetails({ id: matchId, games: [game1Present] }),
  )

  // Boundary violation: the save's response omits the row for game 1 entirely.
  // Game 1 already has a cached score, so this save takes the edit (PUT) path.
  const saveResponse: MatchDetails = matchDetails({ id: matchId, games: [] })
  server.use(
    http.put('*/v1/matches/:matchId/games/:gameNumber/scores', () =>
      HttpResponse.json(saveResponse),
    ),
  )

  await fireScoreSave(queryClient, matchId, 1, {
    side_1_points: 11,
    side_2_points: 8,
  })

  // Loud: the invariant violation surfaced at its source.
  expect(consoleError).toHaveBeenCalledTimes(1)
  expect(consoleError.mock.calls[0][0]).toContain('applyGameWriteCache')
  // Safe: the cache was left as-is (not clobbered), so the refetch can heal it.
  const cached = queryClient.getQueryData<MatchDetails>(matchQueryKey(matchId))
  expect(cached?.games.find((g) => g.game_number === 1)?.score?.side_1_points).toBe(11)
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

/** Catches whatever `useMatch` throws during render so a test can assert on the
 * boundary instead of an uncaught render throw. */
class RenderBoundary extends Component<
  { children: ReactNode },
  { caught: boolean }
> {
  state = { caught: false }
  static getDerivedStateFromError() {
    return { caught: true }
  }
  render() {
    return this.state.caught
      ? createElement('div', null, 'BOUNDARY')
      : this.props.children
  }
}

/** Reads exactly what `score-entry.tsx` reads off `useMatch` (`data`,
 * `isLoading`) so the throw-vs-keep behaviour under test is the one the real
 * scoring screen sees. */
function MatchView({ matchId }: { matchId: string }) {
  const { data } = useMatch(matchId)
  return createElement('div', null, data ? `games:${data.games.length}` : 'PENDING')
}

const matchTree = (matchId: string) =>
  createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(RenderBoundary, null, createElement(MatchView, { matchId })),
  )

/**
 * Regression for the #843 success-path refetch: `applyGameWriteCache` now
 * invalidates `matchQueryKey`, so a *successful* per-game save triggers a
 * background `GET /v1/matches/{id}` refetch of `useMatch`. `throwOnError` is
 * re-evaluated on every render of the scoring screen (the save mutation's own
 * state settling re-renders it), so if that background refetch fails, a plain
 * `throwOnError: true` would throw the user out of a mid-match screen right
 * after a save that actually succeeded. It must only throw when there's no data
 * to fall back on — the last-good board stays and the next good refetch heals it.
 */
it('keeps last-good data on screen when a background refetch fails (#843)', async () => {
  const matchId = 'm-bg-refetch'
  const seeded: MatchDetails = matchDetails({
    id: matchId,
    games: [{ id: 'g-1', game_number: 1, score: null }],
  })
  // staleTime: Infinity + data present → the mount fires no fetch, so the only
  // refetch is the explicit invalidate below.
  queryClient.setQueryData(matchQueryKey(matchId), seeded)

  const { rerender } = render(matchTree(matchId))
  // The seeded data renders — no boundary, no pending.
  expect(screen.getByText('games:1')).toBeTruthy()

  server.use(
    http.get('*/v1/matches/:matchId', () =>
      HttpResponse.json({ detail: 'boom' }, { status: 500 }),
    ),
  )

  // A background refetch (exactly what `invalidateMatchViews` fires) that fails.
  await act(async () => {
    await queryClient
      .invalidateQueries({ queryKey: matchQueryKey(matchId) })
      .catch(() => undefined)
  })
  // The errored refetch leaves `data`/`isLoading` unchanged, so it alone doesn't
  // re-render this observer — but the scoring screen re-renders for other
  // reasons after a save. Force that next render: it re-evaluates `throwOnError`
  // against the now-errored query, which is where a bare `true` throws.
  rerender(matchTree(matchId))

  // The background error did NOT nuke the screen: last-good data still readable.
  expect(screen.queryByText('BOUNDARY')).toBeNull()
  expect(screen.getByText('games:1')).toBeTruthy()
  expect(
    queryClient.getQueryData<MatchDetails>(matchQueryKey(matchId))?.games,
  ).toHaveLength(1)
})

/**
 * The other half of the distinction: an *initial* load with no cached data to
 * fall back on must still throw so the surrounding boundary can render a retry.
 */
it('throws to the boundary when the initial match load fails', async () => {
  const matchId = 'm-initial-fail'
  server.use(
    http.get('*/v1/matches/:matchId', () =>
      HttpResponse.json({ detail: 'boom' }, { status: 500 }),
    ),
  )

  render(matchTree(matchId))

  await waitFor(() => expect(screen.getByText('BOUNDARY')).toBeTruthy())
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

describe('matchListQueryOptions', () => {
  /** Reads exactly what the matches list route reads off `useMatchList`
   * (`data`), wrapped in a `RenderBoundary` so the throw-vs-keep behavior
   * under test is the one the real list page sees. */
  function MatchListView({ params }: { params: MatchListParams }) {
    const { data } = useQuery(matchListQueryOptions(params))
    return createElement(
      'div',
      null,
      data ? `total:${data.total}` : 'PENDING',
    )
  }

  const listTree = (params: MatchListParams) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RenderBoundary, null, createElement(MatchListView, { params })),
    )

  const params: MatchListParams = { page: 1, page_size: 20 }

  /**
   * Regression (#1468 — mirrors #843's fix in `matchQueryOptions`): a
   * background refetch of an already-rendered matches list must not throw the
   * page out to the route error boundary.
   */
  it('keeps last-good data on screen when a background refetch fails (#1468)', async () => {
    const seeded = matchListResponse({
      items: [matchListRow()],
      total: 1,
    })
    queryClient.setQueryData(matchListQueryKey(params), seeded)

    const { rerender } = render(listTree(params))
    expect(screen.getByText('total:1')).toBeTruthy()

    server.use(
      http.get('*/v1/matches', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    await act(async () => {
      await queryClient
        .invalidateQueries({ queryKey: matchListQueryKey(params) })
        .catch(() => undefined)
    })
    // The errored refetch alone doesn't re-render this observer (data is
    // unchanged) — force the next render, where a bare `true` would throw.
    rerender(listTree(params))

    expect(screen.queryByText('BOUNDARY')).toBeNull()
    expect(screen.getByText('total:1')).toBeTruthy()
  })

  /** The other half: an initial load with no cached data to fall back on must
   * still throw so the surrounding boundary can render a retry. */
  it('throws to the boundary when the initial list load fails', async () => {
    server.use(
      http.get('*/v1/matches', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    render(listTree(params))

    await waitFor(() => expect(screen.getByText('BOUNDARY')).toBeTruthy())
  })
})

describe('useProposeResult', () => {
  // #801: the NEGOTIATION-conflict 409 (`_negotiation_conflict`, "a result
  // already exists") means the opponent already posted the standing result. The
  // mutation must refetch the observed match so score-entry's
  // `standing_result`/`completed` early-return can route the poster to match
  // detail — the minimal Option A that replaces the #800 reconcile interstitial
  // ADR-0005 deleted. The server's body for THIS 409 is the viewer-relative
  // negotiation OBJECT (has `viewer_state`); the lock-race/terminal 409s carry a
  // plain-STRING detail and must NOT trigger the refetch (they may not have
  // committed yet, so a refetch could strand the screen with no standing result).
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)

  // The `_negotiation_conflict` 409 body: `detail` is the negotiation object.
  const negotiationConflict = {
    detail: {
      viewer_state: 'review',
      your_turn: true,
      standing_result: {
        id: 'r-opp',
        games: [{ game_number: 1, side_1_points: 4, side_2_points: 11 }],
        submitted_by: 'u-opp',
        submitted_at: '2026-05-12T19:30:00Z',
      },
      prior_result: null,
      diff: null,
    },
  }

  it('refetches the observed match on a negotiation-conflict 409', async () => {
    const matchId = 'm-801'
    server.use(
      http.post('*/v1/matches/:matchId/results', () =>
        HttpResponse.json(negotiationConflict, { status: 409 }),
      ),
    )
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useProposeResult(matchId), { wrapper })
    result.current.mutate({ games: [] })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: matchQueryKey(matchId),
    })
  })

  it('does NOT refetch on a plain-string lock-race 409, so score-entry keeps it retryable', async () => {
    const matchId = 'm-801-lock'
    server.use(
      http.post('*/v1/matches/:matchId/results', () =>
        HttpResponse.json(
          {
            detail:
              'A result is already being posted for this match. Refresh to see the latest.',
          },
          { status: 409 },
        ),
      ),
    )
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useProposeResult(matchId), { wrapper })
    result.current.mutate({ games: [] })

    await waitFor(() => expect(result.current.isError).toBe(true))

    // A string-bodied 409 (lock race / terminal) is NOT a negotiation conflict —
    // no refetch, so score-entry surfaces it as a normal retryable error.
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: matchQueryKey(matchId),
    })
  })

  it('does NOT refetch on a non-409 finalize error, so score-entry can surface it for retry', async () => {
    const matchId = 'm-801b'
    server.use(
      http.post('*/v1/matches/:matchId/results', () =>
        HttpResponse.json(
          { detail: 'This payload was rejected by the server.' },
          { status: 422 },
        ),
      ),
    )
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useProposeResult(matchId), { wrapper })
    result.current.mutate({ games: [] })

    await waitFor(() => expect(result.current.isError).toBe(true))

    // A 422 (or 500 / transport drop) stays put on the score-entry screen for
    // the user to fix and retry — no refetch, so nothing navigates them away.
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: matchQueryKey(matchId),
    })
  })
})
