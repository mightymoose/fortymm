import type { QueryClient } from '@tanstack/react-query'
import { createFileRoute, notFound, redirect } from '@tanstack/react-router'
import type { ApiClient } from '../../../../../../../api/client'
import { ApiError, ApiUnreachable } from '../../../../../../../api/errors'
import { matchQuery, sessionQuery } from '../../../../../../../api/queries'
import { ScoreGame, type ScoreGameData } from '../../../../../../../pages/scoring/ScoreGame'
import { ScoresFailed, ScoresLoading } from '../../../../../../../pages/scoring/ScoresLoading'
import { keepScoreTarget } from '../../../../../../../scoring/keepScore'
import { carriedMatch, matchOf } from '../../../../../../../scoring/matches'
import { draftHash, gamesOf, nowSeconds, readFragment } from '../../../../../../../scoring/fragment'

const PATH = '/matches/$matchId/scores/game/$gameNumber/edit'

// The fragment is the match's scores. Online, a fragment the route can't
// read for an API match is rebuilt from the API's match, as Keep score on
// the match page builds it. A demo match's, or with no network one that
// still carries the match's details, starts empty instead, with a note in
// the history state for the page. With no network and no details, the
// page says to open the match with signal. A game can't open before the
// one ahead of it, so a later or invalid game number goes to the first
// game with no score. The page works out the players from the session
// itself, because a saved account can stand in for the session until the
// API answers with another player.
export const Route = createFileRoute('/_authenticated/matches/$matchId/scores/game/$gameNumber/edit')({
  // A save changes only the hash, which keeps the same match, so the loader
  // must run again, and before the page renders.
  shouldReload: true,
  loader: {
    staleReloadMode: 'blocking',
    handler: async ({ context: { api, queryClient }, params, location }): Promise<ScoreGameData> => {
      const account = await queryClient.ensureQueryData(sessionQuery(api))
      const scoring = carriedMatch(params.matchId, location.hash)
      const match = scoring && matchOf(scoring, { id: account.player.id, name: account.player.display_name }, null)
      const fragment = match && readFragment(location.hash, match)
      if (!scoring || !match || !fragment) {
        if (scoring?.kind !== 'demo') await rebuildFromApi(api, queryClient, params.matchId)
        if (!match) return { kind: 'unreachable' }
        throw redirect({
          to: PATH,
          params: { matchId: params.matchId, gameNumber: '1' },
          search: true,
          // An API match's details stay, because nothing else knows them.
          hash: draftHash(match, [], null, nowSeconds()),
          state: { discardedScores: true },
          replace: true,
        })
      }
      const last = Math.min(gamesOf(fragment).length + 1, match.bestOf)
      const gameNumber = Number(params.gameNumber)
      if (!/^[1-9][0-9]*$/.test(params.gameNumber) || gameNumber > last) {
        throw redirect({
          to: PATH,
          params: { matchId: params.matchId, gameNumber: String(last) },
          search: true,
          hash: location.hash,
          replace: true,
        })
      }
      return { kind: 'scores', scoring, fragment, gameNumber, last }
    },
  },
  component: ScoreGame,
  pendingComponent: ScoresLoading,
  errorComponent: ScoresFailed,
})

// How long the page waits for the API's match before it treats the hall
// as having no signal. Hall Wi-Fi can report online and answer nothing.
const REBUILD_AFTER_MS = 8000

// Online, redirects to the API's match as Keep score opens it, or to the
// match's page once it is final, as #316 owns editing after that. Returns
// only with no network, or with no answer in REBUILD_AFTER_MS.
async function rebuildFromApi(api: ApiClient, queryClient: QueryClient, matchId: string): Promise<void> {
  if (!navigator.onLine) return
  const query = matchQuery(api, matchId)
  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<'slow'>((resolve) => {
    timer = setTimeout(() => resolve('slow'), REBUILD_AFTER_MS)
  })
  let found
  try {
    found = await Promise.race([
      queryClient.fetchQuery({
        ...query,
        // The page waits on this, so a failure shows at once, with Try again.
        // No response is a hall with no signal, which a retry won't fix.
        retry: false,
      }),
      slow,
    ])
  } catch (error) {
    if (error instanceof ApiUnreachable) return
    // An account that can score but not view the match can't see it.
    if (error instanceof ApiError && error.status === 403) throw notFound()
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (found === 'slow') {
    void queryClient.cancelQueries({ queryKey: query.queryKey })
    return
  }
  if (!found) throw notFound()
  const target = keepScoreTarget(found, nowSeconds())
  if (!target) throw redirect({ to: '/matches/$matchId', params: { matchId }, replace: true })
  throw redirect({
    to: PATH,
    params: { matchId, gameNumber: target.gameNumber },
    search: true,
    hash: target.hash,
    replace: true,
  })
}
