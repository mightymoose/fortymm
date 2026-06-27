import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { ApiError, api, conflictDetail, resolveBaseUrl, unwrap } from './client'
import { DASHBOARD_QUERY_KEY } from './dashboard'
import {
  matchDetailsQueryKey,
  matchDetailsResultFromPayload,
} from '@/components/matches/match-details/match-details-query'
import type { components } from './schema'

export type Player = components['schemas']['PlayerRead']
export type MatchCreate = components['schemas']['MatchCreate']
// Two backend classes are named `MatchDetails` (the page BFF response and the
// new `data` view model), so openapi-typescript namespaces both by module path.
export type MatchDetails =
  components['schemas']['app__schemas__match__MatchDetails']
export type MatchDetailsView =
  components['schemas']['app__schemas__view__match_details__MatchDetails']
export type ScoreboardStatus = components['schemas']['Status']
export type MatchListResponse = components['schemas']['MatchListResponse']
export type MatchListRow = components['schemas']['MatchListRow']
export type MatchGameScoreWrite = components['schemas']['MatchGameScoreWrite']
export type MatchGameScoreUpdate =
  components['schemas']['MatchGameScoreUpdate']
export type MatchResultsWrite = components['schemas']['MatchResultsWrite']
export type MatchResultsGameWrite = components['schemas']['MatchResultsGameWrite']
export type MatchStatus = components['schemas']['MatchStatus']
// The `/matches` list filter bucket. A superset of `MatchStatus`: it splits
// `in_progress` into `in_progress` (true-live, no posted result) and
// `awaiting_confirmation` (posted result, ≥1 signature) so the Live filter
// can't silently fold in awaiting-confirmation rows (issue #381).
export type MatchListFilter = components['schemas']['MatchListFilter']
export type Scoreboard = components['schemas']['Scoreboard']

export type MatchListParams = {
  status?: MatchListFilter
  /** When true, request the current user's attention-ranked open matches; the
   * server ignores `status` in this mode. */
  attention?: boolean
  q?: string
  page: number
  page_size: number
}

export const RECENT_OPPONENTS_QUERY_KEY = ['players', 'recent'] as const

/** Query key for a player search; the term is part of the key so each query is
 * cached independently and `enabled` can gate the empty-term case. */
export function playerSearchQueryKey(term: string) {
  return ['players', 'search', term] as const
}

/** Query key for the paginated /matches list. The whole params bag is the
 * key so two different filters keep separate cache slots. */
export function matchListQueryKey(params: MatchListParams) {
  return ['matches', 'list', params] as const
}

export function matchQueryKey(matchId: string) {
  return ['matches', 'detail', matchId] as const
}

/** Mutation-cache key for one game's scratch-pad score save. Keyed per game so
 * every scoreline cell can observe *its own* save straight from the shared
 * mutation cache (pending / error / success) and a retry just re-fires this
 * exact key — no separate failed-save store. Shares the match's query-key
 * prefix so all of a match's saves sweep together via
 * `matchScoreMutationPrefix`. */
export function scoreMutationKey(matchId: string, gameNumber: number) {
  return [...matchQueryKey(matchId), 'score', gameNumber] as const
}

/** Recover the game number from a `scoreMutationKey` tuple — it's the last
 * element. Reading the tail (rather than a fixed index) survives any change to
 * the match query-key prefix. Returns `null` for a non-score key. */
export function gameNumberFromScoreMutationKey(
  mutationKey: readonly unknown[] | undefined,
): number | null {
  const last = mutationKey?.[mutationKey.length - 1]
  return typeof last === 'number' ? last : null
}

/** Prefix matching every game's score-save mutation for a match. */
export function matchScoreMutationPrefix(matchId: string) {
  return [...matchQueryKey(matchId), 'score'] as const
}

/**
 * Opponents to feature in the new-match picker, most-recently-played first
 * (backfilled with other registered players by the API). Errors are thrown so
 * the surrounding error boundary can render a retry affordance.
 */
export function useRecentOpponents(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: RECENT_OPPONENTS_QUERY_KEY,
    queryFn: async (): Promise<Player[]> =>
      unwrap('load recent opponents', await api.GET('/v1/players/recent')),
    // Gate on the session so a first-visit direct-load doesn't fire before the
    // session cookie lands and 401 into the error boundary (#98).
    enabled: options.enabled ?? true,
    staleTime: 1000 * 60 * 5,
    // Fail fast to the error boundary's explicit "Try again" button rather
    // than silently retrying behind the skeleton.
    retry: false,
    throwOnError: true,
  })
}

/**
 * Server-side username search backing the opponent typeahead. The query is
 * disabled until `term` is non-empty, so an empty search box never hits the
 * network and the client never fetches the whole roster to filter locally.
 * Pass an already-trimmed, already-debounced term.
 */
export function usePlayerSearch(term: string) {
  return useQuery({
    queryKey: playerSearchQueryKey(term),
    queryFn: async (): Promise<Player[]> =>
      unwrap(
        'search players',
        await api.GET('/v1/players/search', {
          params: { query: { q: term } },
        }),
      ),
    enabled: term.length > 0,
    staleTime: 1000 * 60,
    // Keep the previous matches on screen while the next term loads, so the
    // dropdown doesn't flicker empty between keystrokes.
    placeholderData: (previous) => previous,
    // Fail fast to the error boundary's "Try again" rather than retrying.
    retry: false,
    throwOnError: true,
  })
}

/**
 * Creates a match. Callers await `mutateAsync` so they can surface the API's
 * 4xx `detail` inline on the form — no global error toast is attached here.
 */
export function useCreateMatch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: MatchCreate): Promise<MatchDetails> =>
      unwrap('create match', await api.POST('/v1/matches', { body: input })),
    // The create response already *is* the match-details payload, so seed the
    // details query cache from it. The match-details page then renders from this
    // warm entry — whether reached by an immediate redirect or later from the
    // scoring screen — instead of racing a `GET /v1/matches/{id}` against the
    // write we just committed: the read-after-write "We couldn't find that
    // match" dead-end behind #510.
    onSuccess: (created) => {
      queryClient.setQueryData(
        matchDetailsQueryKey(created.id),
        matchDetailsResultFromPayload(created),
      )
    },
  })
}

/** Query options for the paginated /matches list. Shared by `useMatchList` and
 * any caller that needs to prefetch the same query — the list route's loader
 * warms this on hover/touch preload so a click renders instantly. */
export function matchListQueryOptions(params: MatchListParams) {
  return queryOptions({
    queryKey: matchListQueryKey(params),
    queryFn: async (): Promise<MatchListResponse> =>
      unwrap(
        'load matches',
        await api.GET('/v1/matches', {
          params: {
            query: {
              status: params.status,
              attention: params.attention,
              q: params.q,
              page: params.page,
              page_size: params.page_size,
            },
          },
        }),
      ),
    retry: false,
    throwOnError: true,
  })
}

/**
 * Paginated /matches list. `placeholderData: keepPreviousData` keeps the
 * current page rendered while the next page or filter resolves, so the table
 * doesn't flash empty between requests. Throws to the surrounding boundary.
 */
export function useMatchList(
  params: MatchListParams,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    ...matchListQueryOptions(params),
    // Gate on the session so a first-visit direct-load doesn't fire before the
    // session cookie lands and 401 into the error boundary (#144).
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
  })
}

/**
 * URL of the CSV export for the current filters. The dedicated `/v1/matches.csv`
 * endpoint returns the whole filtered set as a `Content-Disposition: attachment`
 * download, so the UI can link straight to it — the browser downloads it
 * directly, with no client-side fetch/buffering.
 */
export function matchesCsvUrl(
  filters: Pick<MatchListParams, 'status' | 'q'>,
): string {
  const qs = new URLSearchParams()
  if (filters.status) qs.set('status', filters.status)
  if (filters.q) qs.set('q', filters.q)
  const query = qs.toString()
  return `${resolveBaseUrl()}/v1/matches.csv${query ? `?${query}` : ''}`
}

/** Query options for a single match's detail. Shared by `useMatch` and any
 * caller that needs to prefetch or read the same query (route loaders, etc.). */
export function matchQueryOptions(matchId: string) {
  return queryOptions({
    queryKey: matchQueryKey(matchId),
    queryFn: async (): Promise<MatchDetails> =>
      unwrap(
        'load match',
        await api.GET('/v1/matches/{match_id}', {
          params: { path: { match_id: matchId } },
        }),
      ),
    retry: false,
    throwOnError: true,
  })
}

/** Throws on failure so the surrounding boundary can render a retry. */
export function useMatch(matchId: string) {
  return useQuery(matchQueryOptions(matchId))
}

/** Return a copy of `match` with game `gameNumber`'s score replaced — used to
 * splice the committed score from a conflict 409 into the cache so the conflict
 * notice and a follow-up "Replace" read the up-to-date version immediately. */
function withGameScore(
  match: MatchDetails,
  gameNumber: number,
  score: MatchDetails['games'][number]['score'],
): MatchDetails {
  return {
    ...match,
    games: match.games.map((g) =>
      g.game_number === gameNumber ? { ...g, score } : g,
    ),
  }
}

/** Cache work shared by both score mutations: prime the detail cache from the
 * mutation response and invalidate the list / dashboard so they re-read the
 * derived status, scoreboard, and next-up state. */
function applyScoreMutationCache(
  queryClient: ReturnType<typeof useQueryClient>,
  matchId: string,
  data: MatchDetails,
) {
  queryClient.setQueryData<MatchDetails>(matchQueryKey(matchId), data)
  // The scoreboard reads a *different* cache key (`matchDetailsQuery`) off the
  // same endpoint, so priming `matchQueryKey` above doesn't refresh the hero.
  // Invalidate it so the scoreboard re-derives won/outcome — e.g. after a
  // confirmation flips `side.won` null→true (issue #485), the hero must change
  // from "leading" to "defeated" without a manual reload.
  queryClient.invalidateQueries({ queryKey: matchDetailsQueryKey(matchId) })
  queryClient.invalidateQueries({ queryKey: ['matches', 'list'] })
  queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY })
}

type QueryClientArg = ReturnType<typeof useQueryClient>

/**
 * Options for one game's scratch-pad score save, shared by the entry screen's
 * submit (`useSaveGameScore`) and the imperative retries fired from the
 * scoreline / banner (`fireScoreSave`). Whether to POST (create the game's
 * first score, lazily inserting the row) or PUT (replace an existing one) is
 * decided from the match cache at call time — so a retry after a failed create
 * still POSTs and a retry after a failed edit still PUTs.
 *
 * Fire-and-forget: per-game writes are scratchpad-only — the canonical commit
 * lives in `POST .../results`, which obliterates and replaces the saved
 * scores. We never throw, so a failure simply lives on the mutation in the
 * cache (status `error`, with the entered points in `variables`) as the
 * failed-save state each scoreline cell reads back. A generous `gcTime` keeps
 * that failed state around for the length of a scoring session rather than the
 * default 5 minutes.
 */
export function scoreSaveMutationOptions(
  queryClient: QueryClientArg,
  matchId: string,
  gameNumber: number,
) {
  return {
    mutationKey: scoreMutationKey(matchId, gameNumber),
    gcTime: 1000 * 60 * 30,
    // Fire even with no network connection. React Query's default
    // `networkMode: 'online'` *pauses* mutations while offline — the
    // mutationFn never runs and `onSettled` never fires, so an offline Save
    // tap would silently do nothing. We instead want it to run, fail fast on
    // the network error, and land in this game's failed-save state (the cell
    // flips to "Not saved", keeping the entered points to retry) — matching
    // the fire-and-forget posture where failures live on the mutation, not in
    // a paused limbo.
    networkMode: 'always' as const,
    mutationFn: async (input: MatchGameScoreWrite): Promise<MatchDetails> => {
      const cached = queryClient.getQueryData<MatchDetails>(
        matchQueryKey(matchId),
      )
      const existing = cached?.games.find(
        (g) => g.game_number === gameNumber,
      )?.score
      const path = { match_id: matchId, game_number: gameNumber }
      // Exactly one conditional write per save — no swallow-and-retry. Editing
      // an existing score asserts the version we last read: if a concurrent
      // participant saved this game since, the server 409s instead of letting
      // us clobber their result. We deliberately do NOT catch that 409 and
      // re-issue the other verb — that promotion was the last-write-wins
      // data-loss path. The rejection surfaces as a conflict the user must
      // resolve against fresh state (see `onError` re-sync + the conflict UI).
      if (existing) {
        return unwrap(
          'update score',
          await api.PUT('/v1/matches/{match_id}/games/{game_number}/scores', {
            params: { path },
            body: { ...input, expected_version: existing.version },
          }),
        )
      }
      // No score yet → create. The unique constraint asserts "no prior score",
      // so a concurrent create loses the race with a clean 409 (again surfaced,
      // never retried).
      return unwrap(
        'submit score',
        await api.POST(
          '/v1/matches/{match_id}/games/{game_number}/scores/new',
          { params: { path }, body: input },
        ),
      )
    },
    onSuccess: (data: MatchDetails) =>
      applyScoreMutationCache(queryClient, matchId, data),
    // Re-sync server truth whenever a save settles in error. A per-game write
    // can lose a server-side race to a concurrent conflicting write (e.g. the
    // opponent saved game 1 the other way first), so the server rejects ours
    // and the success path never primes the cache. Without this, the match
    // detail query keeps the stale games-won it last saw (the "Games won"
    // counter on the entry screen reads `mySide.games_won` from
    // `matchQueryKey`) until a manual reload (#564). Only invalidate the
    // server-canonical match queries to refetch the resolved truth —
    // deliberately *not* touching the mutation cache, so this game's
    // failed-save scratch state survives to drive the failure banner /
    // "Not saved" cell + retry UI.
    onError: (error: unknown) => {
      // On a conflict, the 409 body carries the committed score *and its new
      // version*. Patch it straight into the cache so the conflict notice shows
      // the right value and a subsequent "Replace with my score" PUTs the fresh
      // `expected_version` immediately — without racing the invalidate refetch
      // below (which only settles a network round-trip later).
      if (error instanceof ApiError) {
        const committed = conflictDetail(error)?.committed_score as
          | MatchDetails['games'][number]['score']
          | null
          | undefined
        if (committed) {
          queryClient.setQueryData<MatchDetails>(
            matchQueryKey(matchId),
            (prev) =>
              prev ? withGameScore(prev, gameNumber, committed) : prev,
          )
        }
      }
      queryClient.invalidateQueries({ queryKey: matchQueryKey(matchId) })
      queryClient.invalidateQueries({
        queryKey: matchDetailsQueryKey(matchId),
      })
    },
  }
}

/** Entry-screen submit hook for one game's score. The observer exposes
 * `isSuccess` / `isPending` for the screen's redirect-race guard; the write
 * itself lands in the shared mutation cache under `scoreMutationKey`, where the
 * scoreline cells and banner observe it. */
export function useSaveGameScore(matchId: string, gameNumber: number) {
  const queryClient = useQueryClient()
  return useMutation(scoreSaveMutationOptions(queryClient, matchId, gameNumber))
}

/**
 * Imperatively (re)fire a game's score save into the shared mutation cache.
 * Used by scoreline-cell and banner retries, which save games other than the
 * one whose entry screen is mounted, so they can't hold a `useSaveGameScore`
 * observer of their own. Resolves when the write settles; a rejection stays on
 * the mutation in the cache as the failed-save state (swallowed here so it
 * isn't an unhandled rejection).
 */
export function fireScoreSave(
  queryClient: QueryClientArg,
  matchId: string,
  gameNumber: number,
  input: MatchGameScoreWrite,
) {
  return queryClient
    .getMutationCache()
    .build(queryClient, scoreSaveMutationOptions(queryClient, matchId, gameNumber))
    .execute(input)
    .catch(() => undefined)
}

/** Drop a game's score-save mutations from the cache — call when the game is
 * cleared/deleted so a stale failed-save state doesn't outlive the score it
 * referred to. */
export function forgetScoreSaves(
  queryClient: QueryClientArg,
  matchId: string,
  gameNumber: number,
) {
  const cache = queryClient.getMutationCache()
  cache
    .findAll({ mutationKey: scoreMutationKey(matchId, gameNumber), exact: true })
    .forEach((mutation) => cache.remove(mutation))
}

/**
 * Game numbers the user has entered this session but the server hasn't
 * persisted — the latest scratch save for the game is still in flight
 * (`pending`) or failed (`error`). Offline, saves never reach `data.games`
 * (the writes fail), so this is the only record that a game was entered; the
 * scoring screen unions it into "which games are done" so forward navigation
 * doesn't bounce back to a game that only exists as a failed scratch save.
 *
 * Read imperatively off the live mutation cache (not a render snapshot) so a
 * save that settled a moment before the call is already reflected — the caller
 * computes the next route synchronously, right before firing the next save.
 */
export function recordedGameNumbers(
  queryClient: QueryClientArg,
  matchId: string,
): Set<number> {
  const mutations = queryClient
    .getMutationCache()
    .findAll({ mutationKey: matchScoreMutationPrefix(matchId) })
  // Latest save per game wins, so a successful re-save supersedes an older
  // failure (mirrors `useFailedGameSaves`).
  const latest = new Map<number, (typeof mutations)[number]>()
  for (const mutation of mutations) {
    const n = gameNumberFromScoreMutationKey(mutation.options.mutationKey)
    if (n == null) continue
    const prev = latest.get(n)
    if (!prev || mutation.state.submittedAt >= prev.state.submittedAt) {
      latest.set(n, mutation)
    }
  }
  const entered = new Set<number>()
  for (const [n, mutation] of latest) {
    const { status, variables } = mutation.state
    if ((status === 'pending' || status === 'error') && variables != null) {
      entered.add(n)
    }
  }
  return entered
}

/**
 * Clears the saved score for a game. Same scratchpad-write posture — failures
 * heal at finalize (the canonical /results POST is the source of truth).
 */
export function useDeleteScore(matchId: string, gameNumber: number) {
  const queryClient = useQueryClient()
  return useMutation({
    // Run offline too (see `scoreSaveMutationOptions`): the default
    // `networkMode: 'online'` would pause an offline clear, freezing the ✕
    // with nothing happening. Firing lets it fail like any other write.
    networkMode: 'always',
    mutationFn: async (): Promise<MatchDetails> =>
      unwrap(
        'clear score',
        await api.DELETE(
          '/v1/matches/{match_id}/games/{game_number}/scores',
          {
            params: {
              path: { match_id: matchId, game_number: gameNumber },
            },
          },
        ),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

/**
 * Same as `useDeleteScore` but the game number is supplied at mutate-call
 * time — used by the scoreline's per-cell ✕, which needs to clear any logged
 * game from a single hook (hooks rules forbid one per cell).
 */
export function useDeleteScoreForMatch(matchId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    // Fire offline too, same rationale as `useDeleteScore`.
    networkMode: 'always',
    mutationFn: async (gameNumber: number): Promise<MatchDetails> =>
      unwrap(
        'clear score',
        await api.DELETE(
          '/v1/matches/{match_id}/games/{game_number}/scores',
          {
            params: {
              path: { match_id: matchId, game_number: gameNumber },
            },
          },
        ),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

/**
 * Posts the result of a match. The payload is canon — the server obliterates
 * any scratchpad-saved games + scores, inserts these, validates the match as
 * a decided whole, and records the caller's signature. For a non-solo match
 * the status stays `in_progress` until the other side confirms via
 * `POST /confirmation`; ratings apply on that final signature, not here.
 * Solo matches finalize immediately (no second party to attest).
 *
 * Unlike the per-game writes, this one's errors matter: pass
 * `throwOnError`-style handling at the call site so the user can see what
 * went wrong (most often a 422 if local validation drifted out of sync, or a
 * 409 if a result has already been posted).
 */
export function useFinalizeMatch(matchId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    // Run offline so a paused mutation never freezes the submit button in its
    // "Posting result…" pending state. The entry screen avoids *calling* this
    // while offline (it stores the final game as a scratchpad save instead, so
    // the score survives until the user can post the result back online); this
    // also keeps the match-details finalize affordances from hanging offline.
    networkMode: 'always',
    mutationFn: async (input: MatchResultsWrite): Promise<MatchDetails> =>
      unwrap(
        'post match result',
        await api.POST('/v1/matches/{match_id}/results', {
          params: { path: { match_id: matchId } },
          body: input,
        }),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

/**
 * Confirms a posted result. Inserts the caller's signature; when every side
 * has at least one signing player the server flips status to `completed` and
 * applies the rating update — exactly once. Caller must be a participant who
 * hasn't already signed (the BFF's `can_confirm` flag is the source of truth
 * for whether the CTA is shown).
 */
export function useConfirmMatch(matchId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<MatchDetails> =>
      unwrap(
        'confirm match result',
        await api.POST('/v1/matches/{match_id}/confirmation', {
          params: { path: { match_id: matchId } },
        }),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

/**
 * Disputes a posted result. Clears every signature on the match and resets
 * `side.won` to `null`; the canonical games stay in place so the disputer
 * can navigate to the contested game and PUT a corrected score. Status
 * stays `in_progress`. Same `can_confirm` predicate gates this as
 * `useConfirmMatch`.
 */
export function useDisputeMatch(matchId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<MatchDetails> =>
      unwrap(
        'dispute match result',
        await api.POST('/v1/matches/{match_id}/dispute', {
          params: { path: { match_id: matchId } },
        }),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

/**
 * Withdraws a result the caller posted while it's still awaiting the other
 * side's sign-off — the submitter's escape hatch for a typo they spotted after
 * posting (they can't confirm or dispute their own result). Marks the pending
 * result `superseded` and reopens the match to a plain `Live` state so the
 * submitter can correct the wrong game and re-post. The BFF's `can_withdraw`
 * flag is the source of truth for whether the CTA is shown.
 */
export function useWithdrawMatch(matchId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<MatchDetails> =>
      unwrap(
        'withdraw match result',
        await api.POST('/v1/matches/{match_id}/withdrawal', {
          params: { path: { match_id: matchId } },
        }),
      ),
    onSuccess: (data) => applyScoreMutationCache(queryClient, matchId, data),
  })
}

// `as const` on `to` preserves the literal so TanStack Router's typed
// navigation can validate it against the route tree.

export function matchDetailRoute(matchId: string) {
  return {
    to: '/matches/$matchId' as const,
    params: { matchId },
  }
}

export function scoringNewRoute(matchId: string, gameNumber: number) {
  return {
    to: '/matches/$matchId/games/$gameNumber/scores/new' as const,
    params: { matchId, gameNumber: String(gameNumber) },
  }
}

export function scoringEditRoute(matchId: string, gameNumber: number) {
  return {
    to: '/matches/$matchId/games/$gameNumber/scores/edit' as const,
    params: { matchId, gameNumber: String(gameNumber) },
  }
}

/** Where to land after writing a per-game score — the next un-scored slot, or
 * the match detail page when there's no next game (match finalized, or every
 * game has a saved score). */
export function nextScoringDestination(
  match: Pick<MatchDetails, 'id' | 'current_game'>,
) {
  return match.current_game
    ? scoringNewRoute(match.id, match.current_game.game_number)
    : matchDetailRoute(match.id)
}
